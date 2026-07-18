# Interval Consensus Specification v1.9 (Byzantine Safety Upgrade)

*Release 0.23.0 · protocol spec v0.68 · rules hash `9438fd2d07d4c2cd…`*

**Certified Interval Bundles — the agreement protocol for authoritative worlds.**

This document is normative for the agreement layer (`protocol.mjs`,
`agreement.mjs`). The game rules live in SPEC.md ("the constitution",
v0.47); this document defines how a network of nodes decides *which*
inputs each interval contains and *when* a state is final. Where the code
and this document disagree, this document is the protocol and the code
has a bug.

- Implementation release: `package.json` version `0.23.0`
- Constitution version: SPEC.md header `v0.47` (rules hash binds it)
- Consensus specification version: `v1.9` (this document)
- Wire protocol version: `PROTOCOL_VERSION = 2` (`protocol.mjs`)
- World identity: `worldId = SHA-256(canonical(genesis))`, full hex

These four version lines move together: any change to one is a new
release. The single source of truth for the release tuple is
`package.json` (`version` and the `protocol` block); this header must
match it.

---

## 1. Model and assumptions

**Participants.** A world is founded with an ordered, immutable
**witness set** `W` (`genesis.witnesses`, ed25519 public keys,
`n = |W|`) and a **quorum** `q` (`genesis.quorum`). Everyone else is an
**observer**: observers verify everything and sign nothing. Players sign
inputs; player keys and witness keys are unrelated roles (one key may
serve both).

**Byzantine quorum safety (constitutional).** A witnessed genesis fixes
an explicit fault threshold `f` (`genesis.byzantineTolerance`), and is
valid only if

```
n ≥ 3f + 1        q ≥ 2f + 1        2q − n > f        1 ≤ q ≤ n
```

These together guarantee that any two quorums intersect in **at least
`f + 1`** witnesses: since at most `f` are Byzantine, every pair of
quorums shares **at least one honest witness**. Because an honest
witness holds a durable vote lock (§4) and never signs two bundles for
one tick, two conflicting certificates for the same tick are impossible
unless **more than `f`** witnesses violate the constitution — at which
point both certificates are portable, attributable evidence (§7). Nodes
MUST refuse to operate in, and verifiers MUST refuse proofs from, a
world violating this. (A solo world `n = 1, q = 1, f = 0` satisfies it;
`f = 0` degenerates to crash-only tolerance.) The witnessed triple
`witnesses`, `quorum`, `byzantineTolerance` is supplied together or not
at all.

> **Correction (Byzantine Safety Upgrade).** Earlier revisions required
> only quorum *intersection*, `2q > n`, and described that as Byzantine
> fault tolerance. That was wrong. `2q > n` guarantees quorums share at
> least one witness, but that witness can be a single Byzantine actor who
> double-signs, producing two conflicting certificates each backed by a
> valid quorum — a fork. Concretely, `n = 5, q = 3` has intersection
> `2q − n = 1`: one malicious witness in that intersection forks the
> world. Genuine Byzantine tolerance requires `n ≥ 3f + 1` and
> `q ≥ 2f + 1`, so the intersection is `≥ f + 1` and thus contains an
> honest witness. The constitution above is the corrected rule; `f = 0`
> recovers the old behavior honestly labeled as crash-only.

**Network.** Asynchronous, unreliable delivery: messages may be delayed,
duplicated, reordered, or lost. Gossip topics carry bundles,
attestations, and finality records; request/response streams carry
checkpoints and replay. **Safety never depends on timing.** Liveness
assumes partial synchrony: quorum-many honest witnesses eventually
connected with bounded delay.

**Fault model — stated plainly.** With a genesis threshold `f`, this
protocol is **Byzantine-fault-tolerant up to `f` witnesses**:

- Safety against *crashes, restarts, partitions, delays, duplication,
  reordering*: unconditional, via vote locking (§4) and the quorum
  constitution.
- Safety against *up to `f` Byzantine witnesses*: two conflicting
  finality certificates for one tick would require more than `f`
  witnesses to double-sign (violate their locks), because every quorum
  intersection contains `≥ f + 1` witnesses of whom `≤ f` are Byzantine.
  Every double-signature is portable evidence (§7); a node that ever
  sees two valid certificates for one finalized tick halts with both as
  attributable proof (`HALT_CONFLICTING_CERTIFICATES`).
- Beyond `f` Byzantine witnesses, safety is not guaranteed — but a fork
  still leaves cryptographic proof naming the violators.
- A quorum coalition can also *censor* inputs or *stall* the world.
  Choose `n` and `f` accordingly; the witness set is a founding, trusted
  role.

**Beyond-model behavior = halt.** A node that observes evidence outside
the model (conflicting certificates, a certified transition it cannot
reproduce, a certified structurally-invalid bundle) MUST halt: refuse
further finalization, preserve the evidence, recover only by human
decision (§9). A stopped world, never two worlds.

---

## 2. Objects

All encodings are `canonical(...)`: recursively key-sorted JSON over
null, booleans, finite numbers, strings, arrays, and plain objects.
Encoders MUST reject `undefined`, `NaN`, `±Infinity`, and any other
type. All signatures are ed25519 over `DOMAIN || canonical(object
without sig)`.

**SignedInput** — a player action:
`{ worldId, tick, playerId, type, ..., sig }`, domain
`INTERVAL_INPUT_V1|`. `inputHash = SHA-256(canonical(signed input))` —
it covers the signature, so re-signing the same action yields a distinct
input (this is what makes equivocation provable).

**IntervalBundle** — the proposed canonical input set for one tick:

```
{ v, worldId, tick, round, previousStateHash, proposer, inputs[], sig }
```

domain `INTERVAL_BUNDLE_V1|`; `bundleHash` = SHA-256 over that domain
payload. `inputs` MUST be sorted by `(playerId, inputHash)`, contain at
most `MAX_INPUTS_PER_PLAYER = 2` inputs per player and at most
`MAX_INPUTS_PER_BUNDLE` total, and every input MUST be
signature-valid, for this world, for this tick.

**Attestation** — one witness's vote:

```
{ v, worldId, tick, round, bundleHash, resultingStateHash, witness, sig }
```

domain `INTERVAL_ATTESTATION_V1|`. `resultingStateHash` is the hash the
witness itself computed by applying the bundle to its finalized state.

**FinalityRecord** — the portable proof:

```
{ tick, round, previousStateHash, bundleHash, resultingStateHash,
  bundle, attestations[] }
```

**VoteLock** — a witness's durable promise (§4):
`{ format: "interval-witness-lock-v1", worldId, tick, bundleHash, bundle,
attestation }`. Durable safety records (the vote lock, the frontier, the finality index) are
VERSIONED and schema-checked on load: exact format string, exact field
types, exact lowercase-hex hash formats. An unversioned or malformed
record refuses startup; it is never guessed at.

**InputEquivocationEvidence** — `{ type: 'input-equivocation', playerId,
tick, inputA, inputB }` where both inputs are signature-valid, same
player, same tick, different `inputHash`, ordered by hash.

**ProposerEquivocationEvidence** — `{ type: 'proposer-equivocation',
tick, round, proposer, bundleA, bundleB }`: two validly-signed bundles,
same `(worldId, tick, round, proposer)`, different hashes.

---

## 3. Schedule, rounds, proposers

`due(t) = anchorMs + (t + 1) · TICK_MS`. The schedule **paces**; it
never finalizes. Round `r ≥ 0` for tick `t` opens locally at
`due(t) + r · ROUND_TIMEOUT_MS`; a node accepts a round-`r` bundle only
at or after that time minus `MAX_SKEW_MS`. Two clocks are exposed and
never conflated: `scheduledTick` (what local time predicts) and the
finalized tick (what quorum evidence proves).

```
proposer(t, r) = W[ (H(worldId ‖ previousStateHash(t) ‖ t) + r) mod n ]
```

Round 0's proposer is deterministic but unpredictable before
`previousStateHash(t)` exists; each later round walks one step through
`W` in founding order. **A witness proposes only for the CURRENT
round**: rounds whose windows have already passed when it looks (a late
start, a long GC pause) are ceded, never proposed — a stale proposal
only competes with whatever the live network already locked on and
widens lock splits.

**Proposal rule.** When round `r` opens, `proposer(t, r)` — if it holds
no lock for `t` — builds a bundle from its pending inputs and publishes
it. **Bundle building is by whole player groups**: players in ascending
`playerId` order, each player's (≤ 2) input versions included together
or not at all, stopping before the cap. An equivocation pair is never
split.

---

## 4. The locking rule (safety core)

Each witness maintains at most one **VoteLock** per tick:

- **LOCK-1 (first vote locks).** On the first bundle for tick `t` that
  passes full validation (§6.1), the witness computes the transition,
  writes the VoteLock **durably to disk (write, fsync, atomic rename)**,
  and only then broadcasts its attestation.
- **LOCK-2 (one hash per tick, ever).** While a lock for `t` exists, the
  witness MUST NOT sign any attestation for a different `bundleHash` at
  tick `t` — *regardless of round*. The same bundle may be re-attested
  and re-broadcast freely.
- **LOCK-3 (restart).** On startup, a witness reloads its lock. A
  restored lock is untrusted bytes until verified IN FULL against the
  current state: bundle hash binding, bundle structure, constitutional
  proposer, proposer signature, attestation fields and signature
  (including that it is OUR key), lineage, and a local replay
  reproducing the attested result. A verified lock at the current
  frontier binds the witness to rebroadcast-only; an INVALID lock
  refuses startup entirely (a corrupted lock must neither poison the
  witness nor be silently discarded — discarding re-opens
  double-signing; a human decides). A lock for an already-finalized
  tick is archived and ignored.

**The rollback frontier.** The lock protects the current tick; the
frontier protects history. Finalization is FAIL-CLOSED, in this order:
(1) verify finality; (2) persist the frontier
`{worldId, tick, resultingStateHash}` DURABLY (write, fsync, rename,
fsync directory — as for locks); (3) update in-memory state; (4) retire
the spent vote lock into the history journal
(`<lockfile>.history/<tick>-<bundleHash>.json`, unique names, rename
fsynced, bounded window; a journal failure is hygiene, not safety, and
is tolerated); (5) checkpointing and callbacks. If step (2) fails, the
witness HALTS with its active vote lock intact and adopts nothing — a
cleared lock over an unrecorded finality is precisely the crash window
that re-opens historical re-signing.

On startup: a state at or behind the frontier tick REFUSES to start
(restarting a witness from a stale checkpoint would re-run, and
re-sign, finalized intervals). A state exactly AT the frontier height
must also HASH to the frontier's `resultingStateHash` — height alone is
not identity, and a same-height impostor state is refused. A state
AHEAD of the frontier is admitted only through a certified recovery
path: a valid §6.2 finality proof for exactly that state (the disk
checkpoint's own proof, verified). Recovery from any refusal is syncing
a current certified checkpoint, never deleting the frontier.

**Safety-record namespacing (rev5).** Safety records live in a
world-namespaced directory —
`<safetyDir>/<worldId>/{active-lock.json, frontier.json,
active-lock.json.history/}` — so reusing a filesystem path across worlds
cannot cross records. A schema-valid record whose embedded `worldId`
differs from the running world (path reuse, tampering) REFUSES startup;
mismatched-world records are never silently ignored.

**Checkpoint durability policy (documented).** Checkpoints are
BEST-EFFORT operational state: consensus safety depends only on the
durable vote lock and frontier. A lost checkpoint costs a re-sync,
never a double-sign; its directory fsync is therefore non-strict by
design.

**Fail-closed persistence discipline.**
- Reading a safety record fails CLOSED: a missing file means "no
  record"; a corrupt, truncated, empty, unreadable, or
  permission-denied file REFUSES startup with the file preserved —
  trouble is never treated as absence.
- Directory fsync after renaming a consensus record (lock, frontier) is
  STRICT: a platform where it fails cannot host a production witness.
  Best-effort fsync is acceptable only for non-consensus artifacts
  (checkpoints, journal archives).
- A production witness REQUIRES all THREE durable safety stores — the
  vote lock, the finality frontier, AND the finality index; in-memory
  stores exist only behind an explicit testing flag. The finality index
  is a safety record (historical accountability), so it is mandatory,
  not optional: a witness that cannot durably record the history needed
  to detect a future conflicting certificate is refused startup, exactly
  as one missing its lock or frontier is.
- A witness holds an EXCLUSIVE, kernel-held process-lifetime lock for
  its `(worldId, witnessId)` before the agreement layer starts (storage
  brief §1; final review §2; production brief §1). Safety records live
  under `witness-safety/<worldId>/<witnessId>/`, and the lock is a
  Unix-domain socket (`process.lock.sock`) bound there: the KERNEL
  guarantees exclusive ownership of a live address ON THAT HOST and
  releases it automatically when the holder dies — no PID guessing, no
  unsafe reclamation. This is a HOST-LOCAL lock, not a distributed one.
  The supported operating model (production brief §1, Option A) is:
  **one witness identity == one host**; safety directories live on
  local, non-shared storage; shared/NFS safety directories are
  unsupported, and failover requires fencing the old host. A witness
  started on a detected network filesystem logs a warning. Within a
  host, a second live process for the same identity is refused
  (`ERR_WITNESS_LOCK_HELD`) so it can never emit an attestation and race
  the first into a double-sign; a stale socket path from a crashed or
  force-killed process is reclaimed only after a connect-probe proves no
  live listener remains.
- A witness whose existing checkpoint is unreadable or invalid REFUSES
  startup rather than silently recreating genesis (a fresh tick-0 state
  under a durable frontier is exactly the rollback the frontier
  refuses). Observers may found fresh and resynchronize.
- If state adoption or post-finality callbacks fail AFTER the frontier
  is persisted, the node halts FORWARD: the frontier stands, is never
  rolled back, and recovery is a certified checkpoint at or past it.

While a tick is unfinalized, a locked witness rebroadcasts its locked
bundle and attestation every `ROUND_TIMEOUT_MS / 2` so late or healed
peers converge on the earliest lock.

**Why this is safe.** Suppose records `R ≠ R'` are both final for tick
`t`. Each carries `q` distinct witness signatures; the signer sets
intersect in `≥ 2q − n > f` witnesses — that is, **at least `f + 1`** —
each of which would have to sign two different bundle hashes for one
tick, impossible for a witness obeying LOCK-1..3 (durability makes
crash-and-forget no excuse). Since at most `f` witnesses are Byzantine,
at least one honest witness sits in every intersection, so conflicting
finality is impossible within the fault model. Beyond it, conflicting
finality requires more than `f` lock-violating witnesses, and their
double-signatures are self-authenticating, attributable evidence.

---

## 5. Attestation, finality, mismatch

A witness receiving a bundle: checks the round is open, the sender is
`proposer(t, r)`, validates it fully (§6.1), **recomputes the state
transition itself**, then applies the locking rule. A witness never
signs a `resultingStateHash` it did not compute.

**Finality.** Tick `t` is FINAL when `q` distinct witnesses attest the
same `(bundleHash, resultingStateHash)` with attestation `round` equal
to the bundle's round. The record is assembled from the bundle plus any
`q` such attestations.

**Mismatch = halt.** A node MUST halt when: (a) `q` witnesses certify a
`resultingStateHash` for a bundle that differs from the node's own
computation of the same bundle; (b) a proof-valid record's bundle fails
structural validation; or (c) a proof-valid record's bundle, replayed
locally, does not produce the certified hash. Halting preserves the
evidence. Nothing is repaired silently.

**Proposer equivocation.** Two validly-signed different bundles for one
`(t, r, proposer)`: record the evidence and ignore the later bundle,
always. The strongest response — accepting no further bundles from that
proposer for tick `t` — applies only to a LIVE conflict (both bundles
claiming the node's current `previousStateHash`, unambiguous
same-instance equivocation); a signed conflict with an alien lineage
(a replayed stale bundle) is kept as evidence without poisoning, so a
replay cannot be used to silence an honest proposer. If unlocked, wait
for the next round; an existing lock stands.

**Recovery after a quorum-loss halt.** When a witnessed world loses
quorum and stalls, the surviving witnesses hold locks at the stalled
tick, but their last *durable checkpoint* predates it — a stalled
witness checkpoints nothing forward. A witness cold-restarting into a
fully halted world syncs only that older checkpoint and cannot on its
own reconstruct the stalled frontier from finality records; recovery is
operator-driven (restore a current certified checkpoint). Restarting a
witness *into a still-live world* recovers cleanly: certified checkpoint
sync carries it to the frontier and it resumes attesting (verified live
across real processes in e2e-multiproc.sh). The halted-world case is the
same H2 territory that justified-lock-upgrades would address.

---

## 6. The one verifier

### 6.1 Bundle validation (against local state `S`)

version · worldId · `tick = S.tick` · `round ≥ 0` ·
`previousStateHash = stateHash(S)` · proposer is `proposer(t, r)` ·
proposer signature · inputs sorted, unique, ≤ 2/player, ≤ cap · every
input signature-valid, for this world and tick.

### 6.2 Finality record verification (`verifyFinalityProof`)

Everywhere a record is trusted — live finality, checkpoints, catch-up
replay — one common verifier checks:

1. constitutional quorum: `n ≥ 3f+1`, `q ≥ 2f+1`, `2q−n > f`;
2. record shape; bundle present; `bundleHash = H(bundle)`;
3. bundle: `v`, `worldId`, `tick = record.tick`, `round = record.round`,
   `previousStateHash = record.previousStateHash`, proposer =
   `proposer(worldId, record.previousStateHash, tick, round)`, proposer
   signature valid;
4. attestations in **canonical form**: EXACTLY `q` of them, strictly
   ascending by witness key (one certificate, one byte representation;
   oversized or shuffled sets are refused before signature checks);
   each for this world, this tick, `round = record.round`,
   `bundleHash = record.bundleHash`, `resultingStateHash =
   record.resultingStateHash`, from a genesis witness, signature valid.

All hash fields, everywhere, are canonical lowercase 64-hex; any other
form is malformed, not merely unusual.

### 6.3 Adoption rules

- **Live/catch-up records** additionally require
  `record.previousStateHash = stateHash(local state)`, full bundle
  validation (§6.1), and local replay reproducing
  `resultingStateHash` byte-for-byte. Raw state is never adopted.
- **Checkpoints** `{formatVersion, worldId, tick, stateHash, state,
  finalityProof}` require: worldId match; byte-identical genesis;
  `state.tick = tick`; recomputed `stateHash` (lowercase 64-hex);
  engine-level state validation — genesis structure, coordinate bounds,
  hp/xp/quantity ranges as safe integers, inventory/bank/equipment
  shapes, ground/mob/node shapes, bidirectional name-registry
  consistency, entity counts, serialized-size cap, bounded values for
  every remaining gameplay field; and for `tick > 0` a §6.2-valid proof
  with `proof.tick = tick − 1` and `proof.resultingStateHash =
  stateHash`. A checkpoint's trust is its proof: one honest byte-source
  suffices. A witness additionally refuses any checkpoint at or behind
  its rollback frontier.

Peer hash announcements on the gossip mesh are transport-authenticated
DIAGNOSTICS (divergence flags in UIs); they carry no finality and no
adoption weight.

**Execution ↔ validation closure (rev6).** Input validation and state
validation accept exactly the same universe: every input `validInput`
accepts produces, through `nextState`, a state `validateState` accepts
(property-tested across hundreds of mixed transitions). Concretely for
trades: exactly ONE of a constitutional item or positive integer gold —
both, neither, unknown items, and non-positive or fractional gold are
refused at the input. Founding is gated the same way: `validateGenesis`
runs before any world is built (imported citizens get a dedicated,
complete validator — IDs, names, skills, XP, HP, inventories, banks,
equippable weapons, quantities, and cross-entry uniqueness), the world
generator enforces its constitutional minimum dimensions, and every
generated world is self-validated before it is returned: an accepted
genesis ALWAYS yields a constitutionally valid initial state, and a
generator bug aborts founding with the violated invariant named.

**Round schedule — exponential backoff (adversarial-sim finding).**
Round *r* for a tick opens at `due + ROUND_TIMEOUT_MS · (2^min(r,CAP) −
1)` (CAP = 6), not at flat multiples. Under heavy loss and delay, flat
600 ms rounds mint a fresh competing proposal faster than lock
rebroadcast can converge the earliest one, and honest lock splits (H2)
stall ticks within seconds. Geometric windows give rebroadcast time to
converge before a new proposer authors a rival. This is a pure liveness
change: the first-valid-bundle locking rule, and therefore safety, is
untouched (`roundStartMs`/`roundAt` in protocol.mjs). One observed consequence: when the
round's proposer dies *after* some but not all witnesses locked its
bundle, the remaining honest witnesses hold a transient lock split and
converge only once a backed-off round opens and rebroadcast delivers the
majority bundle — seconds, not milliseconds, under real gossip. The
world always converges or stalls; it never forks (confirmed live across
real processes: a two-of-three witness set resumes finality after the
third dies, given the convergence window).

**Typed failure codes (freeze-final).** Every safety-critical refusal and
halt carries a stable CODE (`errors.mjs`), not just a message. Startup
refusals throw an `IntervalError` with an `ERR_*` code
(`ERR_WORLD_MISMATCH`, `ERR_FRONTIER_ROLLBACK`,
`ERR_FRONTIER_AHEAD_UNPROVEN`, `ERR_CORRUPT_LOCK`, `ERR_CORRUPT_FRONTIER`,
`ERR_CORRUPT_SAFETY_RECORD`, `ERR_INVALID_CHECKPOINT`,
`ERR_INVALID_GENESIS`, `ERR_INVALID_BUILT_STATE`, `ERR_CORRUPT_IDENTITY`,
`ERR_MISSING_STORES`, `ERR_CHECKPOINT_REJECTED`,
`ERR_CHECKPOINT_UNCORROBORATED`, `ERR_CORRUPT_FINALITY_INDEX`); halts carry a `HALT_*` code with
supporting evidence (`HALT_CERTIFIED_RESULT_MISMATCH` — a quorum
certified a result local replay could not reproduce;
`HALT_PROPOSER_EQUIVOCATION` — one proposer signed two bundles for the
same round; `HALT_CONFLICTING_CERTIFICATES` — two valid certificates for
one finalized tick; `HALT_CERTIFIED_INVALID_BUNDLE`,
`HALT_REPLAY_MISMATCH`, `HALT_FRONTIER_PERSIST_FAILED`,
`HALT_FINALITY_INDEX_PERSIST_FAILED`,
`HALT_FINALITY_INDEX_READ_FAILED`, `HALT_FINALITY_INDEX_CORRUPT`,
`HALT_STATE_ADOPTION_FAILED`, `HALT_CALLBACK_FAILED`). The adversarial
harness classifies by code, not message text: a modelled refusal (a
recognized `ERR_*` during a restart) is tolerated, while any uncoded
exception fails the scenario, and a Byzantine halt is required to carry
the evidence that justified it, verified by REPLAYING the protocol
(quorum, distinct witnesses, signatures, deterministic replay), not by
structural checks alone. The
CJS engine mirrors the one code it can raise (`ERR_CORRUPT_IDENTITY`);
`test/errors.test.mjs` holds the code set to its contract.

**Persistent finality index (a first-class safety record).** Beyond the
bounded in-memory finality log, a witness maintains a durable,
append-only finality index (`finality-index.ndjson`): per finalized
tick, the bundle hash, resulting state hash, certificate hash, and the
full certificate for forensic replay. This index is treated with the
**same durability guarantees as the frontier and vote lock**, not as
best-effort storage. The commit sequence is fail-closed and ordered:

```
verify certificate → persist frontier (durable) →
  append durable finality record (durable) → adopt state →
  archive spent lock → continue
```

If the index cannot be persisted, the node HALTS
(`HALT_FINALITY_INDEX_PERSIST_FAILED`) with the frontier durable and the
vote lock intact, and does not advance execution — losing the historical
record would lose the ability to detect a future conflicting
certificate. If the index cannot be READ during a historical conflict
check, the node HALTS (`HALT_FINALITY_INDEX_READ_FAILED`) rather than
treat missing history as "no prior finality". The index is idempotent
per `(worldId, tick)`: an identical record is a no-op, a conflicting one
halts as corruption (`HALT_FINALITY_INDEX_CORRUPT`). At startup the
index is validated — every record parses, hashes are canonical,
retained certificates verify against genesis, and no two entries for one
tick conflict — and a corrupt accountability store refuses startup
(`ERR_CORRUPT_FINALITY_INDEX`), exactly like a corrupt lock or frontier.
The store ENFORCES per-`(worldId, tick)` immutability itself — first
append wins, an identical append is idempotent, a conflicting append is
rejected — so the invariant does not depend on the caller checking
first. Lookups use an in-memory `tick → byte-offset` index over the append log,
so historical conflict detection is O(1) and does not degrade with
history length; the on-disk format is a plain append log that a
SQLite/LevelDB backend can replace behind the same interface without a
protocol change.

**Storage is not consensus (storage brief).** The finality store is
selectable behind one interface — `{ get, append, latestTick, validate,
integrityCheck, health, backup, close }`. SQLite is the default
EVERYWHERE; the flat-file append log is an explicit dev/compat option
(`finalityBackend: 'flatfile'`), and an unknown backend value is
rejected (`ERR_INVALID_BACKEND`) rather than silently falling back.
SQLite provides atomic transactions, an indexed primary key on
`(world_id, tick)`, a uniqueness constraint that enforces append-only
immutability in the schema, WAL crash recovery, and `PRAGMA
quick_check`/`integrity_check`. Durability is `journal_mode=WAL`,
`synchronous=FULL`, `foreign_keys=ON`. The store enforces STRICT WORLD
BINDING — a record that identifies no world, or a different world than
the store's configured one, is rejected (`ERR_WORLD_MISMATCH`), never
silently mixed. A one-time migration copies a flat-file log into SQLite
ATOMICALLY — validate source → build a temp database → verify row counts
(via SQLite itself) and content hashes → integrity-check →
WAL-checkpoint (TRUNCATE) → fsync the db → atomically rename → fsync the
destination directory, preserving the original as a read-only backup —
so a failure never leaves a partial production database. Operational
tooling (`storage-ops.mjs`: health, integrity, consistent online backup
via `VACUUM INTO`, restore verification) operates on the store without
touching consensus. Whichever backend is chosen, the SAME certificates,
hashes, and replay semantics are stored and remain verifiable: the
protocol freezes, storage stays replaceable.

**Checkpoints accelerate recovery; they are not consensus.** Finality
certificates already record every transition, so a full state checkpoint
need not be written every tick. Checkpoints are written every
`checkpointInterval` finalized ticks (default 1000) plus once on clean
shutdown. On restart a witness loads the newest valid checkpoint and
REPLAYS the certified finalized records from the finality index up to the
durable frontier — each verified against genesis and re-executed
byte-for-byte — before the agreement layer decides whether it may sign.
A sparse checkpoint therefore costs a short certified replay, never a
refusal and never a fork. Checkpoint frequency is an implementation
tuning knob, not a protocol parameter.

**Startup/shutdown lifecycle.** A witness must never write its safety
directory after releasing exclusivity. Shutdown is strictly ordered:
stop the agreement → block any new checkpoint → write and DRAIN a final
checkpoint (in-flight and pending I/O) → close SQLite → release the
process lock → stop networking. Steps through closing SQLite all run
while exclusivity is still held. Startup is fail-safe: from the moment
the process lock is acquired, any failure (SQLite init, libp2p, protocol
registration) releases every partially-initialized resource — lock,
database, networking — so a restart re-acquires immediately rather than
finding a half-started witness holding the lock.

**Bounded startup verification.** Startup validation is constant-time in
retained history: cheap column-format checks run on ALL rows via a single
indexed SQL scan, while the expensive per-record work (JSON parse,
canonical re-hash, and full signature/quorum re-verification) is bounded
to the recent tail (`startupVerifyRecentN`). This bounded value is the
GENERIC default EVERYWHERE — `IntervalNode`, `IntervalAgreement`, and the
`serve`/`join` launchers all resolve an omitted setting to one shared
constant (`DEFAULT_STARTUP_VERIFY_RECENT_N` = 10000 in `errors.mjs`),
never to full-history verification. Direct construction and the launchers
therefore behave identically. Older records were fully verified when
first accepted and cannot change under the append-only immutability
invariant, so re-verifying them every boot is unnecessary — at one
million ticks this cuts startup validation from ~22 s to ~0.4 s.
Structural corruption anywhere in history is still caught by the
full-table scan, and database integrity checking (`integrityCheck()`,
`PRAGMA integrity_check`) is a separate operation from recent-tail
certificate verification. Full historical re-verification is available as
an EXPLICIT audit operation by setting `startupVerifyRecentN = Infinity`;
it is never a silent fallback. This is an implementation optimization
with identical protocol semantics.

Historical conflicting-certificate detection consults this index when
the in-memory window has expired or a restart cleared it, so a
conflicting certificate for a long-finalized tick is still caught and
halts the node (`HALT_CONFLICTING_CERTIFICATES`) with both certificates
as attributable evidence — accountability does not decay with the memory
window.

**Finality catch-up (freeze-final).** A node that fell behind — a
partition, a slow link — receives finality records for ticks ahead of
its own. Rather than drop them (one missed record would strand the node
forever, poisoning every record that follows), it buffers a bounded
window of future records and drains them IN ORDER as the gap fills; each
is still fully verified against genesis before adoption, so this is
catch-up, not trust. A gap larger than the buffer needs a checkpoint
sync, exactly as a cold start does. In adversarial simulation this is
what lets healed honest nodes reconverge to a single finalized frontier
(the "heal" scenario asserts spread 0 after a partition burst subsides).

**Adversarial simulation results (freeze gate).** A deterministic,
seeded, event-driven harness (advsim.mjs) runs honest witnesses under a
hostile transport — delay, reorder, duplicate, up to 25% loss,
asymmetric timed partitions — alongside Byzantine witnesses
(equivocating proposers publishing two bundles and double-signing both;
attesters signing corrupted result hashes; replayers; garbage floods)
and crash-restart witnesses recovering from durable stores, including
the crash-after-durable-vote-before-broadcast window. Across every
scenario and seed the four freeze invariants hold: **S1** no two honest
nodes finalize different hashes for one tick; **S2** no honest witness
signs two bundle hashes for one tick (judged on the wire); **S3** every
committed finality record verifies standalone against genesis; **S4**
honest nodes halt only when Byzantine behavior is present. Under the
"chaos" scenario (all faults plus two Byzantine actors at once) liveness
degrades to near zero while all four invariants still hold — safety is
sacrificed nowhere that liveness is. The harness classifies every honest halt against a set of
protocol-defined reasons (an unrecognized halt reason fails the
scenario as an implementation error), measures liveness as the SLOWEST
honest node's finalized height with an explicit convergence-spread
check, and treats any unexpected exception (one not matching a modelled
safety refusal) as a scenario failure. The batteries run in CI
(test/adversarial.test.mjs, 12 tests) and stand behind a live libp2p
adversarial demo (demo7.mjs) and a real multi-process witness E2E
(e2e-multiproc.sh). Reproducible evidence — environment, dependency
lockfile, exact commands, exit codes, full logs — is generated by
freeze-evidence.sh.

**The freeze invariant (pre-freeze rev).** One semantic action, one
founding record, and one persistent state each have exactly ONE
accepted representation. Signed inputs carry all five base fields in
exact formats (lowercase 64-hex ids, nonnegative tick, 128-hex
signature) plus exactly their action's typed fields; trade offers spell
out both demand fields (`wantItem: null` / `wantGold: 0` explicitly) so
no two byte-strings mean the same trade. The genesis schema is closed —
unknown keys refused, `witnesses` ⇔ `quorum` paired. Clients build the
object they sign through the ONE shared `normalizeInput`, so equivalent
requests are byte-identical before signing. Structural validity (forms,
formats, vocabularies, canonical null/zero) and state-dependent
validity (existence, adjacency, ownership) are separate layers. Every
`buildWorld` result is validated at the node boundary regardless of its
tick. Remaining work beyond this document is adversarial multi-node
simulation and, only after profiling, incremental state commitments —
never another representation of the same meaning.

**Canonical forms (rev7).** There is exactly ONE representation of
every valid input, persistent state, and founding record. Signed inputs
follow per-type schemas — required fields present, unknown fields
forbidden — enforced at intake, in bundle validation, and in the
engine, so a junk-padded twin of a legitimate action can never split
witness locks over the same intent (clients normalize before signing:
an absent optional is an absent key). Persisted trades obey the same
XOR invariant as the input rule; equipped items must occupy exactly the
slot the shared `slotOf()` assigns; banks are sparse (zero quantity =
absent key, in execution, validation, and imports). Founding records
name their generator (`worldGenerator`), the node validates genesis,
built state, and genesis-embedding at its OWN boundary, and once
validation accepts a genesis, construction applies it verbatim —
per-field filtering after validation is forbidden.

**Identity recovery (rev6).** Identity files follow the same
three-case discipline as safety records: missing → create; a supported
legacy format → migrate with the original preserved; corrupt or
forged (key/id mismatch) → refuse startup. A witness key is a founding
role; silently regenerating it silently loses that role forever.

**Constitutional vocabularies and relations (rev5).** State validation
enforces membership, not just shape: player names satisfy the single
shared name rule (spec §5a) in inputs, checkpoints, imports, and the
registry alike; items belong to the single constitutional item registry
in inventories, banks, equipment, ground, trades, and imports alike.
Relational integrity is strict — NO dangling references are permitted:
attack targets, gather nodes, player targets, trade partners, and
attuned waystones must all resolve (mobs and players are permanent
entries, and expiring objects never receive persistent references).

---

## 7. Fairness — what is and is not guaranteed

Guaranteed: deterministic execution; deterministic, portable finality;
no forged inputs (all player-signed); no forged outcomes (all witnesses
recompute); equivocating players deterministically excluded for the
tick when both versions are bundled.

**Not guaranteed: complete input inclusion.** The round's proposer
chooses the bundle from what it has seen. An input it omits — by
partition, latency, or censorship — is simply not in the tick; since
inputs are tick-bound, an omitted input dies with its tick and the
client must observe state and resubmit (the shipped clients do).
Sustained censorship requires the cooperation of every rotating
proposer, i.e., the witness set. Witness availability receipts /
deterministic mempool commitments are a possible future extension and
are deliberately out of scope.

Input equivocation (different inputs to different witnesses) is
detected at intake, kept as `InputEquivocationEvidence`, and both
versions ride into the next proposal together, triggering the engine's
deterministic duplicate-exclusion.

---

## 8. Liveness and permanent stalls

The world advances when `q` honest witnesses are connected, unlocked or
locked on the same bundle, within a round window. Known stall
conditions — all of which stop the world without forking it:

- **H1** — fewer than `q` witnesses alive/reachable (crash, key loss,
  partition): stalls until quorum returns.
- **H2** — **lock split**: a multi-round partition can leave locks
  spread over ≥ 2 bundles such that no bundle can ever gather `q`
  (e.g., three isolated witnesses each locking their own proposal).
  Rebroadcast converges any split where one bundle can still reach
  quorum; otherwise the tick is permanently stuck. This is the accepted
  cost of LOCK-2: liveness is sacrificed, never safety.
- **H3** — halt-on-mismatch (§5) on any node: that node stops; if
  quorum-many witnesses halt, the world stops.
- **H4** — proposer equivocation poisoning every round of a tick while
  witnesses stay unlocked: stalls until an honest round completes.

Permanent stalls are recovered by §9, never by unlocking.

---

## 9. Witness lifecycle

**Witness sets are immutable, forever, per world.** They are founding
facts inside genesis; the worldId commits to them; there is no
in-protocol addition, removal, rotation, or key revocation. This is
deliberate: mutable validator sets are where consensus protocols hide
their subtlest bugs, and Interval already has a first-class mechanism
for constitutional change — **founding a new world**.

- *Key loss / crashed-forever witness*: the set's effective size
  shrinks; the world lives while `q` remain (H1 otherwise).
- *Compromised witness*: a minority compromise (`< 2q − n`
  double-signers) cannot fork the world; misbehavior yields portable
  evidence. There is no slashing — the remedy is social: refound
  without them.
- *Quorum permanently lost, lock split (H2), or halted world*: operators
  found a NEW world (new anchor, new worldId, new witness set) whose
  genesis `imported` carries the citizens from the last certified
  checkpoint, applied deterministically by worldgen on every node. The
  old world remains verifiable history.
- *One-witness deployments* (`n = q = 1`): valid and safe against
  crashes (locks persist); the single witness is fully trusted for
  liveness and censorship, and its equivocation would be self-evident.
  This is the "friendly pillar" bootstrap mode, not the destination.

---

## 10. Failure matrix

| Event | Consequence | Fork? |
|---|---|---|
| ≤ n − q witnesses crash | rounds skip the dead; world continues | no |
| > n − q crash / partition below q | stall until quorum returns (H1) | no |
| witness crash mid-vote + restart | lock reloaded from disk; rebroadcast only (LOCK-3) | no |
| multi-round partition, locks split | possible permanent stall (H2) → refound (§9) | no |
| player equivocates | evidence kept; both versions bundled; engine excludes for the tick | no |
| proposer equivocates | evidence kept; proposer ignored for the tick; next round proceeds | no |
| < 2q − n witnesses double-sign | cannot certify a conflict; evidence exists | no |
| ≥ 2q − n witnesses double-sign | conflicting certificates possible; honest nodes that see both HALT with proof | detected, halted |
| certified result ≠ local replay | halt with evidence (H3) | no |
| oversized / malformed streams and gossip | rejected before allocation | no |
