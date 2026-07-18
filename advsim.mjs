// Interval adversarial simulator (pre-freeze brief: "sustained adversarial
// multi-node simulation"). A deterministic, seeded, event-driven network
// of IntervalAgreement nodes under a HOSTILE transport — delay, reorder,
// duplicate, loss, asymmetric partitions — plus Byzantine witnesses:
// equivocating proposers, lying attesters, replayers, garbage floods, and
// crash-restart witnesses recovering from durable stores.
//
// THE FREEZE CRITERION under test, every scenario, every seed:
//   S1  no two honest nodes finalize different hashes for the same tick
//   S2  no honest witness ever signs two bundle hashes for one tick
//   S3  every finality record an honest node commits verifies standalone
//   S4  honest nodes halt only when Byzantine behavior is present
// Liveness is REPORTED everywhere and asserted only where the model
// promises it (benign and crash-only scenarios).
//
//   node advsim.mjs                 # all scenarios × default seeds
//   node advsim.mjs chaos 5 120000  # one scenario, 5 seeds, 120s virtual
import { createRequire } from 'module'
import crypto from 'crypto'
import E from './engine.js'
import * as P from './protocol.mjs'
import { IntervalAgreement } from './agreement.mjs'
import { ERR, HALT, ALL_HALT, codeOf } from './errors.mjs'

const require = createRequire(import.meta.url)
const ed = require('@noble/ed25519')

const RULES = 'c'.repeat(64)

// DETERMINISTIC identities: the seed must pin the ENTIRE run — witness
// keys decide the worldId, the worldId decides the proposer schedule, and
// the proposer schedule decides every race. Random keys made "the same
// seed" a different experiment each invocation.
function identityFromSeed(tag) {
  E.initCrypto() // ensure ed25519 has its sha512 (engine wires it lazily, §7)
  const privateKey = crypto.createHash('sha256').update('advsim-identity|' + tag).digest()
  return { playerId: Buffer.from(ed.getPublicKey(privateKey)).toString('hex'), privateKey }
}

// ---------- deterministic PRNG ----------
export const mulberry = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---------- event heap ----------
class Heap {
  constructor() { this.a = [] }
  push(t, seq, fn) {
    const e = { t, seq, fn }; this.a.push(e)
    let i = this.a.length - 1
    while (i > 0) { const p = (i - 1) >> 1
      if (this.a[p].t < this.a[i].t || (this.a[p].t === this.a[i].t && this.a[p].seq < this.a[i].seq)) break
      ;[this.a[p], this.a[i]] = [this.a[i], this.a[p]]; i = p }
  }
  pop() {
    const top = this.a[0], last = this.a.pop()
    if (this.a.length) { this.a[0] = last
      let i = 0
      for (;;) { let m = i, l = 2 * i + 1, r = l + 1
        const lt = (x, y) => this.a[x].t < this.a[y].t || (this.a[x].t === this.a[y].t && this.a[x].seq < this.a[y].seq)
        if (l < this.a.length && lt(l, m)) m = l
        if (r < this.a.length && lt(r, m)) m = r
        if (m === i) break
        ;[this.a[m], this.a[i]] = [this.a[i], this.a[m]]; i = m } }
    return top
  }
  get size() { return this.a.length }
}

// ---------- the simulation ----------
// §5 (rigor): does a halt's evidence actually PROVE the reported condition?
// Each Byzantine/durability halt makes a specific claim; verify the attached
// evidence bears it out, rather than trusting the code. Returns null if the
// evidence proves the halt, or a string describing why it does not.
// §4/§5: verify a halt's evidence by REPLAYING the protocol, not just
// checking that fields are present. `ctx` supplies the world binding:
//   { genesis, worldId, verifyCert(cert), verifyAtt(att), replay(bundle,prevState?) }
// Each Byzantine halt's evidence is checked against what the protocol would
// actually conclude — signatures, witness identities, uniqueness, quorum,
// deterministic replay, and the resulting state hash.
export function verifyHaltEvidence(h, ctx = {}) {
  const verifyCert = ctx.verifyCert ?? (() => null)
  const verifyAtt = ctx.verifyAtt ?? (() => true)
  const genesis = ctx.genesis
  const ev = h.evidence
  if (!ev) return h.code && h.code.startsWith('HALT_') && [HALT.CERTIFIED_RESULT_MISMATCH, HALT.CERTIFIED_INVALID_BUNDLE, HALT.REPLAY_MISMATCH].includes(h.code)
    ? 'no evidence attached' : null
  switch (h.code) {
    case HALT.CONFLICTING_CERTIFICATES:
      // two independently-valid certificates for one finalized tick that
      // DISAGREE — cryptographic, not structural
      if (!ev.ours || !ev.conflicting) return 'missing the two conflicting certificates'
      if (ev.ours.tick !== ev.conflicting.tick) return 'certificates are for different ticks'
      if (ev.ours.bundleHash === ev.conflicting.bundleHash && ev.ours.resultingStateHash === ev.conflicting.resultingStateHash)
        return 'the two certificates agree — no conflict'
      if (verifyCert(ev.ours)) return 'our retained certificate does not verify'
      if (verifyCert(ev.conflicting)) return 'the conflicting certificate does not verify'
      return null

    case HALT.CERTIFIED_RESULT_MISMATCH: {
      // a quorum certified a resulting-state hash different from local
      // replay. PROVE it: (1) the certifying attestations must be a genuine
      // quorum of DISTINCT genesis witnesses with valid signatures, all
      // naming the certified result; (2) local replay of the bundle must
      // actually produce a DIFFERENT hash.
      if (!ev.bundle || !ev.localResult || !ev.certifiedResult) return 'missing bundle/localResult/certifiedResult'
      if (ev.localResult === ev.certifiedResult) return 'localResult equals certifiedResult — no mismatch'
      const atts = ev.certifyingAttestations
      if (!Array.isArray(atts)) return 'missing certifying attestations'
      if (genesis && atts.length < genesis.quorum) return `only ${atts.length} attestations, need a quorum of ${genesis.quorum}`
      const signers = new Set()
      for (const a of atts) {
        if (genesis && !genesis.witnesses.includes(a.witness)) return `attestation from a non-witness ${String(a.witness).slice(0, 8)}…`
        if (signers.has(a.witness)) return 'duplicate witness in the certifying quorum'
        signers.add(a.witness)
        if (!verifyAtt(a)) return `invalid attestation signature from ${String(a.witness).slice(0, 8)}…`
        if (a.resultingStateHash !== ev.certifiedResult) return 'a certifying attestation does not name the certified result'
      }
      // deterministic replay must confirm the divergence
      if (ctx.replay) {
        const replayed = ctx.replay(ev.bundle)
        if (replayed == null) return 'replay could not be performed'
        if (replayed === ev.certifiedResult) return 'replay matches the certified result — no mismatch'
        if (replayed !== ev.localResult) return 'replay disagrees with the recorded localResult'
      }
      return null
    }

    case HALT.PROPOSER_EQUIVOCATION:
      // §6: same world, tick, round, proposer; DIFFERENT bundles; both
      // proposer signatures valid; the proposer is constitutional
      if (!ev.a || !ev.b) return 'missing the two conflicting bundles'
      if (ev.a.worldId !== ev.b.worldId) return 'bundles are for different worlds'
      if (ctx.worldId && ev.a.worldId !== ctx.worldId) return 'bundles are not for this world'
      if (ev.a.tick !== ev.b.tick) return 'bundles are for different ticks'
      if (ev.a.round !== ev.b.round) return 'bundles are for different rounds'
      if (ev.a.proposer !== ev.b.proposer) return 'bundles have different proposers — not equivocation'
      if (ctx.genesis && !ctx.genesis.witnesses.includes(ev.a.proposer)) return 'the proposer is not a constitutional witness'
      if (ctx.bundleHash && ctx.bundleHash(ev.a) === ctx.bundleHash(ev.b)) return 'the two bundles are identical — no equivocation'
      if (ctx.verifyBundle) {
        if (!ctx.verifyBundle(ev.a)) return 'bundle A carries an invalid proposer signature'
        if (!ctx.verifyBundle(ev.b)) return 'bundle B carries an invalid proposer signature'
      }
      return null

    case HALT.REPLAY_MISMATCH:
      // §8: replay deterministically from the previous certified state; do
      // not trust stored values. The certified record must verify, and a
      // fresh replay of its bundle must differ from the certified result.
      if (!ev.record || !ev.localResult) return 'missing record/localResult'
      if (verifyCert(ev.record)) return 'the certified record does not verify'
      if (ctx.replay) {
        const replayed = ctx.replay(ev.record.bundle ?? ev.record)
        if (replayed == null) return 'replay could not be performed from the previous certified state'
        if (replayed === ev.record.resultingStateHash) return 'a fresh replay matches the certified result — no mismatch'
        if (replayed !== ev.localResult) return 'fresh replay disagrees with the recorded localResult'
      } else if (ev.localResult === (ev.certified ?? ev.record.resultingStateHash)) {
        return 'local replay matches the certified result — no mismatch'
      }
      return null

    case HALT.CERTIFIED_INVALID_BUNDLE:
      // §7: re-run bundle validation (and proposer selection) rather than
      // trusting the supplied error string. The record must verify as a
      // certificate, and re-validation must independently find it invalid.
      if (!ev.record) return 'missing certified record'
      if (verifyCert(ev.record)) return 'the certified record does not verify (cannot attribute the halt)'
      if (ctx.validateBundle) {
        const revErr = ctx.validateBundle(ev.record)
        if (!revErr) return 're-validation found the bundle VALID — the recorded invalidity does not reproduce'
      } else if (!ev.bundleError) {
        return 'no bundle validation error recorded and no re-validator available'
      }
      return null

    case HALT.FRONTIER_PERSIST_FAILED:
    case HALT.FINALITY_INDEX_PERSIST_FAILED:
    case HALT.FINALITY_INDEX_READ_FAILED:
    case HALT.STATE_ADOPTION_FAILED:
    case HALT.CALLBACK_FAILED:
      if (!ev.cause && !ev.record) return 'no cause recorded for a durability halt'
      return null

    case HALT.FINALITY_INDEX_CORRUPT:
      // proof: the index already holds a DIFFERENT record for the same tick
      if (!ev.indexed || !ev.committing) return 'missing the indexed vs committing records'
      if (ev.indexed.bundleHash === ev.committing.bundleHash && ev.indexed.resultingStateHash === ev.committing.resultingStateHash)
        return 'the indexed and committing records agree — no corruption'
      return null

    default:
      return null
  }
}

export function runScenario(name, cfg, seed, durationMs, quiet = true) {
  const rnd = mulberry(seed)
  const heap = new Heap()
  let clock = 0, seq = 0
  const schedule = (dt, fn) => heap.push(clock + Math.max(0, dt), seq++, fn)

  // world: n witnesses, quorum q, all pinned in genesis
  const wkeys = Array.from({ length: cfg.n }, (_, i) => identityFromSeed(`${name}|${seed}|w${i}`))
  const players = [identityFromSeed(`${name}|${seed}|p0`), identityFromSeed(`${name}|${seed}|p1`)]
  const genesis = E.makeGenesis(`adv-${name}-${seed}`, RULES, 0, 64, 48)
  genesis.witnesses = wkeys.map(k => k.playerId)
  genesis.quorum = cfg.q
  // Byzantine Safety Upgrade: each scenario declares its fault threshold f
  // (default: the largest the (n,q) pair safely carries). Scenarios with
  // Byzantine actors must configure n,q,f so byzantineSafe holds — a config
  // that cannot tolerate the actors it spawns is a scenario bug.
  genesis.byzantineTolerance = cfg.f ?? (() => {
    for (let f = E.maxByzantine(cfg.n); f >= 0; f--) if (E.byzantineSafe(cfg.n, cfg.q, f)) return f
    return 0
  })()
  // a scenario must not spawn more Byzantine actors than its constitution
  // tolerates — otherwise it tests behavior OUTSIDE the model, and a fork
  // there would be expected, not a bug. Guard against that silently.
  const byzCount = (cfg.byzantine ?? []).length
  if (byzCount > genesis.byzantineTolerance)
    throw new Error(`scenario ${name} spawns ${byzCount} Byzantine actors but n=${cfg.n},q=${cfg.q},f=${genesis.byzantineTolerance} only tolerates ${genesis.byzantineTolerance} — reconfigure n,q,f`)
  const worldId = E.worldId(genesis)
  const build = () => {
    const s = E.newWorld(genesis)
    for (const p of players) E.addPlayer(s, p.playerId, 5, 5)
    E.addNode(s, 'tree-1', 'tree', 4, 5)
    return s
  }

  // ---- evidence collected for the invariant checkers ----
  const wire = { attestations: [], bundles: [], finality: [] } // everything ever published
  const honest = new Set(wkeys.map(k => k.playerId))
  for (const b of cfg.byzantine ?? []) honest.delete(wkeys[b.index].playerId)

  const nodes = [] // { name, agreement|null (null while crashed), holder, stores, witnessKey, byz }
  const partitions = [] // { a:Set, b:Set, until } — a↔b severed

  // The harness distinguishes MODELLED failures from UNEXPECTED ones by
  // typed ERROR CODE, and — Byzantine upgrade §7 — by CONTEXT. A recovery
  // refusal (rollback, stale-checkpoint, corrupt-store) is legitimate ONLY
  // when a node is restarting from durable stores; the very same code thrown
  // during steady-state message delivery or drive() is a bug. Scoping the
  // expected set to the operation that produced it stops a genuine
  // regression from hiding behind a recognized-but-misplaced code.
  const harnessErrors = []
  // codes that are legitimate ONLY in the 'restart' context (fail-closed
  // recovery refusing to re-sign history / adopt a stale or foreign store)
  const RESTART_CODES = new Set([
    ERR.WORLD_MISMATCH, ERR.FRONTIER_ROLLBACK, ERR.FRONTIER_AHEAD_UNPROVEN,
    ERR.CORRUPT_LOCK, ERR.CORRUPT_FRONTIER, ERR.CORRUPT_SAFETY_RECORD,
    ERR.INVALID_CHECKPOINT, ERR.INVALID_BUILT_STATE, ERR.MISSING_STORES,
    ERR.CHECKPOINT_REJECTED, ERR.CHECKPOINT_UNCORROBORATED, ERR.INVALID_GENESIS,
    ERR.CORRUPT_IDENTITY,
  ])
  // message delivery and steady-state drive tolerate NO protocol error:
  // deliver-context codes must be empty. (A halt is not an exception — it is
  // a recorded state, checked separately in S4.)
  const EXPECTED_BY_CONTEXT = { restart: RESTART_CODES, deliver: new Set(), drive: new Set(), event: new Set() }
  const isExpectedIn = (context, e) =>
    typeof e?.code === 'string' && (EXPECTED_BY_CONTEXT[context]?.has(e.code) ?? false)
  const guard = (where, fn, context = 'event') => {
    try { return fn() }
    catch (e) {
      if (!isExpectedIn(context, e))
        harnessErrors.push(`${where} [ctx=${context}]: [${e?.code ?? 'UNCODED'}] ${e?.message ?? e}`)
      return undefined
    }
  }

  const linkCut = (from, to) => partitions.some(p => clock < p.until
    && ((p.a.has(from) && p.b.has(to)) || (p.b.has(from) && p.a.has(to))))

  function deliverAll(fromName, kind, obj) {
    // record what left the sender — the double-sign detector watches the WIRE
    if (kind === 'attestation') wire.attestations.push(JSON.parse(JSON.stringify(obj)))
    if (kind === 'bundle') wire.bundles.push(JSON.parse(JSON.stringify(obj)))
    if (kind === 'finality') wire.finality.push({ at: clock, rec: JSON.parse(JSON.stringify(obj)) })
    for (const n of nodes) {
      if (n.name === fromName || !n.agreement) continue
      if (linkCut(fromName, n.name)) continue
      if (rnd() < (cfg.loss ?? 0)) continue
      const copies = 1 + (rnd() < (cfg.dup ?? 0) ? 1 : 0) + (rnd() < (cfg.dup ?? 0) / 2 ? 1 : 0)
      for (let c = 0; c < copies; c++) {
        const delay = (cfg.minDelay ?? 5) + rnd() * ((cfg.maxDelay ?? 60) - (cfg.minDelay ?? 5))
        const bytes = JSON.stringify(obj) // over the wire: bytes
        schedule(delay, () => {
          const t = nodes.find(x => x.name === n.name)
          if (!t?.agreement) return
          const msg = JSON.parse(bytes)
          // §7: message delivery is the 'deliver' context — a protocol error
          // here is never expected (unlike a recovery refusal on restart)
          guard(`deliver ${kind}→${n.name}`, () => {
            if (kind === 'bundle') t.agreement.onBundle(msg)
            else if (kind === 'attestation') t.agreement.onAttestation(msg)
            else if (kind === 'finality') t.agreement.onFinality(msg)
            else if (kind === 'input') t.agreement.addInput(msg)
          }, 'deliver')
        })
      }
    }
  }

  function makeAgreement(n) {
    return new IntervalAgreement({
      genesis, worldId, name: n.name, witnessKey: n.witnessKey,
      lockStore: n.stores.lock, frontierStore: n.stores.frontier, finalityIndexStore: n.stores.index,
      recoveryProof: n.holder.recoveryProof ?? null,
      getState: () => n.holder.state,
      setState: (next) => { n.holder.state = next },
      publish: (kind, obj) => {
        // crash-in-the-window fault: the vote is DURABLE but never leaves
        if (n.crashOnNextPublish && kind === 'attestation') {
          n.crashOnNextPublish = false
          crash(n, 'mid-vote')
          return
        }
        deliverAll(n.name, kind, obj)
      },
      onFinalized: (rec) => { n.holder.recoveryProof = rec },
      now: () => clock,
      log: () => {},
    })
  }

  function crash(n, why) {
    if (!n.agreement) return
    n.agreement = null
    n.crashes++
    if (!quiet) console.log(`  [${(clock / 1000).toFixed(1)}s] ${n.name} crashed (${why})`)
    const downFor = 500 + rnd() * (cfg.maxDowntime ?? 3000)
    schedule(downFor, () => {
      try {
        n.agreement = makeAgreement(n) // restores lock + frontier from stores
        driveLoop(n)
      } catch (e) {
        // a refused restart (safety) is MODELLED; an unexpected one is a bug
        if (!isExpectedIn('restart', e)) { harnessErrors.push(`restart ${n.name}: [${e.code ?? 'UNCODED'}] ${e.message}`); return }
        if (!quiet) console.log(`  [${(clock / 1000).toFixed(1)}s] ${n.name} restart refused: ${e.message.slice(0, 60)}`)
        schedule(1000, () => {
          try { n.agreement = makeAgreement(n); driveLoop(n) }
          catch (e2) { if (!isExpectedIn('restart', e2)) harnessErrors.push(`restart-retry ${n.name}: [${e2.code ?? 'UNCODED'}] ${e2.message}`) }
        })
      }
    })
  }

  function driveLoop(n) {
    const tick = () => {
      if (!n.agreement) return
      guard(`drive ${n.name}`, () => n.agreement.drive(), 'drive')
      schedule(100, tick)
    }
    schedule(100, tick)
  }

  // ---- construct honest witnesses (all with in-sim durable stores) ----
  for (let i = 0; i < cfg.n; i++) {
    const byz = (cfg.byzantine ?? []).find(b => b.index === i)
    const mem = { lock: null, frontier: null, index: new Map() }
    const stores = {
      lock: { save: (l) => { mem.lock = JSON.parse(JSON.stringify(l)) }, load: () => mem.lock, archive: () => { mem.lock = null } },
      frontier: { save: (f) => { mem.frontier = JSON.parse(JSON.stringify(f)) }, load: () => mem.frontier },
      // in-sim DURABLE finality index: survives a simulated crash/restart
      // (mem persists), enforces per-tick immutability at the store level
      index: {
        get: (tick) => mem.index.get(tick) ?? null,
        append: (record) => {
          const ex = mem.index.get(record.tick)
          if (ex) {
            if (ex.bundleHash !== record.bundleHash || ex.resultingStateHash !== record.resultingStateHash) {
              const e = new Error(`in-sim index conflict at tick ${record.tick}`); e.conflict = { indexed: ex, committing: record }; throw e
            }
            return ex
          }
          const entry = { tick: record.tick, bundleHash: record.bundleHash, resultingStateHash: record.resultingStateHash, cert: JSON.parse(JSON.stringify(record)) }
          mem.index.set(record.tick, entry); return entry
        },
        latestTick: () => (mem.index.size ? Math.max(...mem.index.keys()) : -1),
        validate: () => null,
      },
    }
    const n = { name: 'w' + i, witnessKey: wkeys[i], stores, byz, crashes: 0,
      holder: { state: build(), recoveryProof: null } }
    if (!byz) { n.agreement = makeAgreement(n); driveLoop(n) }
    nodes.push(n)
  }
  // one honest observer follows the certified chain
  {
    const n = { name: 'obs', witnessKey: null, stores: { lock: null, frontier: null }, crashes: 0,
      holder: { state: build(), recoveryProof: null } }
    n.agreement = new IntervalAgreement({
      genesis, worldId, name: 'obs', witnessKey: null,
      getState: () => n.holder.state, setState: (x) => { n.holder.state = x },
      publish: (k, o) => deliverAll('obs', k, o), onFinalized: () => {},
      now: () => clock, log: () => {},
    })
    driveLoop(n)
    nodes.push(n)
  }

  // ---- Byzantine actors ----
  for (const b of cfg.byzantine ?? []) {
    const me = nodes[b.index]
    const key = me.witnessKey
    // a shadow observer lets the villain track the honest chain
    const shadow = new IntervalAgreement({
      genesis, worldId, name: me.name + '-shadow', witnessKey: null,
      getState: () => me.holder.state, setState: (x) => { me.holder.state = x },
      publish: () => {}, onFinalized: () => {}, now: () => clock, log: () => {},
    })
    me.shadow = shadow
    const evil = () => {
      const st = me.holder.state
      const tick = st.tick
      const prev = shadow.prevHash
      const round = shadow.currentRound()
      if (round >= 0) {
        if (b.kind === 'equivocator'
          && P.proposerFor(genesis, worldId, prev, tick, round) === key.playerId) {
          // two different bundles for OUR round, each pushed at everyone,
          // plus double-signed attestations for both
          const junkInput = E.signInput(E.normalizeInput({ type: 'move', dx: 1, dy: 0 }) && { worldId, tick, playerId: players[0].playerId, type: 'move', dx: 1, dy: 0 }, players[0].privateKey)
          const A = P.makeBundle({ worldId, tick, round, previousStateHash: prev, inputs: [], witness: key })
          const B = P.makeBundle({ worldId, tick, round, previousStateHash: prev, inputs: [junkInput], witness: key })
          const nA = E.nextState(st, A.inputs), nB = E.nextState(st, B.inputs)
          deliverAll(me.name, 'bundle', A)
          deliverAll(me.name, 'bundle', B)
          deliverAll(me.name, 'attestation', P.makeAttestation({ worldId, tick, round, bundleHash: P.bundleHash(A), resultingStateHash: E.stateHash(nA), witness: key }))
          deliverAll(me.name, 'attestation', P.makeAttestation({ worldId, tick, round, bundleHash: P.bundleHash(B), resultingStateHash: E.stateHash(nB), witness: key }))
        }
        if (b.kind === 'liar') {
          // attest a corrupted result for whatever honest bundle is current
          const target = wire.bundles.filter(x => x.tick === tick && x.worldId === worldId).slice(-1)[0]
          if (target) {
            const lie = 'f'.repeat(64)
            deliverAll(me.name, 'attestation', P.makeAttestation({ worldId, tick, round: target.round, bundleHash: P.bundleHash(target), resultingStateHash: lie, witness: key }))
          }
        }
        if (b.kind === 'replayer' && wire.bundles.length) {
          const old = wire.bundles[Math.floor(rnd() * wire.bundles.length)]
          deliverAll(me.name, 'bundle', JSON.parse(JSON.stringify(old)))
          if (wire.attestations.length) deliverAll(me.name, 'attestation', JSON.parse(JSON.stringify(wire.attestations[Math.floor(rnd() * wire.attestations.length)])))
        }
        if (b.kind === 'garbage') {
          const junk = [null, 42, 'x', {}, { tick }, { v: 2, worldId, tick, round: -1 },
            { v: 2, worldId, tick, round, previousStateHash: prev, proposer: key.playerId, inputs: 'no', sig: 'zz' }][Math.floor(rnd() * 7)]
          deliverAll(me.name, ['bundle', 'attestation', 'finality'][Math.floor(rnd() * 3)], junk)
        }
      }
      schedule(150 + rnd() * 200, evil)
    }
    schedule(300, evil)
    // the shadow rides the honest gossip
    me.agreement = shadow // deliverAll routes on*() into the shadow so it follows the chain
    driveLoop(me)
  }

  // ---- honest player traffic through random entry nodes ----
  const traffic = () => {
    const pl = players[Math.floor(rnd() * players.length)]
    const entry = nodes[Math.floor(rnd() * nodes.length)]
    if (entry.agreement) {
      const st = entry.holder.state
      const input = E.signInput({ worldId, tick: st.tick, playerId: pl.playerId,
        ...E.normalizeInput({ type: 'move', dx: [1, 0, -1][Math.floor(rnd() * 3)], dy: 0 }) }, pl.privateKey)
      entry.agreement.addInput(input)
      deliverAll(entry.name, 'input', input)
    }
    schedule(300 + rnd() * 400, traffic)
  }
  schedule(200, traffic)

  // Finality regossip: real gossipsub re-shares recent messages across the
  // mesh, so a node that missed a record while partitioned receives it once
  // links heal. Model that — each live witness periodically re-emits its
  // latest finality record; a caught-up node ignores it, a behind node
  // buffers/applies it. Without this, a single dropped record strands a
  // node forever, which is a transport artifact, not a protocol property.
  const regossip = () => {
    // the SLOWEST honest node's height tells us which records are still
    // needed; re-share the window from there up so a behind node gets its
    // next link, not just the unreachable frontier
    const live = nodes.filter(n => n.agreement && !n.byz)
    const behind = Math.min(...live.map(n => (n.agreement.getState?.().tick ?? 0)))
    for (const n of live) {
      const log = n.agreement.finalizedLog
      if (!log || !log.size) continue
      const latest = Math.max(...log.keys())
      for (let t = behind; t <= Math.min(latest, behind + 8); t++) {
        const rec = log.get(t)
        if (rec) deliverAll(n.name, 'finality', rec)
      }
    }
    schedule(500, regossip)
  }
  schedule(500, regossip)

  // ---- scheduled faults: crashes and partitions ----
  if (cfg.crashRate) {
    const crasher = () => {
      const cands = nodes.filter(n => n.witnessKey && !n.byz && n.agreement)
      if (cands.length && rnd() < cfg.crashRate) {
        const victim = cands[Math.floor(rnd() * cands.length)]
        if (rnd() < 0.3) victim.crashOnNextPublish = true // the classic window
        else crash(victim, 'random')
      }
      schedule(700, crasher)
    }
    schedule(1500, crasher)
  }
  if (cfg.partitionRate) {
    const splitter = () => {
      // a heal scenario stops splitting after partitionUntilMs, leaving a
      // quiet tail in which convergence must be reached
      if (cfg.partitionUntilMs && clock > cfg.partitionUntilMs) return
      if (rnd() < cfg.partitionRate) {
        const names = nodes.map(n => n.name)
        const a = new Set(), b = new Set()
        for (const nm of names) (rnd() < 0.5 ? a : b).add(nm)
        if (a.size && b.size) partitions.push({ a, b, until: clock + 800 + rnd() * (cfg.maxPartitionMs ?? 2500) })
      }
      schedule(1200, splitter)
    }
    schedule(2000, splitter)
  }

  // ---- run ----
  while (heap.size && clock < durationMs) {
    const e = heap.pop()
    clock = e.t
    guard('event', () => e.fn(), 'event')
  }

  // ---- the invariant checkers ----
  const honestNodes = nodes.filter(n => !n.byz)
  const violations = []

  // S1: one hash per tick across every honest finalized log
  const byTick = new Map()
  for (const n of honestNodes) {
    const logs = n.agreement?.finalizedLog ?? n.shadow?.finalizedLog
    if (!logs) continue
    for (const [t, rec] of logs) {
      if (!byTick.has(t)) byTick.set(t, new Map())
      byTick.get(t).set(n.name, rec.resultingStateHash)
    }
  }
  for (const [t, m] of byTick)
    if (new Set(m.values()).size > 1) violations.push(`S1 FORK at tick ${t}: ${JSON.stringify([...m])}`)

  // S2: no honest witness signed two hashes for one tick — judged on the WIRE
  const signed = new Map()
  for (const a of wire.attestations) {
    if (!a || typeof a !== 'object') continue // garbage actors publish garbage; the checker reads evidence, not promises
    if (!honest.has(a.witness)) continue
    if (!P.verifyAttestationSig(a)) continue
    const k = a.witness.slice(0, 8) + '@' + a.tick
    if (!signed.has(k)) signed.set(k, new Set())
    signed.get(k).add(a.bundleHash)
  }
  for (const [k, hs] of signed)
    if (hs.size > 1) violations.push(`S2 DOUBLE-SIGN by honest witness ${k}: ${hs.size} bundle hashes`)

  // S3: every committed record verifies standalone
  for (const n of honestNodes) {
    const logs = n.agreement?.finalizedLog ?? n.shadow?.finalizedLog ?? new Map()
    for (const [, rec] of logs) {
      const err = P.verifyFinalityProof(genesis, worldId, rec)
      if (err) violations.push(`S3 INVALID CERT committed by ${n.name} at tick ${rec.tick}: ${err}`)
    }
  }

  // S4: an honest halt is only legitimate under Byzantine presence AND must
  // carry a recognized structural halt CODE with supporting evidence (final
  // freeze brief §4). A halt with no code, or an unknown code, is an
  // implementation error, not a protocol response.
  const hasByz = (cfg.byzantine ?? []).length > 0
  // halts that specifically indicate detected Byzantine behavior must carry
  // the evidence that justified them
  const BYZANTINE_HALTS = new Set([HALT.CERTIFIED_RESULT_MISMATCH, HALT.PROPOSER_EQUIVOCATION, HALT.CERTIFIED_INVALID_BUNDLE, HALT.REPLAY_MISMATCH, HALT.CONFLICTING_CERTIFICATES])
  for (const n of honestNodes) {
    if (!n.agreement?.halted) continue
    const h = n.agreement.halt_ ?? { code: n.agreement.haltCode, reason: n.agreement.haltReason, evidence: n.agreement.haltEvidence }
    if (!hasByz)
      violations.push(`S4 UNJUSTIFIED HALT: ${n.name} halted [${h.code}] (${h.reason}) with no Byzantine actor in the scenario`)
    if (!ALL_HALT.has(h.code))
      violations.push(`S4 UNCLASSIFIED HALT: ${n.name} halted with an unrecognized code (${h.code ?? 'NONE'}) — implementation error, not a protocol halt`)
    if (BYZANTINE_HALTS.has(h.code) && (!h.evidence || Object.keys(h.evidence).length === 0))
      violations.push(`S4 EVIDENCE-FREE BYZANTINE HALT: ${n.name} halted [${h.code}] without supporting evidence`)
    // §5 (rigor): the evidence must actually PROVE the reported condition —
    // not merely be present. Verify the specific proof each halt code makes.
    const proofErr = verifyHaltEvidence(h, {
      genesis, worldId,
      verifyCert: (cert) => P.verifyFinalityProof(genesis, worldId, cert),
      verifyAtt: (att) => P.verifyAttestationSig(att),
      verifyBundle: (b) => P.verifyBundleSig(b),
      bundleHash: (b) => P.bundleHash(b),
      // re-run bundle validation against the state the record claims to
      // extend (proposer selection included) — used to independently confirm
      // a certified-invalid-bundle halt rather than trusting its error string
      validateBundle: (record) => {
        try {
          const base = n.holder?.replayStates?.get(record.previousStateHash)
          if (!base) return null
          const expected = P.proposerFor(genesis, worldId, record.previousStateHash, record.tick, record.round)
          return P.validateBundle(base, worldId, record.bundle, expected)
        } catch (e) { return e.message }
      },
      // deterministic replay of a bundle against the previous state hash it
      // claims — recompute the resulting hash exactly as a witness would
      replay: (bundle) => {
        try {
          const base = n.holder?.replayStates?.get(bundle.previousStateHash)
          if (!base) return null
          return E.stateHash(E.nextState(base, bundle.inputs))
        } catch { return null }
      },
    })
    if (proofErr)
      violations.push(`S4 UNPROVEN HALT: ${n.name} halted [${h.code}] but its evidence does not prove it — ${proofErr}`)
  }

  // any unexpected exception during the run fails the scenario (brief §3)
  for (const he of harnessErrors) violations.push(`HARNESS: unexpected exception — ${he}`)

  // ---- liveness measurement (brief §4): min/max frontier + spread ----
  const heights = honestNodes.map(n => (n.agreement ?? n.shadow)?.getState?.().tick ?? n.holder.state.tick)
  const finalizedHeights = honestNodes.map(n => {
    const logs = n.agreement?.finalizedLog ?? n.shadow?.finalizedLog ?? new Map()
    return logs.size ? Math.max(...logs.keys()) + 1 : 0
  })
  const minFrontier = Math.min(...finalizedHeights)
  const maxFrontier = Math.max(...finalizedHeights)
  const spread = maxFrontier - minFrontier

  // Healed honest nodes must CONVERGE: if the network is healthy at the end
  // (no active partition, all honest witnesses alive), the finalized-height
  // spread across live honest nodes must be small. A persistent gap between
  // healthy nodes is a liveness bug, not mere asynchrony.
  const partitionActive = partitions.some(p => clock < p.until)
  const allHonestAlive = honestNodes.filter(n => n.witnessKey).every(n => n.agreement && !n.agreement.halted)
  const healed = !partitionActive && allHonestAlive && !hasByz
  // A scenario may demand EXACT convergence (requiredSpread: 0) rather than
  // the generic bounded-divergence threshold. The `heal` scenario — fault
  // burst, then a long quiet tail — asserts spread 0: every healthy node
  // reaches the SAME finalized frontier, not merely a close one.
  const requiredSpread = cfg.requiredSpread ?? 3
  if (healed && spread > requiredSpread)
    violations.push(`CONVERGENCE: healthy honest nodes diverge by ${spread} finalized ticks (min ${minFrontier}, max ${maxFrontier}) — this scenario requires spread ≤ ${requiredSpread}`)

  const frontier = Math.max(0, ...heights)
  const crashes = nodes.reduce((s, n) => s + n.crashes, 0)
  return { name, seed, frontier, minFrontier, maxFrontier, spread, requiredSpread, crashes, violations,
    harnessErrors, healed,
    attestationsOnWire: wire.attestations.length, bundlesOnWire: wire.bundles.length,
    halted: honestNodes.filter(n => n.agreement?.halted).map(n => ({ name: n.name, code: n.agreement.haltCode, reason: n.agreement.haltReason })) }
}

// ---------- scenarios ----------
export const SCENARIOS = {
  // minTicks is the SLOWEST honest node's finalized floor (convergence).
  // maxTicks is the fastest node's floor (the world advanced at all) — used
  // where a fault may legitimately leave one node mid-recovery at cutoff.
  benign:    { n: 4, q: 3, loss: 0.00, minDelay: 5,  maxDelay: 40,  dup: 0.00, minTicks: 15 },
  lossy:     { n: 4, q: 3, loss: 0.25, minDelay: 10, maxDelay: 900, dup: 0.30, minTicks: 2 },
  crashes:   { n: 4, q: 3, loss: 0.05, minDelay: 5,  maxDelay: 120, dup: 0.10, crashRate: 0.5, maxDowntime: 2500, maxTicks: 5 },
  partitions:{ n: 5, q: 3, loss: 0.05, minDelay: 5,  maxDelay: 150, dup: 0.10, partitionRate: 0.7, maxPartitionMs: 3000, maxTicks: 4 },
  equivocator:{ n: 4, q: 3, loss: 0.05, minDelay: 5, maxDelay: 100, dup: 0.05, byzantine: [{ index: 0, kind: 'equivocator' }], maxTicks: 0 },
  liar:      { n: 4, q: 3, loss: 0.05, minDelay: 5,  maxDelay: 100, dup: 0.05, byzantine: [{ index: 1, kind: 'liar' }], minTicks: 3 },
  replayer:  { n: 4, q: 3, loss: 0.05, minDelay: 5,  maxDelay: 100, dup: 0.10, byzantine: [{ index: 2, kind: 'replayer' }], minTicks: 3 },
  garbage:   { n: 4, q: 3, loss: 0.05, minDelay: 5,  maxDelay: 100, dup: 0.05, byzantine: [{ index: 3, kind: 'garbage' }], minTicks: 3 },
  // chaos: n=7, q=5, f=2 — two Byzantine actors are now WITHIN the
  // constitutional threshold (n>=3f+1=7, q>=2f+1=5, 2q-n=3>2), so the
  // scenario tests the model's guarantee rather than operating outside it.
  chaos:     { n: 7, q: 5, f: 2, loss: 0.20, minDelay: 10, maxDelay: 700, dup: 0.25, crashRate: 0.35, maxDowntime: 2500,
               partitionRate: 0.4, maxPartitionMs: 2500,
               byzantine: [{ index: 0, kind: 'equivocator' }, { index: 6, kind: 'garbage' }], maxTicks: 0 },
  // heal: a burst of early partitions, then a long quiet tail. By the end
  // the network is healthy and the CONVERGENCE invariant must hold — every
  // honest node finalized the same frontier (spread ≤ 3), and the slowest
  // still cleared a floor. This is the brief's "healed nodes must converge".
  heal:      { n: 4, q: 3, loss: 0.10, minDelay: 5, maxDelay: 200, dup: 0.10,
               partitionRate: 0.6, maxPartitionMs: 1500, partitionUntilMs: 8000, minTicks: 3, requiredSpread: 0 },
  // byzantine-max: exactly f equivocators at the constitutional boundary
  // (n=7, q=5, f=2), each actively publishing conflicting bundles and
  // double-signing. The model guarantees no fork; this scenario proves it
  // at the edge of what the configuration tolerates.
  'byzantine-max': { n: 7, q: 5, f: 2, loss: 0.05, minDelay: 5, maxDelay: 120, dup: 0.10,
               byzantine: [{ index: 0, kind: 'equivocator' }, { index: 6, kind: 'equivocator' }], minTicks: 0 },
  // lockstorm: the frontier case — equivocation TIMED WITH an early partition
  // burst (a la `heal`) so honest witnesses lock conflicting bundle hashes
  // across rounds, then a long quiet tail. The vote-lock is never released
  // except by finalization, so this is precisely where a permanent wedge could
  // hide. The model's promise is narrow but absolute: no fork (S1), no
  // double-sign (S2), and any honest halt carries standalone-verifiable
  // evidence (S3/S4). Liveness is REPORTED, not required — a provable halt is
  // an acceptable outcome here; a silent fork is not.
  lockstorm: { n: 7, q: 5, f: 2, loss: 0.10, minDelay: 5, maxDelay: 200, dup: 0.10,
               partitionRate: 0.7, maxPartitionMs: 2000, partitionUntilMs: 9000,
               byzantine: [{ index: 0, kind: 'equivocator' }, { index: 6, kind: 'equivocator' }], maxTicks: 0 },
}

// ---------- CLI ----------
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const which = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : Object.keys(SCENARIOS)
  const seeds = Number(process.argv[3] ?? 3)
  const dur = Number(process.argv[4] ?? 30000)
  let failed = 0, totalRuns = 0
  for (const name of which) {
    const cfg = SCENARIOS[name]
    if (!cfg) { console.error('unknown scenario', name); process.exit(2) }
    for (let s = 1; s <= seeds; s++) {
      const t0 = Date.now()
      const r = runScenario(name, cfg, s * 7919, dur)
      totalRuns++
      // liveness floor: minTicks bounds the SLOWEST honest node (a
      // convergence promise); maxTicks bounds the FASTEST (a "the world
      // advanced" promise) where a fault may leave a node mid-recovery
      const live = 'minTicks' in cfg
        ? r.minFrontier >= cfg.minTicks
        : r.maxFrontier >= (cfg.maxTicks ?? 0)
      const ok = r.violations.length === 0 && live
      if (!ok) failed++
      const haltStr = r.halted.map(h => `${h.name}:${h.code ?? 'NONE'}`).join(',')
      console.log(`${ok ? '✓' : '✗'} ${name.padEnd(11)} seed ${String(s).padEnd(2)} ` +
        `final[min ${String(r.minFrontier).padEnd(3)} max ${String(r.maxFrontier).padEnd(3)} spread ${String(r.spread).padEnd(2)}] ` +
        `crashes:${String(r.crashes).padEnd(3)} atts:${String(r.attestationsOnWire).padEnd(5)} ` +
        `${r.healed ? 'healed' : 'faulted'} halted:[${haltStr}] (${Date.now() - t0}ms)`)
      for (const v of r.violations) console.log('    ' + v)
      if (!live && r.violations.length === 0) console.log(`    LIVENESS below floor (${r.frontier} < ${cfg.minTicks}) — investigate`)
    }
  }
  console.log(`\n${totalRuns - failed}/${totalRuns} runs upheld the freeze criterion` + (failed ? ' — FAILURES PRESENT' : ''))
  process.exit(failed ? 1 : 0)
}
