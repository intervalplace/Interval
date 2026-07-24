# Interval. Testing & Freeze Evidence

Release 0.80.0 · protocol spec v0.80 · consensus spec v1.9 · rules hash
`a1deaf2241a1979d…`.

This document states exactly what is tested, with what inputs, for how
long. Coverage is **finite and enumerated**, the claims below are about
the specific scenarios, seeds, and durations listed, not about all
possible executions.

## Unit + property suite (`npm test`)

`node --test test/*.test.mjs`, 305 tests across:

- `engine.test.mjs`, pure state-machine transitions
- `node.test.mjs`, libp2p node boundary
- `agreement.test.mjs`, proposer rotation, quorum, lock discipline
- `safety.test.mjs`, one-vote-per-tick, intersecting quorums
- `persistence.test.mjs`, durable stores, versioned records, stale-round
- `crashsafety.test.mjs`, crash windows, durable-vote-before-broadcast
- `recovery.test.mjs`, fail-closed reads, proof-gated recovery, halt-forward
- `constitution.test.mjs`, names, items, relational validation, namespacing
- `closure.test.mjs`, execution↔validation closure; a ~190-transition
  property test asserting `validateState(nextState(...)) === null`
- `canonical.test.mjs`, trade XOR in state, slot correctness, node rules
- `prefreeze.test.mjs`, per-action canonical schemas, genesis matrix,
  SDK byte-identity, all-29-types transition closure
- `sdk.test.mjs`, every SDK action emits canonical input; gold/item trade
  helpers; malformed calls refused before signing
- `perf.test.mjs`. Phase 1 engine-scaling equivalence: native/fallback
  ed25519 backend parity (known-answer vectors, malformed material),
  bounded signature-verification cache correctness (positive and negative
  caching, collision-freedom, eviction neutrality, cold-vs-warm hash
  equality), identity-keyed state-hash memoization (memo equals the flat
  canonical hash, never crosses objects, never enters state), and the
  nextState purity discipline the memo relies on
- `rulechange.test.mjs`, that a changed constitution or founding parameter is a
  different world before any tick runs, and that a citizen who rewrites the
  engine computes a state no honest witness will certify.
- `world-freeze.test.mjs`, the founded country, pinned. A generator name is a
  promise that the name builds that landscape forever; this fails loudly if the
  promise is broken, so a silent divergence becomes a deliberate fork.
- `windows-sane.test.mjs`, the checks a browser would have made: that no window
  calls a name nothing defines, which is how two shipped bugs began.
- `identity.test.mjs`, standing and calling (spec 10): proof that both windows
  derive a citizen's identity, and the XP curve beneath it, exactly as the
  engine does, past mastery included.
- `expanse.test.mjs`, the expanse world (spec 9a): determinism, the measured
  node/mob envelope, every country present, nothing founded on water, and the
  proof that window-web's integer terrain mirror matches the engine tile for
  tile across the whole map.
- `phase2.test.mjs`. Phase 2 engine-scaling equivalence: the protocol-aware
  state clone is canonically byte-identical to the JSON round trip
  (equivalence, deep independence, absence preservation, frozen-input and
  frozen-genesis campaigns, all clone modes transition-identical), and the
  derived per-tick node indexes answer exactly what the reference scans
  answer (randomized query differentials, multi-match ordering, maintained
  context equals a fresh rebuild, indexed/unindexed and Phase-1/Phase-2
  transitions hash identically on every tick)
- `adversarial.test.mjs`, the adversarial battery as CI (see below)
- `errors.test.mjs`, typed protocol error codes: startup refusals and
  halts carry stable `ERR_*`/`HALT_*` codes with evidence
- `version.test.mjs`, every release reference agrees with `package.json`
  (README, TESTING, CONSENSUS, SPEC banners) and with the release manifest
- `lifecycle.test.mjs`, startup/shutdown lifecycle: shutdown drains all
  checkpoint I/O to genuine completion (no timeout) before releasing the
  process lock, fails closed if the final checkpoint cannot be written
  (lock retained), no writes after exclusivity release, pending-replacement
  drain, fail-safe startup cleanup, and immediate clean restart
- `startupverify.test.mjs`, bounded startup verification is the generic
  default: omitted config resolves to the shared bounded constant (never
  Infinity), explicit bounded / Infinity / zero all honored, structure
  checked on every row while cert verification is bounded, and direct
  construction matches the launcher default
- `byzantine.test.mjs`, the constitutional fault model: quorum math
  (incl. non-minimal witness sets), threshold validation, historical
  conflicting-certificate detection (immediate, after the memory window,
  and across restart via the durable finality index), cryptographic
  halt-evidence, accountable failure, AND the finality index as a
  first-class safety record: MANDATORY for production witnesses (all
  three durable stores required), store-level immutability (first append
  wins, identical idempotent, conflicting rejected, reopens see the
  original), fail-closed append/read halts, startup corruption refusal,
  long-history O(1) lookup, and recovery after an index-persist halt

## Adversarial simulation (`npm run advsim`)

`advsim.mjs` is a deterministic, seeded, event-driven network under a
hostile transport. Each run is a pure function of `(scenario, seed,
durationMs)`, identical inputs replay identically (asserted by a
determinism test).

Every witnessed scenario declares a Byzantine threshold `f` and its
actor count never exceeds it (a scenario that spawns more Byzantine
actors than `n,q,f` tolerates is rejected as a scenario bug, testing
outside the model would make a fork "expected").

**Invariants asserted every scenario, every seed:**

- **S1** no two honest nodes finalize different hashes for one tick
- **S2** no honest witness signs two bundle hashes for one tick (wire-judged)
- **S3** every committed finality record verifies standalone vs genesis
Every scenario declares a Byzantine threshold `f`; a scenario may not
spawn more Byzantine actors than `f` (the harness refuses), so the
simulator always tests behavior *inside* the constitutional model, never
outside it.

- **S4** honest nodes halt only under Byzantine presence, and only with a
  recognized structural halt CODE plus supporting evidence (an uncoded or
  evidence-free halt fails the scenario); classification is by typed code,
  not message text
- **Harness**: any unexpected exception (not a modelled safety refusal)
  fails the scenario
- **Convergence**: when the network is healthy at cutoff, honest nodes'
  finalized-height spread must be ≤ 3 (the `heal` scenario asserts spread 0)

**Scenarios** (`n` witnesses, quorum `q`):

| scenario | n/q | transport | faults | liveness floor |
|---|---|---|---|---|
| benign | 4/3 | clean |, | slowest ≥ 15 finalized |
| lossy | 4/3 | 25% loss, 10–900ms, 30% dup |, | slowest ≥ 2 |
| crashes | 4/3 | 5% loss | crash-restart, 50%/tick | fastest ≥ 5 |
| partitions | 5/3 | 5% loss | asymmetric splits 70%/tick | fastest ≥ 4 |
| equivocator | 4/3 | 5% loss | Byzantine proposer (2 bundles + double-sign) | fastest ≥ 0 |
| liar | 4/3 | 5% loss | Byzantine attester (corrupt result hash) | slowest ≥ 3 |
| replayer | 4/3 | 5% loss, 10% dup | replayed bundles/attestations | slowest ≥ 3 |
| garbage | 4/3 | 5% loss | malformed message floods | slowest ≥ 3 |
| chaos | 7/5 (f=2) | 20% loss, 10–700ms, 25% dup | crashes + partitions + 2 Byzantine | fastest ≥ 0 |
| heal | 4/3 | 10% loss | partition burst then quiet tail | slowest ≥ 3, **spread = 0** (requiredSpread) |
| byzantine-max | 7/5 (f=2) | 5% loss | two equivocators at the boundary | fastest ≥ 0, no fork |
| lockstorm | 7/5 (f=2) | 10% loss | 2 equivocators + early partition burst, then heal | no fork; halts only with evidence |

Liveness floors are deliberately conservative: under simultaneous faults
the model promises **safety always, liveness when able**. A "fastest ≥ 0"
floor means the scenario asserts only safety and convergence, not
progress, because a hard-enough fault storm may legitimately finalize
nothing while never forking.

**CI sample** (`test/adversarial.test.mjs`, 15 tests): each scenario at
seed 7919 (heal at 26s for full convergence), plus convergence-mechanism
checks (heal enforces spread 0; the check has teeth) and a determinism
check.
**Full battery**: `node advsim.mjs all 3 30000` (all scenarios × 3 seeds
× 30s). **Single scenario**: `node advsim.mjs <name> <seeds> <ms>`.

Seeds are `seed_index × 7919`; the CLI default is 3 seeds. These are the
tested seeds, other seeds are not claimed.

## Live surfaces (socket-binding; `INTERVAL_LIVE=1`)

- `npm run demo7`, 4 witnesses (q=3) + observer over **real libp2p
  gossipsub**, a **real malicious peer** flooding forged bundles,
  attestations, and garbage on the real topics, an honest witness
  **killed and restarted from durable disk stores**, and a late observer
  proof-syncing through the flood. Asserts zero forks, zero invalid
  certificates.
- `npm run e2e`, `serve` founds a 3-witness world (quorum 2); two
  `join --witness` **separate OS processes** attest from isolated working
  copies with their own durable stores. Phases: 3 witnesses advance →
  kill one, 2-of-3 still advances → restart it, resumes → kill two, the
  world halts (never forks).

Both are environment-sensitive (they bind real TCP sockets) and are
excluded from the default evidence run; set `INTERVAL_LIVE=1` to include
them in `freeze-evidence.sh`.

## Supported runtime

Node `>=22.5.0` (declared in `package.json` `engines`) the minimum for the built-in `node:sqlite` used by the production backend. The engine
resolves SHA hashing through Node's built-in `crypto` when present and
falls back to `@noble/hashes` in browsers; hashing is lazily resolved so
concurrent dynamic `import()` of the engine is race-free across Node
versions (a prior ordering bug under 22.16 is fixed). The full suite
runs under `node --test`.

## Release test structure

Split by purpose (storage brief §8):
- `npm run test:unit`, all non-adversarial suites (fast)
- `npm run test:adversarial:ci`, the deterministic adversarial CI battery
- `npm run test:adversarial:full`, `advsim all 3 30000` (long campaign, run separately)
- `npm test`, unit + adversarial CI (the release gate)

## Storage backends

The finality store is selectable behind one interface: SQLite (production default) or the flat-file append log
(`finalityBackend: 'flatfile'`, dev/compat). SQLite uses
`journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, an indexed
`(world_id, tick)` primary key, and schema-enforced append-only
immutability. `migrateFlatFileToSqlite()` performs a validated one-time
migration preserving the source as a read-only backup. Storage choice
never changes protocol records.

## Storage operations tooling

`storage-ops.mjs` operates on a witness's SQLite finality store without
touching consensus:
- `npm run storage:health <db>`, sizes, row count, WAL state, quick_check
- `node storage-ops.mjs integrity <db>`, full `PRAGMA integrity_check`
- `npm run storage:backup <db> <dest>`, consistent online backup (VACUUM INTO), verified
- `npm run storage:verify <db> [worldId]`, validate a backup/restore

## Large-history benchmark

`node bench-storage.mjs [ticks] [sqlite|flatfile]` builds a synthetic
history and measures append throughput, indexed lookup, startup
validation, integrity check, and online backup. At 1,000,000 ticks the
SQLite backend measures (on this environment): batched append ≈168k
rows/s, random lookup ≈15 µs, ≈402 bytes/row, integrity quick_check
≈275 ms, online backup ≈4.8 s. Bounded startup validation is ≈0.4 s vs
≈22 s unbounded, startup is constant-time in history length.

## Reproducible evidence (`npm run evidence`)

`freeze-evidence.sh` captures runtime environment, dependency lockfile,
exact commands, per-stage exit codes, and full logs into
`freeze-evidence/`. Its own exit code is nonzero if any stage failed, so
it doubles as the freeze gate.

```
npm ci                             # exact reproduction from the committed lockfile
npm run evidence                   # core suites
INTERVAL_LIVE=1 npm run evidence   # + live libp2p and multi-process E2E
```
