// Interval agreement layer — implements CONSENSUS.md v1.0.
//
//   signed actions → proposer bundle → deterministic execution
//     → witness attestations → quorum certificate → portable finality
//
// Safety core (CONSENSUS.md §4): each witness signs AT MOST ONE bundle
// hash per tick, ever — across all rounds — and that vote lock is written
// durably to disk BEFORE the attestation leaves the machine. With the
// constitutional quorum rule 2q > n, two conflicting certificates would
// need a witness to violate its lock: crashes, restarts, partitions,
// delays and reordering cannot fork the world.
//
// Liveness is the deliberate sacrifice: locks are never released. A
// multi-round partition can split locks so no bundle reaches quorum
// (CONSENSUS.md §8, H2) — the world stalls, evidence intact, and humans
// refound. A stopped world, never two worlds.

import E from './engine.js'
import * as P from './protocol.mjs'
import { IntervalError, throwCoded, ERR, HALT, DEFAULT_STARTUP_VERIFY_RECENT_N } from './errors.mjs'

// Durable safety records are VERSIONED and schema-checked (rev4 brief §6):
// an unversioned or malformed record refuses startup rather than being
// guessed at. Field types and hash formats are exact.
export const LOCK_FORMAT = 'interval-witness-lock-v1'
export const FRONTIER_FORMAT = 'interval-witness-frontier-v1'

// An in-memory finality index for TESTING configurations only. It enforces
// the SAME per-(worldId, tick) immutability invariant as the durable store
// (final pre-freeze §2): first append wins, an identical append returns the
// existing entry, a conflicting append throws. It just does not survive a
// crash — which is why it is gated behind allowEphemeralStores.
export function ephemeralFinalityIndex(mem = new Map()) {
  return {
    ephemeral: true,
    get: (tick) => mem.get(tick) ?? null,
    append: (record) => {
      const existing = mem.get(record.tick)
      if (existing) {
        if (existing.bundleHash !== record.bundleHash || existing.resultingStateHash !== record.resultingStateHash) {
          const e = new Error(`ephemeral finality index: conflicting append for tick ${record.tick}`)
          e.conflict = { indexed: existing, committing: record }
          throw e
        }
        return existing // idempotent
      }
      const entry = { tick: record.tick, bundleHash: record.bundleHash, resultingStateHash: record.resultingStateHash, cert: record }
      mem.set(record.tick, entry)
      return entry
    },
    latestTick: () => (mem.size ? Math.max(...mem.keys()) : -1),
    validate: () => null,
  }
}
const HEX64 = /^[0-9a-f]{64}$/

export function validateFrontierRecord(f) {
  if (!f || typeof f !== 'object') return 'not an object'
  if (f.format !== FRONTIER_FORMAT) return `unknown format ${JSON.stringify(f.format)} (expected ${FRONTIER_FORMAT})`
  if (typeof f.worldId !== 'string' || !HEX64.test(f.worldId)) return 'malformed worldId'
  if (!Number.isInteger(f.tick) || f.tick < 0) return 'malformed tick'
  if (typeof f.resultingStateHash !== 'string' || !HEX64.test(f.resultingStateHash)) return 'malformed resultingStateHash'
  return null
}

export function validateLockRecord(l) {
  if (!l || typeof l !== 'object') return 'not an object'
  if (l.format !== LOCK_FORMAT) return `unknown format ${JSON.stringify(l.format)} (expected ${LOCK_FORMAT})`
  if (typeof l.worldId !== 'string' || !HEX64.test(l.worldId)) return 'malformed worldId'
  if (!Number.isInteger(l.tick) || l.tick < 0) return 'malformed tick'
  if (typeof l.bundleHash !== 'string' || !HEX64.test(l.bundleHash)) return 'malformed bundleHash'
  if (!l.bundle || typeof l.bundle !== 'object') return 'missing bundle'
  if (!l.attestation || typeof l.attestation !== 'object') return 'missing attestation'
  return null
}

export class IntervalAgreement {
  /**
   * @param opts.genesis      genesis with .witnesses (pubkey hex[]) and .quorum (2q>n)
   * @param opts.worldId      full world id
   * @param opts.witnessKey   {playerId, privateKey} if this node is a witness, else null
   * @param opts.lockStore    { save(lock), load() } durable vote-lock storage
   *                          (REQUIRED for real witnesses; tests may inject memory)
   * @param opts.getState     () => current finalized state
   * @param opts.setState     (next) => adopt newly finalized state
   * @param opts.publish      (kind: 'bundle'|'attestation'|'finality', obj) => void
   * @param opts.onFinalized  (record, newState) => void
   * @param opts.now          clock, injectable for tests (default Date.now)
   * @param opts.log          (line) => void
   */
  constructor(opts) {
    this.genesis = opts.genesis
    this.worldId = opts.worldId
    this.witnessKey = opts.witnessKey ?? null
    this.getState = opts.getState
    this.setState = opts.setState
    this.publish = opts.publish
    this.onFinalized = opts.onFinalized ?? (() => {})
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.name = opts.name ?? 'node'

    // CONSENSUS.md §1: constitutional checks — refuse to operate otherwise
    if (!Array.isArray(this.genesis.witnesses) || this.genesis.witnesses.length === 0)
      throw new Error('agreement requires genesis.witnesses')
    if (!P.quorumSafe(this.genesis))
      throw new Error('Byzantine-unsafe quorum: constitution requires n>=3f+1, q>=2f+1, 2q-n>f (got n=' + this.genesis.witnesses.length + ', q=' + this.genesis.quorum + ', f=' + this.genesis.byzantineTolerance + ')')
    if (this.witnessKey && !this.genesis.witnesses.includes(this.witnessKey.playerId))
      throw new Error('witness key is not in the genesis witness set')

    this.halted = false
    this.haltReason = null
    this.prevHash = E.stateHash(this.getState())

    this.pending = new Map()        // tick -> Map(playerId -> Map(inputHash -> input))
    this.proposals = new Map()      // bundleHash -> { bundle, next, rsh } (current tick)
    this.atts = new Map()           // bundleHash -> Map(witness -> attestation)
    this.proposedRounds = new Set() // rounds I proposed or ceded (current tick)
    this.seenProposals = new Map()  // `${round}|${proposer}` -> bundle (equivocation tracking)
    this.poisonedProposers = new Set() // proposers with equivocation evidence THIS tick

    // evidence lockers (bounded): portable proof of misbehavior
    this.inputEquivocations = []
    this.proposerEquivocations = []

    this.finalizedLog = new Map()   // tick -> FinalityRecord (bounded)
    this.latestRecord = null
    this._timer = null
    this._lastRebroadcast = -Infinity

    // ---- the vote lock (CONSENSUS.md §4) ----
    // lock = { worldId, tick, bundleHash, bundle, attestation } | null
    this.lockStore = opts.lockStore ?? null
    this.lock = null
    if (this.witnessKey) {
      if (!this.lockStore || !opts.frontierStore || !opts.finalityIndexStore) {
        // A production witness REQUIRES all THREE durable safety records:
        // the vote lock (rev4 §3), the finality frontier, and the finality
        // index (final pre-freeze §1 — historical accountability is a safety
        // record, so it is mandatory, not optional). In-memory stores exist
        // only behind an explicit testing flag, so "forgot a store" cannot
        // silently become "double-signed after a crash" or "lost the history
        // needed to detect a future conflicting certificate".
        if (!opts.allowEphemeralStores)
          throwCoded(ERR.MISSING_STORES, 'a witness requires durable lockStore, frontierStore, AND finalityIndexStore (pass lockFile/safetyDir, or set allowEphemeralStores: true for TESTS ONLY)')
        if (!this.lockStore) {
          let mem = null
          this.lockStore = { save: (l) => { mem = l }, load: () => mem, ephemeral: true }
        }
        if (!opts.frontierStore) {
          let fmem = null
          opts = { ...opts, frontierStore: { save: (f) => { fmem = f }, load: () => fmem, ephemeral: true } }
        }
        if (!opts.finalityIndexStore) {
          // ephemeral in-memory index: enforces the same per-(worldId,tick)
          // immutability as the durable store, but does not survive a crash
          const mem = new Map()
          opts = { ...opts, finalityIndexStore: ephemeralFinalityIndex(mem), _ephemeralIndex: true }
        }
        this.log('WARNING: EPHEMERAL safety stores (testing flag) — a crash can double-sign or lose history; never run a real witness like this')
      }
      // a throwing load (corrupt/unreadable record) propagates: startup is
      // REFUSED, the file is preserved, the operator decides (rev4 §1/§2)
      const saved = this.lockStore.load()
      if (saved !== null) {
        const verr = validateLockRecord(saved)
        if (verr) throwCoded(ERR.CORRUPT_LOCK, `stored vote lock is malformed (${verr}) — refusing startup; preserve and inspect the lock file`)
        // rev5 §1: a safety record for ANOTHER world at our location is
        // evidence of path reuse or tampering — refuse, never ignore
        if (saved.worldId !== this.worldId)
          throwCoded(ERR.WORLD_MISMATCH, `stored vote lock belongs to a different world (${saved.worldId.slice(0, 12)}… ≠ ${this.worldId.slice(0, 12)}…) — refusing startup; move or remove the record explicitly`)
      }
      // LOCK-3: a lock at the current frontier binds us; older ones are
      // stale. But a restored lock is UNTRUSTED BYTES until fully verified
      // (final-fixes brief §2): a corrupted or hand-edited lock file must
      // not be able to poison the witness into rebroadcasting garbage —
      // and it must not be silently discarded either, because discarding
      // a real lock re-opens double-signing. Invalid ⇒ refuse to start.
      if (saved && saved.worldId === this.worldId && saved.tick === this.getState().tick) {
        const err = this.validateStoredLock(saved)
        if (err) throw new Error(`stored vote lock at ${'tick ' + saved.tick} is invalid (${err}) — refusing to start; inspect or remove the lock file manually`)
        this.lock = saved
        this.acceptAttestation(saved.attestation) // our vote counts toward quorum on this side of the restart too
        this.log(`restored vote lock for tick ${saved.tick} (${saved.bundleHash.slice(0, 8)}…): verified, will only rebroadcast, never re-vote`)
      }
    }

    // ---- rollback frontier (final-fixes brief §3) ----
    // The lock protects the CURRENT tick; the frontier protects HISTORY.
    // A node restarted from an old checkpoint would happily re-run — and a
    // witness would re-SIGN — ticks the world already finalized. The
    // frontier file records the highest finalized tick; a state behind it
    // refuses to start.
    this.frontierStore = opts.frontierStore ?? null
    // append-only durable finality index (final pre-freeze brief §2): a
    // forensic record that outlives the bounded in-memory finalizedLog, so
    // conflicting historical certificates are detectable after any retention
    // window and across restarts.
    this.finalityIndex = opts.finalityIndexStore ?? null
    // §3: validate the accountability store at startup. A corrupt index —
    // an unparseable entry, a non-canonical hash, a certificate that does
    // not verify, or two conflicting entries for one tick — is refused,
    // exactly like a corrupt lock or frontier. Accountability history is a
    // safety record; we do not start blind to its corruption.
    if (this.finalityIndex?.validate) {
      // §3: structural + hash checks run on EVERY retained record (cheap and
      // immutable), while full signature/quorum re-verification can be BOUNDED
      // to the recent tail via startupVerifyRecentN — older records were
      // verified when first accepted and cannot change under the append-only
      // immutability invariant. Default (Infinity) re-verifies everything.
      const ierr = this.finalityIndex.validate({
        worldId: this.worldId,
        verifyCert: (cert) => P.verifyFinalityProof(this.genesis, this.worldId, cert),
        verifyRecentN: opts.startupVerifyRecentN ?? DEFAULT_STARTUP_VERIFY_RECENT_N,
      })
      if (ierr) throwCoded(ERR.CORRUPT_FINALITY_INDEX, `finality index is corrupt (${ierr}) — refusing startup; preserve and inspect the accountability store`)
    }
    if (this.frontierStore) {
      const f = this.frontierStore.load() // throwing load = refused startup
      if (f !== null) {
        const ferr = validateFrontierRecord(f)
        if (ferr) throwCoded(ERR.CORRUPT_FRONTIER, `stored frontier is malformed (${ferr}) — refusing to start; preserve and inspect the frontier file`)
        if (f.worldId !== this.worldId)
          throwCoded(ERR.WORLD_MISMATCH, `stored frontier belongs to a different world (${f.worldId.slice(0, 12)}… ≠ ${this.worldId.slice(0, 12)}…) — refusing startup; move or remove the record explicitly`)
      }
      if (f) {
        if (this.getState().tick <= f.tick)
          throwCoded(ERR.FRONTIER_ROLLBACK, `checkpoint rollback refused: state is at tick ${this.getState().tick} but tick ${f.tick} was already finalized (${f.resultingStateHash.slice(0, 8)}…). Re-signing finalized history forks worlds. Sync a current checkpoint or restore the newer state.`)
        // brief §2: height alone is not identity. A state resuming AT the
        // frontier height must BE the finalized state, byte for byte — a
        // same-height impostor (restored from elsewhere, hand-edited) is
        // exactly what could split our future votes from our past ones.
        if (this.getState().tick === f.tick + 1 && this.prevHash !== f.resultingStateHash)
          throw new Error(`frontier mismatch: state at tick ${this.getState().tick} hashes ${this.prevHash.slice(0, 8)}… but the finalized frontier recorded ${f.resultingStateHash.slice(0, 8)}… — refusing to start from a same-height impostor state`)
        if (this.getState().tick > f.tick + 1) {
          // rev4 brief §9: "ahead of the frontier" is only legitimate via a
          // CERTIFIED recovery path. The caller must present the finality
          // proof for exactly this state; without it, refuse.
          const proof = opts.recoveryProof
          const perr = proof ? P.verifyFinalityProof(this.genesis, this.worldId, proof) : 'no recovery proof supplied'
          if (perr || proof.tick !== this.getState().tick - 1 || proof.resultingStateHash !== this.prevHash)
            throwCoded(ERR.FRONTIER_AHEAD_UNPROVEN, `state (tick ${this.getState().tick}) is ahead of the frontier (tick ${f.tick}) without a valid certified recovery path (${perr ?? 'proof does not certify this state'}) — sync a certified checkpoint or restore frontier-aligned state`)
          this.log(`state (tick ${this.getState().tick}) is ahead of the frontier (tick ${f.tick}): certified recovery proof verified; frontier resumes from here`)
        }
        this.frontier = f
      }
    }
  }

  // Full verification of a restored VoteLock against the current state:
  // structure, constitutional proposer, both signatures, field binding,
  // and a local REPLAY that must reproduce the attested result.
  validateStoredLock(saved) {
    if (!saved.bundle || typeof saved.bundle !== 'object') return 'no bundle'
    if (typeof saved.bundleHash !== 'string' || P.bundleHash(saved.bundle) !== saved.bundleHash) return 'bundle hash mismatch'
    const state = this.getState()
    const expected = P.proposerFor(this.genesis, this.worldId, this.prevHash, state.tick, saved.bundle.round)
    const berr = P.validateBundle(state, this.worldId, saved.bundle, expected)
    if (berr) return 'bundle invalid: ' + berr
    const a = saved.attestation
    if (!a || a.witness !== this.witnessKey.playerId) return 'attestation not ours'
    if (a.worldId !== this.worldId || a.tick !== state.tick || a.round !== saved.bundle.round) return 'attestation fields do not match'
    if (a.bundleHash !== saved.bundleHash) return 'attestation for a different bundle'
    if (!P.verifyAttestationSig(a)) return 'bad attestation signature'
    if (saved.bundle.previousStateHash !== this.prevHash) return 'lineage mismatch'
    const next = E.nextState(state, saved.bundle.inputs)
    if (E.stateHash(next) !== a.resultingStateHash) return 'replay does not reproduce the attested result'
    return null
  }

  // ---- schedule arithmetic (CONSENSUS.md §3) ----
  dueAt(tick) { return this.genesis.anchorMs + (tick + 1) * E.TICK_MS }
  scheduledTick() { return Math.max(0, Math.floor((this.now() - this.genesis.anchorMs) / E.TICK_MS)) }
  currentRound() {
    return P.roundAt(this.now() - this.dueAt(this.getState().tick))
  }
  roundOpen(round) {
    return this.now() >= this.dueAt(this.getState().tick)
      + P.roundStartMs(round) - P.AGREEMENT.MAX_SKEW_MS
  }

  // ---- the driver: paced by the clock, finalized only by quorum ----
  start(intervalMs = 100) {
    this._timer = setInterval(() => { try { this.drive() } catch (e) { this.log(`drive error: ${e.message}`) } }, intervalMs)
    if (this._timer.unref) this._timer.unref()
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null }

  drive() {
    if (this.halted) return
    const round = this.currentRound()
    if (round < 0) return
    const state = this.getState()
    if (this.witnessKey) {
      const lk = this.lock
      if (lk) {
        // locked: converge the network on OUR lock — rebroadcast bundle +
        // attestation; never author or sign anything else for this tick.
        // (captured locally: delivering the bundle can finalize the tick
        // and clear the lock re-entrantly)
        if (this.now() - this._lastRebroadcast >= P.AGREEMENT.ROUND_TIMEOUT_MS / 2) {
          this._lastRebroadcast = this.now()
          this.publish('bundle', lk.bundle)
          this.publish('attestation', lk.attestation)
        }
      } else {
        // unlocked: propose only for the CURRENT round (final-fixes brief
        // §6). A late-starting witness must never originate bundles for
        // rounds whose windows have passed — stale proposals compete with
        // whatever the live network already locked and widen lock splits.
        for (let r = 0; r < round; r++) this.proposedRounds.add(r) // ceded forever
        if (!this.proposedRounds.has(round)) {
          const prop = P.proposerFor(this.genesis, this.worldId, this.prevHash, state.tick, round)
          if (prop === this.witnessKey.playerId && !this.poisonedProposers.has(prop)) this.propose(round)
          else this.proposedRounds.add(round) // not ours (or poisoned): never revisit
        }
      }
    }
    for (const bh of this.proposals.keys()) this.tryFinalize(bh)
    for (const t of this.pending.keys()) if (t < state.tick) this.pending.delete(t)
  }

  // ---- input intake (CONSENSUS.md §2, §7) ----
  addInput(input) {
    if (this.halted) return false
    const state = this.getState()
    if (!input || input.worldId !== this.worldId) return false
    if (!Number.isInteger(input.tick) || input.tick < state.tick) return false
    if (input.tick > state.tick + P.AGREEMENT.MAX_PENDING_TICKS) return false
    if (typeof input.playerId !== 'string' || !/^[0-9a-f]{64}$/.test(input.playerId)) return false
    if (E.validateInputShape(input) !== null) return false // non-canonical forms never enter a proposal (rev7 §4)
    if (!E.verifyInputSig(input)) return false // garbage never enters a proposal
    if (!this.pending.has(input.tick)) {
      if (this.pending.size >= P.AGREEMENT.MAX_PENDING_TICKS) return false
      this.pending.set(input.tick, new Map())
    }
    const byPlayer = this.pending.get(input.tick)
    if (!byPlayer.has(input.playerId)) {
      if (byPlayer.size >= P.AGREEMENT.MAX_INPUTS_PER_BUNDLE) return false
      byPlayer.set(input.playerId, new Map())
    }
    const versions = byPlayer.get(input.playerId)
    const h = P.inputHash(input)
    if (versions.has(h)) return true
    // one action, or the PAIR that proves equivocation (kept whole so any
    // future proposal deterministically includes both — CONSENSUS.md §7)
    if (versions.size >= P.AGREEMENT.MAX_INPUTS_PER_PLAYER) return false
    if (versions.size === 1) {
      const ev = P.inputEquivocationEvidence([...versions.values()][0], input)
      if (ev && this.inputEquivocations.length < 256) {
        this.inputEquivocations.push(ev)
        this.log(`input equivocation by ${input.playerId.slice(0, 8)}… at tick ${input.tick}: both versions will be bundled and excluded`)
      }
    }
    versions.set(h, input)
    return true
  }

  // ---- proposal (CONSENSUS.md §3) ----
  propose(round) {
    const state = this.getState()
    this.proposedRounds.add(round)
    const byPlayer = this.pending.get(state.tick) ?? new Map()
    const bundle = P.makeBundle({
      worldId: this.worldId, tick: state.tick, round,
      previousStateHash: this.prevHash,
      inputs: P.selectBundleInputs(byPlayer), // whole player groups: pairs never split
      witness: this.witnessKey,
    })
    this.log(`proposing tick ${state.tick} round ${round}: ${bundle.inputs.length} input(s)`)
    this.onBundle(bundle)              // we are also a witness of our own proposal
    this.publish('bundle', bundle)
  }

  // ---- bundle receipt: validate, recompute, LOCK, attest (§4, §5) ----
  onBundle(bundle) {
    if (this.halted) return
    const state = this.getState()
    if (!bundle || bundle.tick !== state.tick || bundle.worldId !== this.worldId) return
    if (!Number.isInteger(bundle.round) || bundle.round < 0) return

    // proposer equivocation (§5): tracked by (tick, round, proposer) on
    // SIGNED bundles, before any timing/validation gate — evidence is
    // evidence whenever it arrives
    if (typeof bundle.proposer === 'string' && P.verifyBundleSig(bundle)) {
      const key = bundle.round + '|' + bundle.proposer
      const prior = this.seenProposals.get(key)
      const bh0 = P.bundleHash(bundle)
      if (prior && P.bundleHash(prior) !== bh0) {
        const ev = P.proposerEquivocationEvidence(prior, bundle)
        if (ev && this.proposerEquivocations.length < 64) {
          // final-fixes brief §7: signed-but-stale conflicts (e.g. a
          // replayed bundle with an alien lineage) are EVIDENCE but not
          // grounds for poisoning; the strongest response is reserved for
          // two structurally live bundles — both claiming OUR current
          // lineage — which is unambiguous same-instance equivocation.
          const live = prior.previousStateHash === this.prevHash
            && bundle.previousStateHash === this.prevHash
          this.proposerEquivocations.push({ ...ev, liveConflict: live })
          if (live) {
            this.poisonedProposers.add(bundle.proposer)
            this.log(`PROPOSER EQUIVOCATION: ${bundle.proposer.slice(0, 8)}… signed two live bundles for tick ${bundle.tick} round ${bundle.round} — evidence kept, proposer ignored this tick`)
          } else {
            this.log(`conflicting signed bundle from ${bundle.proposer.slice(0, 8)}… (stale lineage) — evidence kept`)
          }
        }
        return // the later bundle is never processed
      }
      if (!prior) {
        if (this.seenProposals.size >= P.AGREEMENT.MAX_PROPOSALS_PER_TICK * 4) return
        this.seenProposals.set(key, bundle)
      }
      if (this.poisonedProposers.has(bundle.proposer)) return
    }

    if (!this.roundOpen(bundle.round)) return // a round cannot be jumped early
    const expected = P.proposerFor(this.genesis, this.worldId, this.prevHash, state.tick, bundle.round)
    const err = P.validateBundle(state, this.worldId, bundle, expected)
    if (err) { this.log(`bundle rejected (tick ${bundle.tick} round ${bundle.round}): ${err}`); return }
    const bh = P.bundleHash(bundle)
    // identical bundle → re-attestation is always allowed (LOCK-2)
    if (this.witnessKey && this.lock?.bundleHash === bh) {
      this.acceptAttestation(this.lock.attestation)
      this.publish('attestation', this.lock.attestation)
    }
    if (this.proposals.has(bh)) { this.tryFinalize(bh); return }
    if (this.proposals.size >= P.AGREEMENT.MAX_PROPOSALS_PER_TICK) return
    // recompute, never trust: the transition is OURS to verify
    const next = E.nextState(state, bundle.inputs)
    const rsh = E.stateHash(next)
    this.proposals.set(bh, { bundle, next, rsh })

    if (this.witnessKey) {
      if (this.lock) {
        // LOCK-2: one hash per tick, EVER — across all rounds.
        if (this.lock.bundleHash !== bh) this.log(`holding lock ${this.lock.bundleHash.slice(0, 8)}… — refusing to sign ${bh.slice(0, 8)}… (tick ${state.tick} round ${bundle.round})`)
      } else {
        // LOCK-1: first valid bundle → compute, PERSIST the lock, THEN vote
        const att = P.makeAttestation({
          worldId: this.worldId, tick: state.tick, round: bundle.round,
          bundleHash: bh, resultingStateHash: rsh, witness: this.witnessKey,
        })
        const lock = { format: LOCK_FORMAT, worldId: this.worldId, tick: state.tick, bundleHash: bh, bundle, attestation: att }
        try { this.lockStore.save(lock) } catch (e) {
          this.log(`FAILED to persist vote lock (${e.message}) — refusing to vote rather than risk double-signing`)
          return
        }
        this.lock = lock
        this._lastRebroadcast = this.now()
        this.acceptAttestation(att)
        this.publish('attestation', att)
      }
    }
    this.tryFinalize(bh)
  }

  // ---- attestation receipt ----
  onAttestation(att) {
    if (this.halted) return
    const state = this.getState()
    if (!att || att.worldId !== this.worldId || att.tick !== state.tick) return
    if (!Number.isInteger(att.round) || att.round < 0) return
    if (!this.genesis.witnesses.includes(att.witness)) return
    if (typeof att.bundleHash !== 'string' || att.bundleHash.length !== 64) return
    if (!P.verifyAttestationSig(att)) return
    this.acceptAttestation(att)
    this.tryFinalize(att.bundleHash)
  }

  acceptAttestation(att) {
    if (!this.atts.has(att.bundleHash)) {
      if (this.atts.size >= P.AGREEMENT.MAX_PROPOSALS_PER_TICK * 4) return
      this.atts.set(att.bundleHash, new Map())
    }
    const m = this.atts.get(att.bundleHash)
    if (!m.has(att.witness)) m.set(att.witness, att)
  }

  // ---- finality: quorum on (bundleHash, resultingStateHash) at the bundle's round ----
  tryFinalize(bh) {
    if (this.halted) return
    const p = this.proposals.get(bh)
    const m = this.atts.get(bh)
    if (!p || !m) return
    // certificate coherence: only attestations at the bundle's own round
    // count (a certificate mixing rounds is rejected by every verifier)
    const usable = [...m.values()].filter(a => a.round === p.bundle.round)
    const matching = usable.filter(a => a.resultingStateHash === p.rsh)
    const differing = usable.filter(a => a.resultingStateHash !== p.rsh)
    if (differing.length >= this.genesis.quorum) {
      // A quorum attested a resulting-state hash that differs from what THIS
      // node computed for the same bundle — a certified-result mismatch (not
      // proposer equivocation, which is one proposer signing two bundles).
      // Attach the full quorum: the bundle, our result, the certified
      // result, and every signed attestation on both sides.
      const certifying = differing.slice(0, this.genesis.quorum)
      return this.halt(HALT.CERTIFIED_RESULT_MISMATCH,
        `a quorum certified result ${differing[0].resultingStateHash.slice(0, 8)}… for bundle ${bh.slice(0, 8)}… but local replay produced ${p.rsh.slice(0, 8)}…`,
        { bundle: p.bundle, bundleHash: bh, localResult: p.rsh, certifiedResult: differing[0].resultingStateHash,
          certifyingAttestations: certifying, agreeingAttestations: matching })
    }
    if (matching.length < this.genesis.quorum) return
    const record = {
      tick: p.bundle.tick, round: p.bundle.round,
      previousStateHash: p.bundle.previousStateHash,
      bundleHash: bh, resultingStateHash: p.rsh,
      bundle: p.bundle,
      attestations: matching.sort((a, b) => (a.witness < b.witness ? -1 : 1)).slice(0, this.genesis.quorum),
    }
    this.commit(record, p.next)
    if (this.witnessKey) this.publish('finality', record)
  }

  // ---- finality record receipt (live gossip AND certified catch-up) ----
  // CONSENSUS.md §6.3: verify the ONE proof, verify the bundle against our
  // own state INCLUDING the constitutional proposer, replay it, and demand
  // the certified result byte-for-byte. Raw state is never adopted.
  onFinality(record) {
    if (this.halted) return 'halted'
    const state = this.getState()
    if (!record || typeof record.tick !== 'number') return 'wrong tick'
    // A node that fell behind (a partition, a slow link) receives finality
    // records for ticks AHEAD of its own. Rather than drop them — which
    // strands the node forever, one missed record poisoning all that follow
    // — buffer a bounded window of future records and drain them IN ORDER
    // as the gap fills. Each is still fully verified in applyFinality; this
    // is catch-up, not trust. (A larger gap than the buffer needs a
    // checkpoint sync, exactly as a cold start does.)
    if (record.tick > state.tick) {
      this._futureFinality ??= new Map()
      if (record.tick - state.tick <= (P.AGREEMENT.MAX_PENDING_TICKS ?? 64)) {
        if (!this._futureFinality.has(record.tick)) this._futureFinality.set(record.tick, record)
        if (this._futureFinality.size > (P.AGREEMENT.MAX_PENDING_TICKS ?? 64)) {
          const oldest = Math.min(...this._futureFinality.keys())
          if (oldest < state.tick) this._futureFinality.delete(oldest)
        }
      }
      return 'buffered ahead'
    }
    if (record.tick !== state.tick) {
      // record.tick < state.tick: a certificate for an ALREADY-FINALIZED
      // tick (Byzantine Safety Upgrade §5). Do not ignore it — a valid
      // certificate that CONFLICTS with the one we finalized is proof that
      // more than f witnesses violated the constitution, and the honest
      // response is to halt with both certificates as attributable evidence.
      // Compare against retained finality: prefer the in-memory log, but
      // fall back to the DURABLE finality index so a conflict is caught even
      // after the memory window expired or a restart cleared it (§2).
      let prior = this.finalizedLog?.get(record.tick)
      let priorSource = 'memory'
      if (!prior && this.finalityIndex) {
        try {
          const entry = this.finalityIndex.get(record.tick)
          if (entry) { prior = entry.cert ?? entry; priorSource = 'durable-index' }
        } catch (e) {
          // §2: a historical index we cannot READ is not "no history" — it
          // is lost accountability. Halt rather than silently proceed as if
          // this tick were never finalized (which could miss a real fork).
          this.halt(HALT.FINALITY_INDEX_READ_FAILED,
            `finality index unreadable during a historical conflict check for tick ${record.tick} (${e.message}) — halting rather than treating history as absent`,
            { tick: record.tick, cause: e.message })
          return 'halted: finality index unreadable'
        }
      }
      if (prior) {
        // verify the incoming certificate stands on its own first
        const perr = P.verifyFinalityProof(this.genesis, this.worldId, record)
        if (perr) return 'invalid historical certificate: ' + perr
        // identical certificate (same bundle AND state) → harmless duplicate
        if (record.bundleHash === prior.bundleHash && record.resultingStateHash === prior.resultingStateHash)
          return 'duplicate historical certificate'
        // a VALID certificate that disagrees on bundle or resulting state is
        // a conflicting finality: preserve both, halt, expose as evidence
        this.halt(HALT.CONFLICTING_CERTIFICATES,
          `two valid certificates for finalized tick ${record.tick} disagree (ours [${priorSource}]: bundle ${prior.bundleHash.slice(0, 8)}… → ${prior.resultingStateHash.slice(0, 8)}…, incoming: bundle ${record.bundleHash.slice(0, 8)}… → ${record.resultingStateHash.slice(0, 8)}…) — more than f witnesses violated the constitution; both signatures are attributable`,
          { tick: record.tick, ours: prior, conflicting: record, priorSource })
        return 'halted: conflicting certificates'
      }
      return 'wrong tick'
    }
    const perr = P.verifyFinalityProof(this.genesis, this.worldId, record)
    if (perr) return 'invalid proof: ' + perr
    if (record.previousStateHash !== this.prevHash) return 'wrong lineage'
    const expected = P.proposerFor(this.genesis, this.worldId, this.prevHash, state.tick, record.round)
    const berr = P.validateBundle(state, this.worldId, record.bundle, expected)
    if (berr) {
      this.halt(HALT.CERTIFIED_INVALID_BUNDLE, `quorum certified an invalid bundle at tick ${record.tick}: ${berr}`, { record, bundleError: berr })
      return 'halted: certified bundle invalid'
    }
    const next = E.nextState(state, record.bundle.inputs)
    if (E.stateHash(next) !== record.resultingStateHash) {
      this.halt(HALT.REPLAY_MISMATCH, `local replay of certified tick ${record.tick} disagrees with the quorum`, { record, localResult: E.stateHash(next), certified: record.resultingStateHash })
      return 'halted: replay mismatch'
    }
    this.commit(record, next)
    return null
  }

  commit(record, next) {
    // FAIL-CLOSED ORDERING (CONSENSUS.md §4, "the frontier advances or
    // nothing does"): 1. finality is already verified by the caller;
    // 2. persist the frontier DURABLY — if this fails, HALT with the
    // active vote lock intact and adopt nothing (a cleared lock plus a
    // lost frontier is exactly the crash window that re-opens historical
    // re-signing); 3. append the durable finality INDEX (a first-class
    // accountability record — final review §1); 4. only then adopt state;
    // 5. retire the spent lock to the history journal (hygiene — its
    // failure is tolerated); 6. callbacks and checkpointing last.
    if (this.frontierStore) {
      const f = { format: FRONTIER_FORMAT, worldId: this.worldId, tick: record.tick, resultingStateHash: record.resultingStateHash }
      try { this.frontierStore.save(f) } catch (e) {
        return this.halt(HALT.FRONTIER_PERSIST_FAILED, `frontier persist failed (${e.message}) — halting with the vote lock intact; fix the disk, then restart`, { record, cause: e.message })
      }
      this.frontier = f
    }
    // The finality index is a SAFETY record, not best-effort (final review
    // §1): if the historical record cannot be persisted, we must not advance
    // execution — a lost history is a lost ability to detect a future
    // conflicting certificate. HALT with the frontier durable and the lock
    // intact; recovery is a certified checkpoint on restart. Idempotent:
    // an identical record for this tick is a harmless no-op, a conflicting
    // one is corruption.
    if (this.finalityIndex) {
      try {
        const existing = this.finalityIndex.get(record.tick)
        if (existing) {
          if (existing.bundleHash !== record.bundleHash || existing.resultingStateHash !== record.resultingStateHash)
            return this.halt(HALT.FINALITY_INDEX_CORRUPT,
              `finality index already holds a DIFFERENT record for tick ${record.tick} (indexed bundle ${existing.bundleHash.slice(0, 8)}… → ${existing.resultingStateHash.slice(0, 8)}…, committing ${record.bundleHash.slice(0, 8)}… → ${record.resultingStateHash.slice(0, 8)}…) — historical corruption; halting`,
              { tick: record.tick, indexed: existing, committing: record })
          // identical → already durably recorded, no re-append needed
        } else {
          this.finalityIndex.append(record)
        }
      } catch (e) {
        // the store enforces immutability too: a conflicting append it
        // rejects is corruption, not a disk failure
        if (e.conflict)
          return this.halt(HALT.FINALITY_INDEX_CORRUPT,
            `finality index rejected a conflicting append for tick ${record.tick} (${e.message}) — history is immutable; halting`,
            { tick: record.tick, ...e.conflict })
        // otherwise a read failure and an append failure are distinct halts
        const readFail = /unreadable|read/i.test(e.message) && !/append|write/i.test(e.message)
        return this.halt(readFail ? HALT.FINALITY_INDEX_READ_FAILED : HALT.FINALITY_INDEX_PERSIST_FAILED,
          `finality index ${readFail ? 'read' : 'persist'} failed at tick ${record.tick} (${e.message}) — halting with the frontier durable and the vote lock intact; fix the disk, then restart`,
          { record, cause: e.message })
      }
    }
    // rev4 brief §5: past this line the frontier AND the finality index are
    // durable. If state adoption now fails, we HALT with both KEPT — never
    // rolled back — and recovery is a certified checkpoint at or past here.
    try {
      this.setState(next)
      this.prevHash = record.resultingStateHash
      this.latestRecord = record
    } catch (e) {
      return this.halt(HALT.STATE_ADOPTION_FAILED, `state adoption failed after the frontier was persisted (${e.message}) — the frontier stands; recover from a certified checkpoint at tick ${record.tick + 1} or later`, { record, cause: e.message })
    }
    if (this.lock && this.lockStore?.archive) {
      // archive failure cannot hurt safety (the frontier is already
      // durable) but silence hides dying disks: log it (rev5 §6)
      try { this.lockStore.archive(`${record.tick}-${record.bundleHash.slice(0, 16)}`) }
      catch (e) { this.log(`lock archive failed (${e.message}) — consensus safety unaffected (frontier is durable), but inspect the disk`) }
    }
    this.finalizedLog.set(record.tick, record)
    while (this.finalizedLog.size > P.AGREEMENT.MAX_FINALIZED_HISTORY)
      this.finalizedLog.delete(this.finalizedLog.keys().next().value)
    this.pending.delete(record.tick)
    this.proposals.clear()
    this.atts.clear()
    this.proposedRounds.clear()
    this.seenProposals.clear()
    this.poisonedProposers.clear()
    this.lock = null // a finalized tick releases nothing to re-sign: it is over
    this._lastRebroadcast = -Infinity
    try { this.onFinalized(record, next) } catch (e) {
      this.halt(HALT.CALLBACK_FAILED, `post-finality callback failed (${e.message}) — the frontier and state stand at tick ${record.tick + 1}; fix and restart`, { record, cause: e.message })
    }
    // drain any buffered future record that is now the current tick — a
    // behind node catches up in one sweep once the missing links arrive
    if (this._futureFinality && !this.halted) {
      const nextTick = this.getState().tick
      const buffered = this._futureFinality.get(nextTick)
      if (buffered) {
        this._futureFinality.delete(nextTick)
        this.onFinality(buffered)
      }
    }
  }

  halt(code, reason, evidence) {
    // Structural halt (final freeze brief §4): a stable CODE, a
    // human-readable reason, and supporting evidence. Byzantine halts must
    // carry the evidence that justified them (the conflicting results, the
    // invalid bundle) so a reviewer can verify the halt was warranted.
    this.halted = true
    this.haltCode = code
    this.haltReason = reason
    this.haltEvidence = evidence ?? null
    this.halt_ = { code, reason, evidence: evidence ?? null } // structural record
    this.log(`HALTED [${code}]: ${reason} — refusing to finalize further intervals; recover from a certified checkpoint`)
  }
}
