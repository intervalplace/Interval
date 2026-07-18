// Typed protocol error codes (final freeze brief §3/§4). Safety-critical
// failures — refused startups, rejected recoveries, and halts — carry a
// stable CODE, not just a message. The adversarial harness and any operator
// tooling classify by code; the human-readable message is for people. A
// throw or halt without a recognized code is, by definition, unexpected.
//
// IntervalError is a plain Error subclass with a `.code`. `throwCoded` and
// the HALT_* constants keep the codes in one place so a reviewer can audit
// the entire failure surface here rather than grepping messages.

export const ERR = {
  // ---- recovery / startup refusals (fail-closed) ----
  WORLD_MISMATCH: 'ERR_WORLD_MISMATCH',           // a safety record for another world
  FRONTIER_ROLLBACK: 'ERR_FRONTIER_ROLLBACK',     // state behind/at a finalized frontier
  FRONTIER_AHEAD_UNPROVEN: 'ERR_FRONTIER_AHEAD_UNPROVEN', // ahead of frontier, no cert path
  CORRUPT_LOCK: 'ERR_CORRUPT_LOCK',               // vote-lock unreadable/malformed
  CORRUPT_FRONTIER: 'ERR_CORRUPT_FRONTIER',       // frontier unreadable/malformed
  CORRUPT_FINALITY_INDEX: 'ERR_CORRUPT_FINALITY_INDEX', // accountability index corrupt at startup
  INVALID_BACKEND: 'ERR_INVALID_BACKEND',         // unknown finality storage backend requested
  CORRUPT_SAFETY_RECORD: 'ERR_CORRUPT_SAFETY_RECORD', // generic durable-store corruption
  INVALID_CHECKPOINT: 'ERR_INVALID_CHECKPOINT',   // witness checkpoint invalid; refuse re-found
  INVALID_GENESIS: 'ERR_INVALID_GENESIS',         // founding record fails validation
  INVALID_BUILT_STATE: 'ERR_INVALID_BUILT_STATE', // buildWorld produced invalid/ambiguous state
  CORRUPT_IDENTITY: 'ERR_CORRUPT_IDENTITY',       // identity file corrupt/forged
  MISSING_STORES: 'ERR_MISSING_STORES',           // witness without durable stores
  CHECKPOINT_REJECTED: 'ERR_CHECKPOINT_REJECTED', // synced checkpoint failed verification
  CHECKPOINT_UNCORROBORATED: 'ERR_CHECKPOINT_UNCORROBORATED', // peers disagree, unproven world
}

// ---- halt codes (a running node stops rather than forks) ----
export const HALT = {
  CERTIFIED_RESULT_MISMATCH: 'HALT_CERTIFIED_RESULT_MISMATCH', // a quorum certified a result ≠ local replay
  PROPOSER_EQUIVOCATION: 'HALT_PROPOSER_EQUIVOCATION', // same proposer+round signed two different bundles
  CONFLICTING_CERTIFICATES: 'HALT_CONFLICTING_CERTIFICATES', // two valid certs for one finalized tick
  CERTIFIED_INVALID_BUNDLE: 'HALT_CERTIFIED_INVALID_BUNDLE', // quorum certified a bad bundle
  REPLAY_MISMATCH: 'HALT_REPLAY_MISMATCH',         // local replay ≠ quorum result
  FRONTIER_PERSIST_FAILED: 'HALT_FRONTIER_PERSIST_FAILED', // durable frontier write failed
  FINALITY_INDEX_PERSIST_FAILED: 'HALT_FINALITY_INDEX_PERSIST_FAILED', // durable finality-index append failed
  FINALITY_INDEX_READ_FAILED: 'HALT_FINALITY_INDEX_READ_FAILED', // historical index unreadable
  FINALITY_INDEX_CORRUPT: 'HALT_FINALITY_INDEX_CORRUPT', // index has a conflicting/invalid entry
  STATE_ADOPTION_FAILED: 'HALT_STATE_ADOPTION_FAILED',     // setState threw post-frontier
  CALLBACK_FAILED: 'HALT_CALLBACK_FAILED',         // post-finality callback threw
}

export const ALL_ERR = new Set(Object.values(ERR))
export const ALL_HALT = new Set(Object.values(HALT))

// Phase-1 freeze §2: ONE implementation-wide default for bounded startup
// certificate verification, shared by IntervalNode, IntervalAgreement, and the
// public launchers (serve/join). Startup re-verifies the signatures/quorum of
// the most recent N finality records; older records are immutable and were
// verified when first accepted, so re-verifying all history every boot is
// unnecessary and eventually impractical as history grows. An omitted
// configuration ALWAYS resolves to this bounded value, never to Infinity.
// Infinity is an explicit full-history AUDIT mode, never a silent fallback.
// This bounds only CERTIFICATE verification; structural + hash integrity is
// still checked on every retained row (a separate, cheap scan) — database
// integrity checking is kept distinct from recent-tail cert verification.
export const DEFAULT_STARTUP_VERIFY_RECENT_N = 10000

export class IntervalError extends Error {
  constructor(code, message, evidence) {
    super(message)
    this.name = 'IntervalError'
    this.code = code
    if (evidence) this.evidence = evidence
  }
}

export function throwCoded(code, message, evidence) {
  throw new IntervalError(code, message, evidence)
}

// classify any caught value: returns its code, or null if uncoded/unexpected
export function codeOf(e) {
  return (e && typeof e === 'object' && typeof e.code === 'string' && (ALL_ERR.has(e.code) || ALL_HALT.has(e.code)))
    ? e.code : null
}
