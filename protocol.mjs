// Interval protocol layer (fix brief Milestone 4, §1) — schemas, canonical
// encodings, hashes, signature domains, and limits for certified interval
// bundles. Pure functions only: no networking, no clocks, no state.
//
// The objects on the wire:
//
//   IntervalBundle (proposed by the round's witness):
//     { v, worldId, tick, round, previousStateHash, proposer, inputs[], sig }
//   Attestation (signed by each verifying witness):
//     { v, worldId, tick, round, bundleHash, resultingStateHash, witness, sig }
//   FinalityRecord (a bundle + a quorum of matching attestations):
//     { tick, round, previousStateHash, bundleHash, resultingStateHash,
//       bundle, attestations[] }
//
// The proposer cannot invent player actions (every input stays
// player-signed) and cannot forge outcomes (every witness recomputes the
// transition before signing). Finality is the quorum, not the clock.

import E from './engine.js'

export const PROTOCOL_VERSION = 2

export const BUNDLE_DOMAIN = 'INTERVAL_BUNDLE_V1|'
export const ATTESTATION_DOMAIN = 'INTERVAL_ATTESTATION_V1|'

export const HEX64 = /^[0-9a-f]{64}$/

export const AGREEMENT = {
  ROUND_TIMEOUT_MS: 600,          // a vanished proposer costs one round, not the world
  ROUND_BACKOFF_CAP: 6,           // exponential round windows, capped at 2^6
  MAX_SKEW_MS: 150,               // clock slack when judging round windows
  MAX_INPUTS_PER_PLAYER: 2,       // one action + at most one equivocation proof
  MAX_INPUTS_PER_BUNDLE: 4096,
  MAX_BUNDLE_BYTES: 1024 * 1024,
  MAX_ATTESTATION_BYTES: 2 * 1024,
  MAX_FINALITY_BYTES: 2 * 1024 * 1024,
  MAX_FINALIZED_HISTORY: 512,     // in-memory certified-bundle log retention
  MAX_CATCHUP_RECORDS: 64,        // finality records per replay response
  MAX_PENDING_TICKS: 64,          // distinct future ticks accepting inputs
  MAX_PROPOSALS_PER_TICK: 16,     // verified bundles held per interval
}

// ---------- constitutional quorum safety (CONSENSUS.md §1) ----------
// Byzantine Safety Upgrade: quorum INTERSECTION (2q > n) is not enough — the
// intersection can be a single witness who, if Byzantine, double-signs into
// conflicting certificates. The constitutional fault model fixes a threshold
// f and requires n >= 3f+1, q >= 2f+1, and 2q-n > f, so every quorum
// intersection holds >= f+1 witnesses and thus at least one honest one.
// Checked at world construction AND inside every proof verification.
export function quorumSafe(genesis) {
  const n = Array.isArray(genesis.witnesses) ? genesis.witnesses.length : 0
  const q = genesis.quorum
  const f = genesis.byzantineTolerance
  return E.byzantineSafe(n, q, f)
}

// ---------- input identity ----------
// The hash covers the SIGNED input, so two different signatures over the
// same action are two distinct inputs — which is exactly what equivocation
// evidence needs (fix brief §4.2).
export function inputHash(input) {
  return E.sha256(Buffer.from(E.canonical(input))).toString('hex')
}

// Canonical bundle order (fix brief Stage D): by playerId, then inputHash.
export function sortInputs(inputs) {
  return [...inputs].sort((a, b) => {
    if (a.playerId !== b.playerId) return a.playerId < b.playerId ? -1 : 1
    const ha = inputHash(a), hb = inputHash(b)
    return ha < hb ? -1 : ha > hb ? 1 : 0
  })
}

// Bundle building by WHOLE player groups (CONSENSUS.md §3): players in
// ascending order, each player's (<=2) versions together or not at all.
// A detected equivocation pair is never split by the cap — including only
// one side would silently launder an equivocation into a normal action.
export function selectBundleInputs(byPlayer, cap = AGREEMENT.MAX_INPUTS_PER_BUNDLE) {
  const out = []
  for (const pid of [...byPlayer.keys()].sort()) {
    const group = sortInputs([...byPlayer.get(pid).values()])
    if (out.length + group.length > cap) break
    out.push(...group)
  }
  return out // globally canonical: players ascend, hashes ascend within
}

// ---------- equivocation evidence (CONSENSUS.md §2, §7) ----------
export function inputEquivocationEvidence(a, b) {
  if (!a || !b || a.playerId !== b.playerId || a.tick !== b.tick) return null
  const ha = inputHash(a), hb = inputHash(b)
  if (ha === hb) return null
  if (!E.verifyInputSig(a) || !E.verifyInputSig(b)) return null
  const [A, B] = ha < hb ? [a, b] : [b, a]
  return { type: 'input-equivocation', playerId: a.playerId, tick: a.tick, inputA: A, inputB: B }
}

export function proposerEquivocationEvidence(a, b) {
  if (!a || !b || a.proposer !== b.proposer || a.tick !== b.tick || a.round !== b.round || a.worldId !== b.worldId) return null
  if (bundleHash(a) === bundleHash(b)) return null
  if (!verifyBundleSig(a) || !verifyBundleSig(b)) return null
  const [A, B] = bundleHash(a) < bundleHash(b) ? [a, b] : [b, a]
  return { type: 'proposer-equivocation', tick: a.tick, round: a.round, proposer: a.proposer, bundleA: A, bundleB: B }
}

// ---------- bundles ----------
function bundleCore(b) {
  return {
    v: b.v, worldId: b.worldId, tick: b.tick, round: b.round,
    previousStateHash: b.previousStateHash, proposer: b.proposer, inputs: b.inputs,
  }
}

export function bundlePayload(b) {
  return Buffer.from(BUNDLE_DOMAIN + E.canonical(bundleCore(b)))
}

export function bundleHash(b) {
  return E.sha256(bundlePayload(b)).toString('hex')
}

export function makeBundle({ worldId, tick, round, previousStateHash, inputs, witness }) {
  const core = {
    v: PROTOCOL_VERSION, worldId, tick, round, previousStateHash,
    proposer: witness.playerId, inputs: sortInputs(inputs),
  }
  return { ...core, sig: E.signPayload(bundlePayload(core), witness.privateKey) }
}

export function verifyBundleSig(b) {
  if (typeof b?.sig !== 'string' || typeof b?.proposer !== 'string') return false
  return E.verifyPayload(b.sig, bundlePayload(b), b.proposer)
}

// ---------- attestations ----------
function attCore(a) {
  return {
    v: a.v, worldId: a.worldId, tick: a.tick, round: a.round,
    bundleHash: a.bundleHash, resultingStateHash: a.resultingStateHash, witness: a.witness,
  }
}

export function attestationPayload(a) {
  return Buffer.from(ATTESTATION_DOMAIN + E.canonical(attCore(a)))
}

export function makeAttestation({ worldId, tick, round, bundleHash: bh, resultingStateHash, witness }) {
  const core = {
    v: PROTOCOL_VERSION, worldId, tick, round,
    bundleHash: bh, resultingStateHash, witness: witness.playerId,
  }
  return { ...core, sig: E.signPayload(attestationPayload(core), witness.privateKey) }
}

export function verifyAttestationSig(a) {
  if (typeof a?.sig !== 'string' || typeof a?.witness !== 'string') return false
  return E.verifyPayload(a.sig, attestationPayload(a), a.witness)
}

// ---------- round schedule (adversarial-sim finding) ----------
// Rounds open with EXPONENTIAL backoff: round r starts at
//   due(tick) + ROUND_TIMEOUT_MS * (2^min(r, CAP) - 1)
// Under heavy loss/delay, flat rounds spawn a fresh competing bundle
// every 600 ms, and honest lock splits (H2) stall ticks within seconds.
// Geometric windows give lock REBROADCAST time to converge the earliest
// bundle before a new proposer authors a rival — a pure liveness change:
// the locking rule, and therefore safety, is untouched.
export function roundStartMs(round) {
  // round r's window is RT·2^min(r,CAP): backoff caps the WINDOW LENGTH;
  // the schedule keeps advancing linearly at the capped width beyond it
  const RT = AGREEMENT.ROUND_TIMEOUT_MS, C = AGREEMENT.ROUND_BACKOFF_CAP
  if (round <= C) return RT * (Math.pow(2, round) - 1)
  return RT * ((Math.pow(2, C) - 1) + (round - C) * Math.pow(2, C))
}
export function roundAt(elapsedMs) {
  if (elapsedMs < 0) return -1
  let r = 0
  while (roundStartMs(r + 1) <= elapsedMs) r++
  return r
}

// ---------- proposer rotation (fix brief, Option 2) ----------
// proposerIndex = (H(worldId || previousStateHash || tick) + round) mod n
// Round 0's proposer is unpredictable-but-deterministic; each fallback
// round walks to the next witness in canonical (genesis) order.
export function proposerIndex(worldId, previousStateHash, tick, round, witnessCount) {
  const h = E.sha256(Buffer.from(worldId + '|' + previousStateHash + '|' + tick))
  const base = h.readUInt32BE(0) % witnessCount
  return (base + round) % witnessCount
}

export function proposerFor(genesis, worldId, previousStateHash, tick, round) {
  const ws = genesis.witnesses
  return ws[proposerIndex(worldId, previousStateHash, tick, round, ws.length)]
}

// ---------- bundle validation (what a witness checks before attesting) ----------
// Returns an error string, or null when the bundle is well-formed for
// `state`. Game-rule validity of each input is NOT judged here — the
// engine ignores rule-invalid inputs deterministically — but signature,
// world, tick, ordering, and equivocation-cap rules are structural and
// every witness must enforce them identically.
export function validateBundle(state, worldId, bundle, expectedProposer) {
  if (!bundle || typeof bundle !== 'object') return 'malformed'
  if (bundle.v !== PROTOCOL_VERSION) return 'wrong protocol version'
  if (bundle.worldId !== worldId) return 'wrong world'
  if (!Number.isInteger(bundle.tick) || bundle.tick !== state.tick) return 'wrong tick'
  if (!Number.isInteger(bundle.round) || bundle.round < 0) return 'bad round'
  if (typeof bundle.previousStateHash !== 'string' || !HEX64.test(bundle.previousStateHash)) return 'malformed lineage hash'
  if (typeof bundle.proposer !== 'string' || !HEX64.test(bundle.proposer)) return 'malformed proposer'
  if (bundle.previousStateHash !== E.stateHash(state)) return 'wrong lineage'
  if (expectedProposer && bundle.proposer !== expectedProposer) return 'wrong proposer for round'
  if (!verifyBundleSig(bundle)) return 'bad proposer signature'
  if (!Array.isArray(bundle.inputs)) return 'malformed inputs'
  if (bundle.inputs.length > AGREEMENT.MAX_INPUTS_PER_BUNDLE) return 'too many inputs'
  const perPlayer = new Map()
  let prevKey = ''
  for (const inp of bundle.inputs) {
    if (!inp || typeof inp !== 'object') return 'malformed input'
    if (inp.worldId !== worldId) return 'input for wrong world'
    if (inp.tick !== bundle.tick) return 'input for wrong tick'
    if (typeof inp.playerId !== 'string' || !/^[0-9a-f]{64}$/.test(inp.playerId)) return 'malformed player id'
    if (E.validateInputShape(inp) !== null) return 'non-canonical input shape' // one form per action (rev7 §4)
    if (!E.verifyInputSig(inp)) return 'invalid input signature'
    const key = inp.playerId + '|' + inputHash(inp)
    if (key <= prevKey) return 'inputs not in canonical order' // also catches duplicates
    prevKey = key
    const n = (perPlayer.get(inp.playerId) ?? 0) + 1
    if (n > AGREEMENT.MAX_INPUTS_PER_PLAYER) return 'equivocation cap exceeded'
    perPlayer.set(inp.playerId, n)
  }
  return null
}

// ---------- finality proof verification (CONSENSUS.md §6.2) ----------
// THE one verifier: live finality, checkpoints, and catch-up replay all
// trust a record only through this function. A record proves finality iff
// a safe quorum of DISTINCT genesis witnesses signed the same
// (bundleHash, resultingStateHash) at the bundle's own round, for a
// bundle that is hash-bound to the record, signed by the CONSTITUTIONAL
// proposer for (previousStateHash, tick, round). Proposer verification is
// never bypassed just because a quorum exists (remaining-fixes brief §6).
export function verifyFinalityProof(genesis, worldId, record) {
  if (!record || typeof record !== 'object') return 'malformed'
  if (!quorumSafe(genesis)) return 'Byzantine-unsafe quorum configuration (need n>=3f+1, q>=2f+1, 2q-n>f)'
  if (!Number.isInteger(record.tick) || record.tick < 0) return 'malformed tick'
  if (!Number.isInteger(record.round) || record.round < 0) return 'malformed round'
  if (typeof record.previousStateHash !== 'string' || !HEX64.test(record.previousStateHash)) return 'malformed lineage'
  if (typeof record.bundleHash !== 'string' || !HEX64.test(record.bundleHash)) return 'malformed hashes'
  if (typeof record.resultingStateHash !== 'string' || !HEX64.test(record.resultingStateHash)) return 'malformed hashes'

  // the bundle is mandatory and hash-bound: a proof floats free of nothing
  const b = record.bundle
  if (!b || typeof b !== 'object') return 'record carries no bundle'
  if (bundleHash(b) !== record.bundleHash) return 'bundle does not match proof'
  if (b.v !== PROTOCOL_VERSION) return 'bundle wrong protocol version'
  if (b.worldId !== worldId) return 'bundle for wrong world'
  if (b.tick !== record.tick) return 'bundle tick does not match record'
  if (b.round !== record.round) return 'bundle round does not match record'
  if (b.previousStateHash !== record.previousStateHash) return 'bundle lineage does not match record'
  if (b.proposer !== proposerFor(genesis, worldId, record.previousStateHash, record.tick, record.round))
    return 'bundle proposer is not the constitutional proposer'
  if (!verifyBundleSig(b)) return 'bad proposer signature'

  // canonical proof form (final-fixes brief §8): EXACTLY quorum
  // attestations, strictly ascending by witness key. One certificate has
  // one byte representation; oversized or shuffled proof sets are refused
  // before any signature is checked.
  if (!Array.isArray(record.attestations)) return 'no attestations'
  if (record.attestations.length !== genesis.quorum) return 'non-canonical proof: need exactly quorum attestations'
  const wset = new Set(genesis.witnesses)
  const seen = new Set()
  let prevW = ''
  for (const a of record.attestations) {
    if (typeof a?.witness !== 'string' || !HEX64.test(a.witness)) return 'malformed witness'
    if (a.witness <= prevW) return 'non-canonical proof: attestations not in witness order'
    prevW = a.witness
    if (!a || a.v !== PROTOCOL_VERSION || a.worldId !== worldId) return 'attestation for wrong world'
    if (a.tick !== record.tick) return 'attestation for wrong tick'
    if (a.round !== record.round) return 'attestation for different round'
    if (a.bundleHash !== record.bundleHash) return 'attestation for different bundle'
    if (a.resultingStateHash !== record.resultingStateHash) return 'attestation for different result'
    if (!wset.has(a.witness)) return 'attestation from non-witness'
    if (seen.has(a.witness)) return 'duplicate witness'
    if (!verifyAttestationSig(a)) return 'bad attestation signature'
    seen.add(a.witness)
  }
  if (seen.size < genesis.quorum) return 'below quorum'
  return null
}
