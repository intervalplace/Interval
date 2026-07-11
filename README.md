# Interval v0.10

A decentralized MMO protocol. The game is a deterministic state machine,
the spec is the constitution, and the rules are the authority — not a
server. The world advances in fixed intervals; everything that ever
happens, happens on one.

Design homage: Interval is deeply inspired by early-2000s RuneScape —
its tick-based time, discrete systems, and coherent fixed rules. Interval
is an independent project with no affiliation to Jagex.

## New in v0.10 — the world tolerates imperfect nodes

- **Catch-up by replay** (spec §9b). Nodes retain a recent input log and
  serve contiguous ranges of it. A node that stalls — laptop lid, network
  blip — wakes behind, fetches the ticks it missed, and REPLAYS them
  through the state machine. No trust extended: replay recomputes every
  state and hash gossip judges the result. In `demo5.mjs`, node C
  freezes for 6 ticks while the world carries on, then catches up and
  finishes in perfect agreement, having "witnessed" history it slept
  through. Falls back to checkpoint re-sync when the gap exceeds peers'
  logs. Determinism makes history replayable; replayability makes
  stalls survivable.

## New in v0.9 — combat, a universal engine, and the first graphical window

- **Combat** (spec §6b/§6c). Attack, defence, hitpoints. Goblins with
  beacon-rolled hits, damage, retaliation, drops, and 16-tick respawns.
  Death is provisional and brutal: respawn with your inventory
  destroyed — the deepest sink. Softer death rules are an expected fork;
  §6c says so in writing. Eat cooked fish to heal: the full loop —
  fish → cook → eat → fight — is closed.
- **Universal engine.** node:crypto is gone; the engine runs on
  @noble/ed25519 + @noble/hashes — pure, audited, deterministic JS that
  runs identically in Node and browsers. The last platform-determinism
  risk is closed.
- **The reference graphical window.** `node serve.mjs yourname`, open
  http://localhost:8787: an early-RuneScape-style low-poly canvas
  client — chunky tiles, polygon trees, stone-bevel panel, gold-on-brown
  text, the 4×7 inventory grid. Click to walk, gather, fight, cook, eat.
  It is deliberately ONE aesthetic among many: the protocol has no
  authoritative graphics, and every client is a reskin of the same truth.

## New in v0.8 — the first sink

- **Fishing** (gathering): `fishing-spot` nodes yield `raw-fish`
  (30 XP), same depletion economics as trees and rocks.
- **Cooking** (processing): stand by a `campfire`, `cook {slot}` — the
  beacon rolls; success gives `cooked-fish` + 30 XP, failure gives
  `burnt-fish` and nothing. **Either way the raw fish is destroyed.**
  This is the economy's first sink: gathering creates supply, processing
  burns it. Burn rate falls with level, exactly like the classic curve —
  a fresh cook chars most of the catch.
- `play.mjs`: `f` to cook. The window shows ≈ fishing spots and ♨ fire.

## New in v0.7 — one clock, one self

- **The shared clock** (spec §2). Genesis now carries `anchorMs`: tick N
  finalizes at `anchorMs + (N+1)*600`, computed independently by every
  node. In `demo4.mjs` there is no tick driver at all — two nodes
  self-advance on pure arithmetic and stay in perfect lockstep while
  players act through the SDK. The world has one clock and it is math.
- **Identity persistence.** `loadOrCreateIdentity` saves your keypair to
  disk: same key, same playerId, same character, forever. `play.mjs` now
  remembers who you are between sessions. Guard the file — it IS your
  character; there is no password reset in a world with no authority.

## New in v0.6 — citizens and commerce

- **Spawning** (spec §5b). A player no longer needs to exist in genesis:
  `spawn` is a constitutional input, the only one valid for an unknown
  playerId. In `demo3.mjs`, charlie's node late-joins a running world,
  he spawns, names himself, and grinds — the complete stranger-to-citizen
  journey, witnessed identically by every node.
- **Trade** (spec §5c). Two-phase atomic swap: offer, then accept. It
  settles whole in one tick or not at all — no escrow, no partial state.
  And it requires **adjacency**: trade demands being there. The first
  economy primitive is also the first presence-rewarding mechanic.
- **You can play it.** `node play.mjs yourname` — WASD to walk, g to
  gather, one input per 600ms interval exactly as the constitution
  demands. Your keypress and a bot's API call remain indistinguishable.

## The first fork

v0.4 changed the constitution (names, checkpoints), so its rules hash
differs from v0.3's — meaning **v0.4 is a new world**, on separate
gossip topics, invisible to v0.3 peers. This is governance by exit
operating on the project itself: nobody was forced to upgrade; a v0.3
world could still be run by anyone who prefers it.

## The website

`node serve.mjs yourname` now serves the whole front door on
http://localhost:8787 — landing page with a live tick counter, the
New Player Guide, The Manual, live Hiscores, and the playable browser
window at `/play`. All in the reference window's stone-and-gold
aesthetic. The node also speaks JSON: `/api/world`, `/api/hiscores`,
`/api/player/:name` — every hiscores site is just another window.

## Files

- `SPEC.md` — the protocol constitution (intervals, XP, gathering,
  verifiable RNG, worlds & forks)
- `engine.js` — reference state machine, zero dependencies, pure functions
- `sim.js` — single-process determinism proof + adversarial tests
- `node.mjs` — the networked node: engine + gossipsub + persistence +
  checkpoint serving + corroborated late-join
- `demo.mjs` — 4 real nodes on localhost, one cheating
- `demo2.mjs` — names claimed live, disk checkpoints, and a node joining
  mid-world by corroborating checkpoints from 2 peers
- `sdk.mjs` — layer 2: the client library (read the world, sign actions)
- `window-term.mjs` — layer 3: the first window (terminal renderer,
  built purely on the SDK — imports nothing from node or engine)
- `session.mjs` — a played session: alice claims her name, walks to a
  tree and chops it; bob runs a bot through the same SDK
- `demo3.mjs` — the first trade (atomic, adjacent) and charlie's
  stranger-to-citizen journey (late-join → spawn → name → gather)
- `play.mjs` — interactive solo client: WASD, g gather, x attack,
  f cook, e eat; persistent identity
- `serve.mjs` + `window-web.html` — WebSocket bridge, the reference
  graphical window, the website, and the JSON API
- `site/` — landing page, New Player Guide, The Manual, Hiscores
- `demo4.mjs` — self-driving nodes on the arithmetic clock + identity
  reloaded from disk

## Run

```
npm install     # libp2p stack (only needed for the network demo)
node sim.js     # zero-dependency engine proof
node demo.mjs   # a live 4-node world with a cheater
node demo2.mjs  # names + persistence + late join
node session.mjs # a played world, rendered in the terminal window
node demo3.mjs   # spawning + the first trade
node play.mjs bob # play it yourself (real terminal required)
node demo4.mjs   # no tick driver: the clock is arithmetic
node serve.mjs bob # then open http://localhost:8787 — the graphical window
node demo5.mjs   # a node stalls, wakes behind, catches up by replay
```

Note: gossipsub v14 requires the libp2p v2.x generation — the
`package.json` pins compatible versions (interface mismatch with
libp2p v3 causes silent stream failures).

## What this proves

1. **Determinism** — independent implementations of the spec converge
   byte-for-byte, tick after tick.
2. **Verifiability** — every drop roll derives from a public beacon;
   any peer can audit any other peer's claimed progress.
3. **Rule-as-authority** — a cheater's state hash simply doesn't match,
   and honest peers ignore it. No server, no anti-cheat team.

## Governance by exit

The rules cannot be amended, only succeeded. An "update" is a new world
(new rules hash) that shares history up to the fork tick. If players
prefer the old rules, they keep running them — both timelines live, and
population decides which ones matter. Nobody has to accept an update,
ever.

## New in v0.5 — the three layers are real

- **Layer 1 (node):** constitution + consensus. Headless. Unchanged.
- **Layer 2 (SDK):** `IntervalClient` — read the world, act in it
  (`move`, `gather`, `claimName`), subscribe to ticks. Knows nothing
  about pixels. Humans and bots use this identical interface: in
  `session.mjs`, alice's scripted "hands" and bob's bot are
  indistinguishable to the protocol — bot indifference made concrete.
- **Layer 3 (window):** a terminal renderer built purely on the SDK.
  The first of many windows. Anyone can build another (web, pixel-art,
  spreadsheet) without touching consensus code.

## New in v0.4

- **Names are in-world objects** (spec §5a). `claim_name` is a
  constitutional action: first valid claim wins, one name per player,
  simultaneous claims resolve deterministically. No external name
  service needed — identity lives in world state like everything else.
- **Persistence.** Nodes checkpoint the full world to disk every tick
  and resume from it on restart. The world survives.
- **Late join** (spec §9a). A new peer fetches checkpoints from ≥2
  independent peers, verifies the hashes agree, adopts, and marches in
  lockstep from there — inheriting history it never witnessed. One peer
  is never enough: corroboration, not authority.

## New in v0.3

- **It's a real network now.** Nodes are libp2p peers. Signed inputs are
  gossiped on a world-specific topic; every node advances the world in
  lockstep on the 600ms schedule and publishes its state hash each tick.
- **Topics are namespaced by rules hash.** A different constitution is a
  different gossip network. Forks are separate worlds *by construction* —
  peers on different rules never even hear each other.
- **Divergence detection.** Honest nodes compare hashes every tick. The
  demo runs three honest nodes and one cheater (double-XP modified
  engine): the cheater's hash diverges on tick 1 and all honest nodes
  flag and ignore it. Symmetrically, the cheater flags the honest nodes —
  from its perspective, *they* left. That asymmetry resolves socially:
  a world is whoever agrees with each other.

## New in v0.2

- **Real identities.** Players are ed25519 keypairs; every input is
  signed, and the state machine itself verifies signatures. Forged,
  tampered, and replayed inputs are all rejected (see `sim.js` tests).
- **Hardcoded XP table.** Spec constants now — no floats anywhere in
  consensus logic. The v0.1 caveat is closed.
- **Genesis object with rules hash.** A world's genesis contains the
  spec version and the SHA-256 of the constitution. Two peers are in
  the same world iff their genesis matches — forks are now detectable
  in code, not just in principle.

## Known v0.2 caveats

- Beacon is a hash chain from the genesis seed (predictable). Production
  needs a distributed beacon (e.g. drand) so future rolls are unknowable.

## Roadmap

- `demo5.mjs` proves the resilience path; remaining dragons below.
- **v1.0** — true browser light clients: browser-side keys and signing
  (the engine already runs there), checkpoint corroboration against ≥2
  pillars over libp2p WebSockets — the bridge stops holding your key
- **beyond** — sharding, distributed beacon, presence events, more
  skills, smithing (the ore sink)
- **beyond** — distributed beacon, sharding, presence-rewarding events
  ("presence cannot be automated")
