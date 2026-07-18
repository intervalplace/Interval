# Pre-launch audit: what would have forced a fork

The goal was not to find bugs. It was to find **incompleteness that only
shows up after launch**, when fixing it costs a fork or a hand on every
node. Round one, engine and generators.

Severity is judged by one question: *if this surfaced six months after
launch, what would it cost?*

---

## FIXED — would have forced a fork or a divergence

### 1. `Math.pow` in the level curve (fixed, v0.60)

`levelForXp` continued past mastery with `Math.pow(2, lvl/7)`, and **both
windows recomputed all ninety-eight thresholds** with the same call.
ECMA-262 does not require the transcendentals to be correctly rounded, so
two JavaScript engines may differ in the last place.

- **Engine, past mastery:** theoretical only. The divergence between the
  float and the true value first appears at **level 267**, and the
  `MAX_XP` cap of 1e12 puts the highest reachable level at **212**. Out
  of reach, but it was luck rather than design.
- **Windows, every level:** genuinely reachable. A window computing the
  table with `Math.pow` could show a different level than the engine
  holds at *any* level, which is precisely the class of bug §10 exists
  to prevent.

Fixed: the thresholds are now copied, never recomputed, and the
continuation is exact integer arithmetic (2^(r/7) as scaled integers).
Verified to reproduce all 98 constitutional thresholds exactly. Recorded
as §4c, and a test forbids `Math.pow` in the engine or in either window's
identity block.

### 2. `Math.sin` in terrain (fixed, v0.58)

Same root cause, worse blast radius: terrain decides where nodes stand,
and nodes are the founded world. One tile of disagreement about the
river's course is **two different worlds from one genesis**, which no
consensus can reconcile afterward. Now built from hashed control points
joined by smoothstep, exact arithmetic only. §9b, with tests over both
the generator and both windows' mirrors.

### 3. The witness lock path (fixed, v0.55)

Not a fork, but worse in daily terms: a permanent refusal to start that
only a human with shell access could clear. The lock path was 177 bytes
against a 108-byte kernel limit, so the socket was created truncated
while `unlink` targeted the full name and silently did nothing. Now a
short hashed path, with a guard that refuses over-long paths loudly and
an unlink that reports what it cannot remove.

### 4. Master of Interval had no calling (fixed, v0.57)

Would have forced a fork on the day someone approached total mastery,
which is the worst possible day to need one.

---

### 6. A generator could change the world without changing its worldId (fixed, v0.62)

The worst class of change, and the one worth naming carefully.

A genesis commits to its generator by **name** (`interval-expanse-v1`),
never by the code behind that name. So editing `worldgen-expanse.mjs`
after launch changes no worldId at all: it changes what the world *is*,
while every node goes on claiming the same world. That is worse than a
fork. A fork is two honest worlds that both know they diverged. This is
one worldId with two different countries under it, and nothing anywhere
announces it.

Fixed by freezing the founded world: `test/world-freeze.test.mjs` pins
the worldId and the founded state hash. If either moves, the failure says
so in those terms — the question is never "update the hash", it is "did I
mean to change the world?"

Pre-launch the answer may be yes, and the new hash is recorded
deliberately. **Post-launch the answer is no**, and the change must be
published as a new generator id instead, so that a divergence becomes a
fork that announces itself.

## How each class is actually enforced

The rule is one sentence: **anything that changes the world is a
different world.** The mechanism differs by what is being changed, and
the difference is deliberate.

**The constitution is enforced by IDENTITY.** `SPEC.md` is hashed into
the genesis, so an edited constitution produces a different worldId
before a single tick runs. The same holds for every founding parameter.
Nobody can add rules to an existing world; they can only found a new one.
`serve.mjs` recomputes the hash from the actual file at startup and
refuses to resume a world whose rules it no longer matches.

**Implementations are enforced by AGREEMENT, and are deliberately NOT
hashed.** `engine.js` is not part of the world it computes. If it were,
the world would belong to one codebase and could never be reimplemented
in Rust, Go, or anything else, and "if your hashes match, you are a
citizen" would be a lie. What the constitution commits to is *behaviour*.
So a citizen who rewrites the engine is caught a different way: they
compute a different resulting state, and a certificate requires a quorum
attesting to the *same* result. Their attestation is validly signed and
still worthless, because honest witnesses recompute the transition
themselves and will not attest to a result they did not reach. Proven in
`test/rulechange.test.mjs`.

**Collective drift is enforced by FREEZE TESTS.** Agreement cannot catch
the one case where *everybody* changes together: a release that quietly
alters the generator, which every node then adopts. Nothing disagrees,
because nothing is left to disagree with. That is what
`test/world-freeze.test.mjs` is for, and it is the only one of the three
that depends on discipline rather than mathematics.

## The three classes of change

Worth stating plainly, because the priorities follow from it:

| Class | What it touches | What happens | Cost |
|---|---|---|---|
| **A. Forks** | `SPEC.md`, any genesis field | New worldId. Two worlds, both honest, both aware | High after launch, free before |
| **B. Silent divergence** | engine `nextState`, generator output, without a spec change | Same worldId, different state. Nothing announces it | **Unrecoverable** |
| **C. Free** | networking, persistence, windows, tooling, `CONSENSUS.md` | Nothing about the world changes | None |

Class C is genuinely free, and that includes all of libp2p, gossip,
storage, and the clients: `CONSENSUS.md` is not hashed into any worldId.
A botched consensus upgrade can halt the network, which is recoverable
and is exactly what "a stopped world, never two worlds" is for. It cannot
split the world.

So the priority order for the remaining audit is A and B only: the state
transition, the generators, and the constitution that describes them.

## VERIFIED SOUND — checked, no action

- **The state transition is free of implementation-defined math.** Zero
  transcendentals in `engine.js`. `effLevel` caps at 99 and the table is
  a literal, so no requirement, max-HP, or state hash can move.
- **No time, randomness, or locale** in the transition. No `Date`, no
  `Math.random`, no `toLocale`, no `Intl`.
- **Float arithmetic in survey placement is deterministic.** IEEE-754
  requires `+ - * /` to be exactly rounded; the one division by `0.15`
  is safe, and its out-of-bounds edge is already guarded by `Math.min`.
- **Growth is bounded.** `MAX_XP` 1e12 caps the highest reachable level
  at 212 and the highest standing near 3,392, comfortably inside safe
  integers. Announcements are trimmed to a fixed keep. The `firsts`
  record has a closed vocabulary of 24 keys (8 fixed plus one per
  skill), so it cannot grow without bound.
- **World geometry is in the founding record** (`genesis.geo`), so a
  future world can move its Wilds without amending the constitution.

---

### 5. The spec claimed levels were unbounded; they are not (fixed, v0.61)

§4b said the level recurrence continued "without bound" and §10 said
standing "has no maximum to write down". Both were false: experience is a
bounded state field (`MAX_XP` = 10^12), which puts the highest reachable
level at **212** and the highest standing near **3,392**.

Nothing about the design was wrong. The bound is representational, not a
wall: mastery remains a milestone with a hundred and thirteen levels
above it, and reaching the ceiling in one skill would take some four
centuries of unbroken play at a rate nobody sustains. The bound exists so
a hostile checkpoint cannot carry an absurd number and so the curve's
arithmetic stays exactly representable.

But a constitution that promises an infinity it does not deliver is a
correction waiting to happen, and corrections cost forks. It now states
the bound, the level it lands on, and why it is there. A test asserts the
number in the spec matches the engine.

**Considered and rejected: raising `MAX_XP`.** There is room (the curve
accumulates 4x experience, so the safe limit is about 2.25x10^15), but
the gain is imaginary — nobody reaches 10^12 — and the cost is real:
larger values push the accumulator toward the boundary where exactness
fails. A bound at four centuries of play is not a bound anyone meets.

## OPEN — decisions better made before launch than after

### A. Prayer does nothing (design decision, not a bug)

Burying bones grants Prayer experience. That is the whole of it: no
effect anywhere else in the ruleset. It is trainable, it counts toward
standing, it can be mastered, and it can be your calling (*mourner*).

This is a deliberate position and a defensible one. But it is exactly the
kind of thing that becomes a fork later, so it deserves an explicit
decision now. The options, in the order I would rank them:

1. **Leave it, and say so in the manual.** Make the silence intentional
   and public: people bury the dead because it is worth doing, not
   because it buys power. Costs nothing, forecloses nothing.
2. **Give it a social effect, never a supernatural one.** The natural
   shape is memory rather than magic: the world already keeps `firsts`
   forever, and a burial is the only act in the ruleset one citizen
   performs for another with nothing in it for them.
3. **Remove it.** Cheapest to reason about, and the worst fit: it would
   say this world has no room for an act that pays nothing.

### B. Two environment variables change engine behaviour

`INTERVAL_CLONE` and `INTERVAL_INDEXES` select clone and index strategy.
Both are proven behaviour-neutral by the phase-2 equivalence campaign, so
this is not a live bug. But an env var that reaches into the state
transition is a strange thing to ship in a consensus system: it is a
setting an operator can get wrong. Worth making test-only before launch.

### C. The classic generator still uses `Math.sin`

Deliberately left alone. It is not the launch world, and changing it
would fork *it* for no benefit. Documented here so the hazard is known
rather than forgotten: a classic world founded across two different JS
engines is at risk in a way the expanse is not.

---

---

# Round two: long-run behaviour and the tick budget

## VERIFIED SOUND

**State does not grow or drift.** A world run with 25 active citizens
held its size to within 0.00% between tick 400 and tick 1,000, kept
`validateState` valid throughout, and showed no accumulation in nodes,
ground items, or announcements. Nothing leaks per tick.

## FINDING — `LOTS_N` is a consensus-critical hardware tuning constant

Profiling a tick showed **55% of the time in SHA-256 and 21% in garbage
collection**, which looked like a performance bug. It is not. It is the
delay: `LOTS_N = 20000` sequential hashes, a verifiable delay function,
and 20,000 of the 20,123 hashes in a tick are that chain. The remaining
123 cover every node, mob, and citizen in the world.

Two consequences follow, and both matter more than the profile did.

**1. Tick cost is essentially constant.** It does not grow with world
size or population, which is an excellent property and explains why a
640x400 world with 3,041 nodes benchmarks so close to a 320x200 one.

**2. The constant is unchangeable after launch, and it decides who can
run a node.** The chain feeds the beacon, so changing `LOTS_N` changes
every beacon and therefore the world: a Class B silent divergence if done
quietly, a fork if done honestly. It is hardcoded, not a genesis field,
so it cannot even be varied per world.

Measured on this machine: **108ms, or 18% of the 600ms tick budget.**

| Node speed | Delay cost | Share of budget |
|---|---|---|
| This machine | 108ms | 18% |
| 3x slower | 324ms | 54% |
| 5x slower | 540ms | 90% |
| 10x slower | 1,080ms | **cannot keep up** |

So `LOTS_N` is really a floor on the hardware anyone needs to witness
this world, forever, set at founding. 18% leaves comfortable room on
modern hardware and rules out anything roughly ten times slower, which
today means a low-end ARM board or a heavily contended VPS.

**No change recommended, but a decision worth making deliberately**,
because it can only be made once:

- **Keep 20000.** The delay is doing real work: it makes the beacon
  unpredictable and ungrindable, which is what stops a proposer steering
  outcomes. 18% is a reasonable price and the margin is real.
- **Consider whether it should be a genesis field.** Not for this world
  necessarily, but a future world on different hardware cannot tune it
  without a new engine. Making it constitutional per-world costs nothing
  now and is impossible later.

## Not yet audited

Round one covered the engine and the generators. Still to do, in the
order I would take them:

1. **Consensus and networking** (`node.mjs`, `CONSENSUS.md`): partition
   and rejoin, checkpoint import from a hostile peer, attestation replay
   across a rules change, clock skew between witnesses.
2. **Persistence**: what a half-written durable store does on restart,
   and whether any corruption needs a human.
3. **Long-run simulation**: a world run for millions of ticks with
   citizens active, watching for anything that grows without bound or
   drifts.
