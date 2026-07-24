# Interval

*A world that runs on rules, not servers.*

*Release 0.80.0 · protocol spec v0.80 · consensus spec v1.9 · rules hash `d1a37c706f7d12bd…`. These four move together; a change to any is a new release.*

**CURRENTLY IN PRIVATE TESTING. ONCE IT IS PUBLICLY FOUNDED, THE WORLD WILL STAY THE SAME FOREVER**

Interval is a decentralized MMO. The game is a deterministic state
machine, the spec is the constitution, and the rules are the authority: not a
server. The world advances in fixed intervals, ticks, and
everything that ever happens, happens on one. Any machine that runs the
same rules computes the same world; machines that disagree have, by
definition, broken the rules, and are ignored.

Your citizen is a keypair. Every action you take is an Ed25519-signed
input; the signature is the authorization, and no session, account, or
server grant stands between you and your soul. Keys are generated
locally and never leave your device. Lose the key, lose the citizen;
hold the key, and every window into the world (the flat one, the
deluxe one, the painterly one, a terminal, a bot) is equally yours,
because the citizen was never the session.

The live world is **Tallyholm**: [interval.place](https://interval.place).
Source and constitution: [github.com/intervalplace/interval](https://github.com/intervalplace/interval).

## Play in five minutes

Open [interval.place/play](https://interval.place/play). A key is minted
in your browser, and you wake at the well in Anchor. Chop, mine, fish,
fight, trade, light fires; everything you do is signed and witnessed.

- **/play**: the flat window. Fast, complete, runs anywhere.
- **/deluxe**: the 3D window.
- **/photo**: the painterly window. Same world, golden hour.
- **/map**: the living chart, computed in your browser from the seed.
  If the chart and the world ever disagreed, one of them would be in
  breach of the constitution.
- **/hiscores**: every rank cryptographically provable. No exceptions,
  no appeals.
- **/board**: arrangements with people who are not standing next to
  you, signed with the same key that swings your axe.
- **/manual**: how everything works, in-world terms.

Export your key from any window's door (or paste an executor identity
JSON straight in); one soul, any vessel.

## Run a pillar

A pillar founds a world, witnesses it, and serves the windows.

```bash
git clone https://github.com/intervalplace/interval && cd interval
npm install
INTERVAL_DATA=/var/interval-data INTERVAL_SEED=my-world node serve.mjs
```

**`INTERVAL_DATA` is the one setting that matters.** World memory (checkpoints,
identities, witness-safety) lives there. If it is unset,
memory lives inside the deploy directory, and a replaced deploy is a
wiped world; the server warns loudly about this at boot. Set it to a
persistent path, put it in your service unit
(`Environment=INTERVAL_DATA=/var/interval-data`), and never think about
it again. Prefix env vars inline as above: a bare `VAR=value` on its own
shell line applies to nothing.

`INTERVAL_SEED` names the founding. Booting with a new seed founds a
new world; citizens of the old one cross into it with their skills,
names, packs, and wounds. Founding data does not expire with the world
that held it. Old founding records and checkpoints are archived, never
deleted. If disaster leaves you with a frontier and no matching state,
`node recover.mjs` rebuilds the exact finalized present from genesis
and the accountability store's quorum-signed certificates, trusting
nothing it cannot verify.

## Join as a sovereign peer

Two sovereign machines already run this world. Any stranger runs
`node join.mjs <name>` and becomes a full peer: their machine fetches
the founding record, refuses unless its own SPEC.md hashes to the same
constitution, syncs a checkpoint, and then computes every tick
independently, comparing state hashes with everyone else. The first
foreign citizen was named zezima, because of course it was.

By default a joined citizen simply exists while its node verifies the
world. Add `--chop` for the example executor: a bot that trains
woodcutting and banks its logs. Bots and people enter the world the same
way; the protocol cannot tell them apart, and does not want to.

## Tested against a hostile network

Consensus safety is exercised by a seeded, deterministic adversarial
simulator (`npm run advsim`): honest witnesses under packet loss, delay,
reordering, duplication, and timed partitions, alongside Byzantine
witnesses (equivocating proposers, lying attesters, replayers, garbage
floods) and crash-restart recovery from durable stores. Three test
surfaces cover it, all enumerated in [TESTING.md](TESTING.md): the CI
battery (`test/adversarial.test.mjs`, 15 tests, being every scenario at
one seed plus convergence and determinism checks), the **attached freeze
evidence** (`freeze-evidence/`, all 12 scenarios × 1 seed × 11s), and
the full campaign on demand (`node advsim.mjs all 3 30000`, 12 scenarios
× 3 seeds × 30s). Across the runs in the attached evidence, no two
honest nodes finalized different hashes for the same tick, no honest
witness double-signed, and every committed certificate verified. The
world stops rather than forks. These are claims about the enumerated
runs, not a proof over all executions. The same properties are shown
live over real libp2p (`npm run demo7`) and across real OS processes
(`npm run e2e`); those two bind real sockets and are captured separately
(see TESTING.md and `INTERVAL_LIVE=1 npm run evidence`), not in the
default evidence run.

## The constitution

[SPEC.md](SPEC.md) *is* the game: every rule, every number, every
verb. Its SHA-256 is the **rules hash**, committed into each world's
genesis; a node whose SPEC hashes differently is playing a different
game and is refused at the door. [CONSENSUS.md](CONSENSUS.md) governs
how independent witnesses agree: quorum-signed finality certificates
for every tick, a per-witness safety frontier that refuses to re-sign
history, and certified recovery for any node that falls behind.

Nothing in the protocol is random and nothing consults a wall clock for
truth. Terrain, towns, roads, monuments, even the poster on the
homepage derive from pure functions of the seed, mirrored identically
by every window, which is why the map can promise it cannot drift.

Governance is by exit. There are no votes: if you want different rules,
edit SPEC.md, and you have founded a different world with a different
hash. Citizens choose worlds by walking into them, and the crossing
carries them whole.

## The world

Tallyholm is an island of seven towns and five countries, run through
the same pure functions in every window. It has monuments older than
its towns: an oak that cannot be cut, a bell tower drowned to its
shoulders, a wreck implying a sea worth sailing. None of them will be
explained. Its keepers stand at their counters from the founding
on, every one named by a hash except the wizard, who chose his own.
It has fenced fields, worksites where each country's trade gathers,
an inn on the north road whose yard is waiting for its first brewer,
and sixteen races, one per skill, each winnable exactly once, the
winner named for as long as the world lasts. Magic is the skill of
refusing combat: its capstone spell's whole law is one sentence, and
the sentence is in the SPEC. One island in the northwest appears on no
road and carries no label. It is drawn faithfully.

Some things on the island are not in this file on purpose.

## The files

| | |
|---|---|
| `SPEC.md` | the constitution: the rules **are** the game |
| `CONSENSUS.md` | how strangers agree the same world happened |
| `engine.js` | the deterministic state machine (validation, application, ticks) |
| `node.mjs` | a full node: p2p, witnessing, finality, storage |
| `agreement.mjs` | quorum finality, safety frontier, certified recovery |
| `serve.mjs` | the pillar: founds, witnesses, serves the site and windows |
| `join.mjs` | become a sovereign peer of an existing world |
| `recover.mjs` | rebuild the finalized present from certificates alone |
| `worldgen-expanse3.mjs` | Tallyholm: the island as pure functions of the seed |
| `window-web.html` · `window-3d.html` · `window-photo.html` | three windows, one world |
| `site/` | the map, hiscores, board, manual, served by the pillar |
| `sdk.mjs` · `session.mjs` | build your own window or executor |
| `advsim.mjs` | the adversarial network simulator |

## Testing

```bash
npm install && node run-tests.mjs
```

The battery covers the engine's invariants, canonical input forms,
persistence round-trips, window/engine agreement, consensus safety
under adversaries, and the release tuple itself. The suite fails if
this README's banner drifts from `package.json`. Freeze evidence and
methodology live in [TESTING.md](TESTING.md).

## Homage

Interval is deeply inspired by early-2000s RuneScape: its tick-based
time, discrete systems, and coherent fixed rules. Interval is an
independent project with no affiliation with Jagex.
