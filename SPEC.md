# Interval: Protocol Specification v0.66 ("The Constitution")

A decentralized, deterministic MMO protocol. The rules in this document
**are** the game. Any client that implements this spec exactly is a valid
window into the shared world. State disagreements mean one party broke the
rules and is ignored by the network.

The world advances in fixed intervals, ticks, and everything that ever
happens, happens on one.

## 1. Core principles

1. **Determinism.** Given `(state, inputs, beacon)` for tick N, every
   correct implementation computes byte-identical state for tick N+1.
2. **Discreteness.** All quantities are integers. No floating point
   anywhere in consensus-relevant logic.
3. **Verifiability.** Randomness derives from a public beacon; every drop
   roll can be re-computed and audited by any peer.
4. **Bot indifference.** The protocol does not attempt to detect bots:
   because bots are not tolerated guests here, they are load-bearing
   citizens. Witnesses are bots. The joiners that keep quiet hours alive
   are bots. Since v0.38 their deeds feed the very randomness beacon.
   Economy and progression are designed so automation is priced in, not
   policed (see §8).
5. **Governance by exit.** The rules cannot be amended, only succeeded.
   A rule change is a new world (see §9); players choose their
   constitution by where they play.

## 2. Time

- The world advances in **intervals (ticks)** of 600 ms.
- Tick numbers are unsigned 64-bit integers starting at 0 (genesis).
- All actions resolve on tick boundaries. There is no sub-tick time.
- The genesis object contains `anchorMs`, the wall-clock epoch (Unix ms)
  of tick 0. Tick N finalizes at `anchorMs + (N+1) * 600`. Every node
  runs this schedule independently: the world has one clock, and it is
  arithmetic, not a server. Inputs for tick N must reach a node before
  it finalizes N; a node that stalls past a boundary must re-sync from
  checkpoints rather than guess.

## 2b. Geography (founding layout)

A founding grows two hamlets joined by a trail. **Westhearth** stands
at the western end and **Eastmere** at the eastern end; each holds a
bank, an anvil, and a hearth campfire arranged around the trail row
(`trailY = floor(worldH / 2)`). Fishing waters pool near each hamlet.
Trees, rocks, and goblins scatter across the meadows between,
seed-placed, avoiding the trail and the hamlet grounds. Spawn is the
center of the trail: every citizen arrives on the road, halfway
between the two lights. The trail itself is not state; windows may
paint the road however they like, but the buildings stand where the
constitution says.

## 2d. The city of Anchor

North of the crossroads, at the road's end, stands **Anchor**: the
walled city, named for the founding moment every genesis carries. Its
bounds are the rectangle `x in [cx-8, cx+8], y in [2, 10]` where
`cx = floor(worldW / 2)`. Walls (inert, impassable) trace the
perimeter, broken by a three-tile gate in the south wall at
`x in [cx-1, cx+1]`, flanked by guards. **No mob may enter the city
bounds**: the wander rule refuses any step into them. Inside stand a
bank, a walled smithy with its anvil and smith, houses, a well, and a
hearth. Inert citizen-shaped nodes (`guard`, `smith`) are furniture
with faces: impassable, unattackable, and reassuring.

New inert node types: `wall`, `signpost`, `guard`, `smith`, `well`.

## 2e. The highlands, the cave, and the deep forest

Northeast of Anchor rise the **rocky highlands**: dense ore and, glinting
among the gray, **magic rocks**, veined with light. Sunk into the
highlands is **the cave**, a dark gallery where **trolls** dwell.
Southwest across the trail spreads the **deep forest**, thick with
trees. Windows may paint the cave dark and the forest deep; the nodes
and mobs stand where the founding says.

## 2f. The wide world (v0.30)

The founding grows to town scale. Along the great east-west road:
**Westhearth** and **Eastmere** as before. North up the king's road:
**Anchor**, the walled city. Northeast: the **highlands** and the
**cave**. Southwest: the **deep forest**, now the haunt of the
**bear**. South down the lake road lies **Stillwater**, a fishing
village on the shore of the great lake, keeping the world's first
**general store**. Southeast sits **Milbrook**, a quiet town of
houses, bank, anvil, and well. Roads are painted by windows; every
building, water tile, and creature stands where the founding says.

## 6l. The store and gold (the first coin)

Each citizen carries `gold` (an integer, starting 0). `sell {slot}`
is valid beside a `store` node when the slot's item has a listed
price; it resolves same-tick: the whole stack is consumed and
`gold += price * qty`. Prices: logs 2, ore 5, raw-fish 3,
cooked-fish 6, bones 2, arrows 1, magic-stone 20, bronze-sword 15,
bronze-hatchet 10, bronze-pickaxe 10, bronze-helm 12, bronze-plate 30,
wooden-bow 8. Gold survives death (coin knows no master) and is not
an inventory item. What gold BUYS is reserved for a future amendment:
the till is patient.

New inert node type: `store` (with its `keeper`).

## 6q. Starmetal (v0.37): the second use of magic stone

At any anvil, magic stones smith into **starmetal**, and here the
world gains its first level requirements: some things must be earned
before they can be made. `star-sword` (3 magic-stone, 2 ore; requires
smithing 20 AND magic 10; +4 max hit). `star-helm` (2 magic-stone,
1 ore; smithing 15, magic 5). `star-plate` (4 magic-stone, 3 ore;
smithing 30, magic 15). Starmetal armor soaks 2 per piece where
bronze soaks 1. It sells dearly (sword 120, helm 60, plate 200) and
dies with you like everything else. The requirements are validity,
not ceremony: an unearned hammer strikes nothing.

## 6r. The chain (v0.37): the one fast weapon

Trolls rarely drop an **old-chain**: iron links, worn smooth; nobody
remembers what it anchored. Wielded, it grants +1 max hit: and one
property no other weapon has. Combat breathes (6m), **but the chain
does not**: its wielder swings every tick. The defender's rhythm is
unchanged; the chain simply refuses to wait. There is exactly one
fast weapon in this world, and it must be taken from a troll.

## 6p. Fletching (v0.35): the fourteenth skill

Whittling a bow never taught anyone to aim. `fletch` xp moves to its
own skill: bows grant 15 fletching xp, arrows 5. `ranged` is earned
only the honest way: by loosing arrows at something that objects.

## 6o. Farming (v0.34): the thirteenth skill

Growth is state transition made visible: nothing in this world was
ever more constitutional than a seed.

**Plots** are nodes, tilled and waiting near every settlement.
**Seeds** drop from goblins (sometimes; they hoard them and forget
why). `plant {slot}` is valid beside an empty plot with seeds in the
slot: one seed is consumed, the plot records `plantedAt` (the tick)
and `by` (the sower), and grants 10 farming xp.

Growth is a pure function of elapsed ticks: no timers, no watering,
no randomness. Stages derive as sprout (< 400 ticks), growing
(< 800), flowering (< 1200), ripe (>= 1200): twelve minutes from
seed to harvest, identical on every node of the mesh.

`harvest {nodeId}` is valid beside a ripe plot for its sower alone:
**the harvest belongs to whoever sowed**. It yields 2 `grain`
(stackable, like arrows), grants 40 farming xp, and the plot returns
to bare earth. Grain sells for 4 gold; what else grain becomes is
reserved (the oven is patient).

A plot's crop survives checkpoints, restarts, and migrations, because
it is nothing but numbers in the founding's arithmetic: sow before
sleep, and the interval farms while you dream.

## 6n. The quiver (v0.33)

Arrows **stack without limit** in a single slot: fletching and pickup
merge into any arrows already carried. And an archer whose quiver
runs dry mid-fight does not lower the bow in confusion: if the target
stands adjacent, the fight continues bare-handed (or with whatever
the melee math says of a bow used as a club: nothing good). At range
with no arrows, the engagement ends; distance unpaid is distance
lost.

## 6m. Combat breathes (v0.32)

Every engagement carries `since`, the tick it began. Swings: both the
attacker's and the defender's retaliation: resolve only on ticks where
`(tick - since) mod 2 == 0`: one exchange every 1.2 seconds. The first
swing is immediate; the rhythm follows. This paces citizen and beast
alike; there is no fast blade in this world, only a patient one.

**Instant acts do not lower your guard.** `eat` no longer clears a
combat action: swallowing a fish mid-fight is the veteran's way. All
other inputs still interrupt as before.

**A struck citizen strikes back.** In the Wilds, when a citizen with
no combat action of their own is hit by another citizen, they
automatically engage their attacker. Flight remains possible: any
move breaks the engagement, and the boundary still protects.

## 2h. The real world (v0.36): the river, the sea, the mountains

The founding grows to 192 x 96, and gains geography that ROUTES:

**The river** rises in the northern mountains east of Anchor and winds
south to the great lake: a chain of water, impassable and fishable
along its whole length. Where the roads meet it, **bridges** stand:
the road wins, the water flows beneath. **The sea** bounds the east:
the last three columns are open water, and Eastmere is a coastal town.
**The mountains** span the far north on both sides of Anchor: rich in
ore, richer in magic rock. The deep forest, the highlands, the cave,
Stillwater, and Milbrook keep their places, scaled. The Wilds grow
with the world: `x in [1, 34], y in [1, 22]`.

## 2i. Norwick and the wider world (v0.40)

The founding grows again, to 288 x 144, lengthening every road the
constitution already draws. Fixed near the Wilds' southern border,
at `x in [36, 50], y in [24, 36]`, stands **Norwick**: a walled
garrison town, smaller and grimmer than Anchor, built for one reason
— holding the line against the lawless quarter at its back. Walls
trace its perimeter, broken by a gate in the south wall flanked by
guards; **no mob may enter its bounds**, the same law that protects
Anchor. Inside stand a bank, an anvil, houses, a well, a hearth, and
farming plots. Outside its walls, on the side facing away from the
Wilds, a small quarry supplies the ore a garrison spends on itself.
Norwick is reached by leaving the king's road on foot; no path is
drawn in state, as ever, only the town itself is law.

New inert node type: none (Norwick reuses `wall`, `guard`, `bank`,
`anvil`, `well`, `house`, `signpost`, `rock`, `plot`). New founding
constant: a second mob-forbidden rectangle, checked alongside
Anchor's wherever the wander rule applies.

## 2j. The road learns to bend, and the world to feel walked (v0.41)

The founding grows once more, to 320 x 200, calibrated rather than
guessed: at one tile per interval, Westhearth to Eastmere along the
full breadth of the road is a three-minute walk, Anchor to Stillwater
under two, the shortest hop under a minute. Distance in tiles **is**
distance in seconds; a founding's dimensions are now chosen against
that arithmetic, not eyeballed.

**The road bends.** `trailYAt(genesis, x)` replaces the flat trail
row: true and level through every settlement and the river crossing,
it winds through open country between them on a seeded curve, same
treatment the river has always had. Nothing paints the road as state;
windows compute the curve themselves, as they already do for the
river.

**The hamlets stop mirroring each other.** Westhearth keeps its
modest bank-and-anvil founding. Eastmere trades its anvil for a
store and two dockside fishing spots: a port, not a second
Westhearth. Anchor gains a second forge and its own store: the
capital both smiths and trades. Milbrook keeps no forge at all: bank,
well, houses, plots, nothing else — a farming town and only that.

**Danger now shows before it bites.** Approaching the mountains, the
Wilds, or the cave, trees thin probabilistically the closer a tile
sits to the boundary, and bare rock backfills the gaps: the ground
tells a citizen they are leaving the safe country before any wolf
does. This is a founding-time density gradient, not a client tint:
the thinned tiles are genuinely treeless in every node's state.

**Growth clusters.** Trees, open-field rock, and goblins no longer
seed independently across their whole range; each kind rolls a
handful of cluster centers first, then place mostly near one of them.
Woods read as woods, and goblins keep camps, not a uniform sprinkle.

**Landmarks (§3, node field `text`).** `addNode` now accepts an
optional extra-fields object, merged onto the node. Signposts carry
a `text` field: unique flavor per post, shown on interaction, in
place of one generic message repeated at every post. Eight stand
along the founding's roads, plus two solitary `wall` nodes standing
alone in open country as ruins — nothing built beside them, on
purpose.

New founding constant: none. New node field: `text` (optional,
currently used by `signpost`).

## 2k. Waystones (v0.42): the road remembers who walked it

Each settlement holds a **waystone** node. Stand orthogonally beside one
and you **attune** to it: its id is appended to your `attuned` list, and
the world remembers it forever. Thereafter `recall {to}` steps you out of
the world beside one waystone and back in beside another you have walked
to — instant, free, no material spent. Convenience, not power.

Two rules keep it honest. You may only recall to a stone you have
**attuned**, so the first journey to any place is always made on foot and
the world still feels walked. And you may **never** recall while inside
the Wilds: magic will not carry you out of danger you chose to enter. The
slow road stays open to everyone; the waystone only spares you the
re-walking of ground you have already earned.

New node type: `waystone`. New player field: `attuned` (array of waystone
ids, defaults empty). New action: `recall`.

## 2g. The Wilds (where the law thins)

The northwest quarter's far corner is the **Wilds**: the rectangle
`x in [1, 34], y in [1, 22]` (as amended in 2h). Inside it, and only inside it,
`attackp {targetId}` is valid: citizen against citizen, melee adjacent
or bow within 4, resolved by the same combat law as any beast. Both
attacker AND target must stand inside the Wilds: the boundary protects
whoever keeps a foot in the lawful world. A citizen slain in the Wilds
drops every carried item where they fall, for anyone to take: the only
place in the world where loot comes from people. Equipment is
destroyed as ever. Enter armed, or enter fast.

## 2c. The hedge is law

The outermost ring of tiles is impassable to players and mobs alike:
the world ends one tile before its arithmetic does. Windows may paint
the boundary as hedgerow, fence, cliff, or sea; what they may not do
is let anyone stand in it.

## 3. World state

The world state is a canonical JSON object (sorted keys, no whitespace)
containing:

- `tick`: current tick number
- `players`: map of playerId → Player
- `nodes`: map of nodeId → ResourceNode
- `names`: map of name → playerId (see §5a)
- `mobs`: map of mobId → Mob (see §3.3)

`playerId` is the hex-encoded public key of the player's keypair.
The **state hash** is SHA-256 of the canonical JSON encoding.

The genesis object is
`{specVersion, rulesHash, genesisSeed, anchorMs, worldW, worldH,
worldGenerator}`. `worldGenerator` names the deterministic generator
that founds this world (currently `"interval-classic-v1"`), so a
founding record can never be ambiguous about which world it founds; a
node that does not implement the named generator refuses to build the
world rather than guessing. The genesis schema is EXACT: the seven
fields above plus the optional trio `witnesses`/`quorum`/`imported` —
any other key is refused (a key execution ignores still changes the
worldId, minting a distinct founding identity with identical behavior),
and `witnesses` and `quorum` are supplied together or not at all.
Signed inputs are equally exact: one canonical serialized form per
action (per-type field schemas with explicit types; trade offers carry
BOTH demand fields, `wantItem: null` or `wantGold: 0` written out —
omission is not a representation).

### 3.1 Player

| Field       | Type            | Rules                                  |
|-------------|-----------------|----------------------------------------|
| `x`, `y`    | int             | Tile coordinates                       |
| `skills`    | map skill→xp    | XP is a non-negative integer           |
| `inventory` | array, max 28   | Slots hold `{item, qty}` or null       |
| `action`    | Action or null  | Current ongoing action                 |
| `name`      | string or null  | Claimed display name (see §5a)         |
| `trade`     | Offer or null   | Open trade offer (see §5c)             |
| `equipment` | {weapon}        | Wielded item or null (see §5d)         |
| `bank`      | map item→qty    | Vaulted goods (see §6g)                |

### 3.2 Resource nodes

A node is `{type, x, y, depletedUntil}`. Types: `tree`, `rock`,
`fishing-spot` (gatherable); `campfire` (permanent; enables cooking,
§6a); `fire` (player-made via firemaking §6f, carries `expiresAt` and
vanishes at the start of that tick; enables cooking like a campfire);
`anvil` (enables smithing, §6d); `bank` (enables banking, §6g); and
`house` (inert and impassable: the shelter of the hamlets, §2b). A node with `depletedUntil > tick` yields nothing and
cannot be targeted.

Gather yield table: `tree` → `logs` (woodcutting, 25 XP), `rock` →
`ore` (mining, 35 XP), `fishing-spot` → `raw-fish` (fishing, 30 XP).

### 3.3 Mobs

A mob is `{type, x, y, hp, respawnAt}`. Mobs are placed in genesis, do
not move, and act only when attacked (fully deterministic). A mob with
`hp <= 0` is dead until `respawnAt`, when its hp resets to max at the
start of the tick.

Mob stats table (v0.9): `goblin`: 5 max HP, attack 1, defence 1,
max hit 1, respawns 16 ticks after death. Drops on death, rolled on the
beacon: `bones` (always) and `ore` (chance 64/256).

### 3.4 Ground items

World state includes `ground`: a map of groundId →
`{item, x, y, expiresAt}`. Dropped items lie where they fell, visible
to all and takeable by anyone; at the start of each tick, items with
`expiresAt <= tick` vanish. The ground forgets in about a minute.

**Wandering (v0.20).** At the start of each tick, after respawn
processing, every living mob that no living player's action targets
takes a wander roll in lexicographic mobId order:
`roll(beacon, mobId, "wander") < 48` (about one step every five
ticks). On success, `roll(beacon, mobId, "dir") % 4` picks north,
east, south, or west. The step is taken only if the destination is in
bounds, free of nodes, and within Chebyshev distance 2 of the mob's
**home** (its genesis position, stored as `hx, hy`). A mob under
attack stands and fights. Mobs respawn at home. The goblins pace
because the beacon says so; every node watches them pace identically.

**Mob kinds.** `goblin` (5 hp, meadow-dweller) and, from v0.25,
`wolf` (8 hp, hits up to 2, drops bones and sometimes more bones); and, from
v0.29, `troll` (20 hp, hits up to 3, dwells in the cave, drops bones,
ore, and rarely a bronze-plate it has no use for); and, from v0.30,
`bear` (14 hp, hits up to 2, keeps the deep forest, drops bones and
rarely the hatchet of the last woodcutter who argued); and, from v0.42,
the **`skeleton-knight`** (18 hp, defence 6, hits up to 4, respawns 120
ticks) — a horned, shield-bearing warrior that musters in **warbands** in
and around the Wilds, seldom alone. Its round shield makes it hard to
strike; its longsword bites back. A fallen knight gives up **double
bones** (the frontier's best prayer), sometimes scavenged ore, and rarely
the horned helm itself.
Wolves keep to the fringes of the world; the hedgerows are theirs.
Every mob kind inherits wandering, pinning, home respawn, and
drops-to-ground from the universal mechanisms; a new creature costs
one stats row and one sprite.

## 4. Skills and XP

v0.25 skills: `woodcutting`, `mining`, `fishing` (gathering);
`cooking`, `smithing`, `firemaking` (processing); `prayer` (rite);
`attack`, `defence`, `hitpoints` (combat). Gathering
creates items, processing consumes them, combat consumes everything.
Players start with `hitpoints` at 1,154 XP (level 10); all other skills
at 0. Max HP equals the hitpoints level.

Level from XP uses a classic exponential curve: level L requires total XP

```
xp(L) = floor( (1/4) * sum_{n=1}^{L-1} floor(n + 300 * 2^(n/7)) )
```

The table is **hardcoded as spec constants** (see the reference
implementation's `XP_TABLE`); implementations MUST use the constants,
not recompute them. Anchor values: level 2 = 83 XP, level 50 = 101,333,
level 99 = 13,034,431. Levels range 1–99.

## 4b. Beyond mastery

The level function does not stop at 99: it continues by the same
recurrence. Every mechanic that reads a level reads `min(level, 99)`:
mastery is the ceiling of power, and nothing past it buys a stronger
swing or a faster axe. Levels past 99 are honor, proof of intervals
spent. A bot can reach them; so can you. The ledger does not care, and
that is the point.

The recurrence is not literally infinite, and the constitution should
not pretend otherwise. Experience is a state field, and every state
field is bounded so that a hostile checkpoint cannot carry an absurd
number and so that all arithmetic stays exactly representable: the bound
is `MAX_XP`, 10^12, which is **level 212**, one hundred and thirteen
levels above mastery. This is a bound on what a number can *be*, not a
wall the design puts in anyone's way. Mastery costs 13,034,431
experience; the ceiling is 76,720 times that, some four centuries of
unbroken play in a single skill at a rate nobody sustains. It is written
down here because a constitution that claims "without bound" and means
"bounded at 212" is lying in a way that would eventually have to be
corrected, and corrections cost forks.

## 4c. Mastery and the cape

**Mastery** is level 99 in a skill: the ceiling of power (4b). The
recurrence runs far past it, to the representational bound of §4b, which
no amount of play reaches.

The mastery cape is not an item. It cannot be bought, traded, dropped,
or lost to death, because it is not a thing: it is a fact about a
citizen's XP, and windows are invited to paint that fact as cloth. The
reference window renders one cape in the color of the mastered skill,
gold trim for a second mastery, and a radiant cape for all nine.
Mastery is proved by the state and verified by every node; the cape is
simply what proof looks like from a distance.

## 5. Actions

Players submit **inputs**, each signed by their key:

```
{ tick, playerId, type, ...params, sig }
```

v0.1 input types:

- `move` → `{dx, dy}` where dx,dy ∈ {-1,0,1}; moves 1 tile per tick.
  The world is a bounded grid of **genesis-defined size**: the genesis
  object carries `worldW` and `worldH` (defaults 320 × 200, the canonical classic-generator size), and a move
  whose destination lies outside is invalid. The world has edges
  because its founding says so: and how much world there is, is a
  founding decision like everything else. Resource nodes (all types,
  including campfires) are **impassable**: a move onto a tile occupied
  by a node is invalid. You fish beside the water, not in it.
- `gather` → `{nodeId}`; must be adjacent. Throughout this spec,
  **adjacent means orthogonally adjacent** (Manhattan distance exactly
  1): you stand before what you work, facing it. Diagonal interaction
  is invalid; diagonal *movement* remains legal.
- `stop` → cancels current action.
- `recall` → `{to}` (v0.42); teleport beside waystone `to`. Valid only if
  you have **attuned** to that waystone (stood beside it) and you are
  **not** in the Wilds. Instant, free. The slow road remains for those who
  would walk it.
- `claim_name` → `{name}`; see §5a.
- `spawn` → no params; see §5b.
- `offer_trade` → `{to, giveSlot, wantItem}`; see §5c.
- `accept_trade` → `{from}`; see §5c.
- `cancel_trade` → no params; see §5c.
- `cook` → `{slot}`; see §6a.
- `attack` → `{mobId}`; mob must exist, be alive, and be adjacent.
  Sets an ongoing attack action (§6b).
- `smith` → `{recipe}`; see §6d.
- `wield` → `{slot}`; slot must hold an equippable item. Swaps it with
  the current weapon (which returns to that slot).
- `unwield` → no params; weapon returns to the first free slot.
- `light` → `{slot}`; slot must hold `logs`; see §6f.
- `deposit` → `{slot}` and `withdraw` → `{item}`; see §6g.
- `drop` → `{slot}`; slot must hold an item. The item leaves the
  inventory and becomes a **ground item** on the player's tile,
  expiring 100 ticks later (§3.4).
- `pickup` → `{groundId}`; valid iff the item exists, the player stands
  on its tile, and a free inventory slot exists.
- `eat` → `{slot}`; slot must hold `cooked-fish`. Consumes it, heals
  3 HP (capped at max HP), and **clears the player's current action**,
  you stop what you are doing to eat. Re-engaging costs a future input,
  so eating mid-fight trades a swing for the heal. Resolves in the
  same tick.

Rules:

- Inputs are signed with the player's ed25519 key over the canonical
  encoding of the input without its `sig` field. The state machine
  itself verifies signatures: an input with a missing, forged, or
  stale-tick signature is invalid. `playerId` is the hex-encoded raw
  32-byte public key.
- One input per player per tick. Extra inputs for the same tick are
  invalid; the entire tick bundle from that player is discarded.
- Inputs for tick N must arrive before the network finalizes tick N
  (transport concern, out of scope for the state machine).
- Invalid inputs (out of range, bad node, full inventory) are **ignored**,
  never partially applied.

## 5a. Names

Names are in-world objects governed by the constitution, not an
external service.

- A name matches `^[a-z0-9-]{1,12}$` and may not start or end with `-`.
- `claim_name` is valid iff the name is unclaimed AND the claiming
  player has no name. First valid claim wins, forever (v0.4 has no
  release or transfer; a future constitution may add them: that is a
  fork, as always).
- On success: `names[name] = playerId` and `player.name = name`.
- Clients SHOULD render names where known and MUST fall back to the
  playerId prefix otherwise.

## 5b. Spawning

A player need not exist in genesis to join a world.

- `spawn` is valid iff `playerId` is not already in `players`. It is the
  ONLY input type valid for an unknown playerId.
- On success the player is created at the **spawn point**: the center
  tile `(floor(worldW/2), floor(worldH/2))`: with
  empty inventory, no name, no action, level-1 skills.
- Spawning is permanent: there is no despawn in v0.6. Identities are
  free, but each playerId spawns at most once, ever.

## 5c. Trade

Trade is a two-phase atomic swap between adjacent players. Adjacency is
deliberate: trade requires *being there*.

- `offer_trade {to, giveSlot, wantItem}`: valid iff `to` is another
  existing player, `giveSlot` holds an item, and `wantItem` is an item
  string. Sets `player.trade = {to, giveSlot, wantItem}`. A new offer
  replaces any previous one.
- `accept_trade {from}`: valid iff `from` has an open offer targeting
  the acceptor, the two players are adjacent (orthogonally), and the
  acceptor holds at least one `wantItem`. On success, executed
  atomically in the same tick: the offerer's `giveSlot` item and the
  acceptor's first `wantItem` slot are swapped, and the offer clears.
  If any condition no longer holds at application time (item gone,
  players moved apart), the accept is ignored: never partially applied.
- `cancel_trade`: clears the caller's open offer.

There is no partial trade, no negotiation protocol, and no escrow: the
swap either happens whole in one tick or not at all.

## 5e. Presence: awake and asleep

Each player carries `lastInput`: the tick of their most recent applied
input, set at spawn and updated whenever any input of theirs applies.
A citizen is **awake** iff `tick - lastInput <= 500` or their `action`
is non-null; otherwise they are **asleep**. Sleep is never stored: it
is derived, like the time of day. A sleeping citizen stands where they
stopped, blocks nothing, and can complete no trade (accepting requires
an input, which would wake them). Any input wakes the sleeper. The
world never forgets a citizen; it lets them rest.

## 5f. World announcements: milestones every citizen sees (v0.48)

The world keeps a short herald's log, `state.announce`: an ordered list
of at most 24 recent `{tick, text}` entries, and a permanent honors
roll, `state.firsts`, mapping a milestone key to the id of the citizen
who reached it first. Both are written only by the deterministic rules
below, so every node computes byte-identical announcements and one
agreed record of who was first — "first ever" is a fact of the state,
not a claim any window can invent.

**Mastery.** When a citizen's XP in a skill first crosses the mastery
threshold (`XP_TABLE[99]`) on a tick, the world announces it. The very
first citizen ever to master a given skill is named as such (and
recorded in `firsts` under `master:<skill>`); everyone after is
announced plainly. When the crossing that a tick produces leaves a
citizen at mastery in **all** skills for the first time, the world
announces a **Master of Interval** — and the first ever to achieve it is
recorded under `firsts.totalmaster`. This is expected to be
vanishingly rare; the honor is permanent.

**Anniversaries.** On every tick that is an exact multiple of
`TICKS_PER_YEAR` (`round(365.25 · 24 · 3600 · 1000 / TICK_MS)`), the
world marks its own age. Because it is a pure function of the tick, the
year turns identically for everyone.

The log is bounded and the honors roll is finite (one entry per skill
plus totals and any named firsts), so neither grows without limit. The
herald changes no other state: a windows renders these cries how it
likes, or ignores them; the record is the same regardless.

## 6. Gathering resolution

While a player's `action` is `gather(nodeId)`, on each tick:

1. If node is depleted or player is no longer adjacent → action ends.
2. Compute success roll `r = roll(beacon, tick, playerId, "gather")`,
   a uniform integer in [0, 255].
3. Success threshold: `T = 64 + 2 * level(skill)` capped at 240.
   Success iff `r < T`.
4. On success: add 1 resource item (`logs` for tree, `ore` for rock) to
   the first free inventory slot; award XP (`tree`: 25, `rock`: 35);
   node becomes depleted for 8 ticks (`depletedUntil = tick + 8`).
5. If inventory is full, the action ends with no roll.

## 6a. Cooking (the first sink)

`cook {slot}` is valid iff the slot holds `raw-fish` and the player is
orthogonally adjacent to a `campfire` node. It resolves in the same
tick:

1. `r = roll(beacon, playerId, "cook")`, uniform in [0, 255].
2. `T = 64 + 2 * level(cooking)`, capped at 240. Success iff `r < T`.
3. Success: the slot becomes `cooked-fish`; award 30 cooking XP.
4. Failure: the slot becomes `burnt-fish`; no XP.

Either way the raw fish is consumed: cooking destroys supply. Burn
rate falls as the skill grows, exactly like the classic curve.

## 6b. Combat resolution

While a player's `action` is `attack(mobId)`, on each tick, after mob
respawns are processed:

1. If the mob is dead or no longer adjacent → action ends.
2. Player swing: `r = roll(beacon, playerId, "atk")`;
   hit threshold `T = clamp(128 + 4*(attackLvl − mobDef), 16, 240)`.
   On hit: `dmg = 1 + (roll(beacon, playerId, "dmg") mod maxHit)` where
   `maxHit = 1 + floor(attackLvl / 10)`. Subtract from mob HP; award
   `4×dmg` attack XP and `dmg` hitpoints XP.
3. If the mob dies: drops roll on the beacon and go to the killer's
   free inventory slots (full inventory forfeits that drop);
   `respawnAt = tick + respawn`; action ends.
4. Otherwise the mob retaliates: threshold
   `clamp(128 + 4*(mobAtk − defenceLvl), 16, 240)`; on hit the player
   loses `1 + (roll(beacon, playerId, "mobdmg") mod mobMaxHit)` HP;
   on a miss the player gains 4 defence XP.

## 6c. Death (provisional: the most fork-worthy rule in this document)

If a player's HP reaches 0, the body lies where it fell for **5 ticks**
(v0.41): during them the dead act on nothing and cannot be acted upon.
The world holds its breath; windows may grieve. At the fifth tick the
citizen returns to the spawn point at full HP with their action cleared
and their **entire inventory and equipment destroyed** (in the Wilds,
spilled where they fell: spec 2g). Skills, XP, name, and **bank**
survive. Destroyed items leave the world: death is the deepest sink.

This severity is explicitly provisional. No sentence in this document
can declare a fork legitimate or illegitimate: legitimacy is adoption,
and adoption belongs to whoever shows up. Softer death rules are simply
expected.

## 6d. Smithing (the ore sink)

`smith {recipe}` is valid iff the player is orthogonally adjacent to an
`anvil` and holds the materials. It resolves in the same tick, always
succeeds, consumes the materials, places the product in a free slot,
and awards 30 smithing XP per ore consumed.

| Recipe           | Materials       | Effect when wielded            |
|------------------|-----------------|--------------------------------|
| `bronze-sword`   | 2 ore + 1 logs  | +2 max hit in combat           |
| `bronze-hatchet` | 1 ore + 1 logs  | +24 gather threshold on trees  |
| `bronze-pickaxe` | 1 ore + 1 logs  | +24 gather threshold on rocks  |

## 5d. Equipment

`equipment.weapon` holds at most one wielded item. Wielded gear is
destroyed on death along with the inventory (§6c): the sink spares
nothing. Tool bonuses apply only when the wielded tool matches the node
type; the sword bonus applies only in combat.

## 6f. Firemaking (the logs sink)

`light {slot}` is valid iff the slot holds `logs` and the player's own
tile carries no node. It resolves in the same tick on the beacon:
`T = 64 + 2*level(firemaking)`, capped at 240. On success the logs are
consumed, 40 firemaking XP is awarded, and a `fire` node appears on the
player's tile with `expiresAt = tick + 100`: light that cooks, made by
hand, gone in a minute. On failure the logs survive for another try.
On success the maker **steps aside** to the first free orthogonal tile
(west, east, south, north, in that order); only if all four are blocked
do they remain standing amid their own flames. Nobody builds a fire to
stand in it.

## 6g. The bank

`player.bank` is a map of item → quantity: goods vaulted outside the
world's dangers. `deposit {slot}` and `withdraw {item}` are valid only
orthogonally adjacent to a `bank` node (withdraw also needs a free
inventory slot). One item per interval: patience is the fee.
**The bank survives death** (§6c): what you carry can burn; what you
vault endures. This is the world's memory, and the foundation of wealth.

## 6k. Magic (the dark half of the interval)

Mining a `magic-rock` yields a `magic-stone` (30 mining xp; the rock
rests long after). **The night gate is repealed (v0.40).** Invoking a
sigil requires three magic-stones and nothing else: any tick, any sky.
The old rule (`invoke` valid only while the shared day-cycle read
night) was deterministic arithmetic, not wall-clock authority: but its
only effect was mandatory waiting, and waiting is the one cost this
constitution rejects. The stones price the sigil. The day cycle
remains in the spec as shared cosmology for the windows to paint:
it decides nothing.

`cast {spell}` spends sigils. The first spell is `anchor` (1 sigil,
30 magic xp): the caster is returned instantly to the plaza beside the
well of Anchor, the fixed point every genesis carries. Further spells
are reserved for future amendments; the dark is patient too.

`magic` joins the skills: the twelfth.

## 6i. Armor (the deeper ore sink)

Two new anvil recipes: `bronze-helm` (1 ore, 1 logs, 30 xp) and
`bronze-plate` (3 ore, 1 logs, 90 xp). Equipment gains `head` and
`body` slots beside `weapon`; `wield` routes each item to its slot.
Worn armor soaks incoming damage: each piece reduces every hit taken
by 1, to a minimum of 0. Death destroys all of it. The sink spares
nothing, and now it eats plate.

## 6v. The star-dagger and the root (v0.49)

A fourth star recipe: `star-dagger` (2 magic-stone, 1 ore; smithing 20,
magic 15; wield attack 20). It strikes for less than the star-sword (a
+2 hit, not +4) — its worth is not the edge but the **root**.

When a successful star-dagger blow lands on a living target — mob or
citizen — and the wielder's root is ready and the target is neither
already rooted nor within its post-root immunity, three things happen
together: the target is **rooted** for `ROOT_TICKS` (3) ticks and cannot
move for their duration; the target gains **immunity** for a further
`ROOT_IMMUNE` (10) ticks, during which no dagger may root it again; and
the wielder's dagger goes on **cooldown** for `ROOT_CD` (120) ticks. A
rooted entity's move inputs resolve to no motion; a rooted mob does not
wander or pursue. Damage is unaffected by any of this — only the root
is gated. Roots never stack and never chain: at most one target is held
by one dagger at a time, and the immunity window forbids a second
dagger from seizing a body the instant the first releases it. The long
cooldown makes landing a root a decision, not a rhythm — a rare, earned,
expensive thing, as a frontier weapon forged from compressed night
should be.

## 7. Exploration: the world as profession (v0.50)

The fifteenth skill. Its verb is `survey`; its XP is paid in distance;
its goods are **charts**. Every value below is deterministic — markers,
rewards, and charts are pure functions of the beacon and the state, so
every node agrees without a word passing between them.

### 7a. Survey markers

`state.markers` holds `genesis.survey.k` points of interest, each a
`{ x, y, kind, bornAt }` (and a `ws` id when it is a rumor). Whenever
the world holds fewer than `k`, the top-up mints replacements. Marker
position and kind are drawn from `H(beacon || tick || index || salt)`,
rejected until the tile is in-bounds, outside every city, and off every
node — and **distance-weighted**, so most markers land in the near and
middle country and the deep-Wilds ones are genuinely rare. A marker
unclaimed after `MARKER_LIFE` (3000) ticks relocates: the frontier
never goes stale.

Most markers are `ord` (ordinary). A minority are `ws` **rumors**,
minted beside a waystone; surveying one yields that waystone's chart.

### 7b. `survey`

`survey` is valid when a living citizen stands on a marker's tile. It is
**instant** — the cost was the walk, not a channel. On resolution it
pays Exploration XP by distance (7c), yields a chart if the marker was a
rumor and the pack has room, records the first-ever surveyor in the
honors roll, and **relocates the marker**. First-come and single-claim:
reaching the deep one first is the race.

### 7c. XP paid in distance

```
xp = min( survey.max, survey.base + survey.perTile * chebyshev(marker, anchor) )
```

**These constants live in the genesis, not the protocol.** The classic
world founds itself with `{ k: 8, base: 40, perTile: 10, max: 1800 }` —
values *derived from a survey-simulation of its own geometry*. They
are not a universal curve. A larger world is free — indeed expected — to
found itself with a different `k`, `base`, `perTile`, and `max`, derived
from *its* geometry by *its* own simulation. One numerical curve does
not fit every world scale, and the constitution does not pretend it
does. What is constitutional is the *form* of the reward; the *numbers*
are a property of the founded world.

Why this reaches mastery on a finite map: it is not coverage that is the
grind but *journeys*. Markers relocate forever, so the XP is bounded
only by traversal time — exactly as a finite set of respawning rocks
supports mining to 99. A bot cartographer pays for it in the same walked
ticks a human does.

### 7d. Charts — knowledge as a portable capability

A chart is `chart:<waystoneId>`: an ordinary, stackable, **tradeable**
inventory item. Because canonical state is public, a chart is not secret
information — the waystone's location was always derivable. A chart is a
transferable **capability**: `read_chart` spends it to add that waystone
to the bearer's `attuned` set, granting recall access *without ever
walking there*. The explorer converts distance walked into charts and
sells recall access to citizens who would rather pay than walk. The
waystone set is fixed at founding, so charts are a small set of fixed
variants — no per-item payload, no change to the slot schema.

### 7e. Constitutional consequences

`SKILLS` gains `exploration`; **Master of Interval is now mastery in all
fifteen**, and the honors roll gains `master:exploration` and a first
`surveyor`. `genesis.survey` joins the founding record (and the worldId
it hashes to). `state.markers` is bounded to `k`. Two items
(`chart:*`) and two actions (`survey`, `read_chart`) join the
vocabulary. Bot indifference holds: a bot that walks the frontier and
sells charts is a load-bearing citizen, not an exploit.

## 8. Brewing: the profession the world waits for (v0.51)

The sixteenth skill, and the first whose passive part is genuine: the
*world* does the waiting. A brewer starts a batch, lives the rest of
their day, and returns to a finished, tradeable draught. It stays honest
the way every passive thing must — **the gain consumes a good that took
active effort to make** (grain, fish, and the logs and ore of the pot
itself), so a bot earns nothing it did not first gather.

### 8a. Brewpots

A brewpot is an owned, placed node (`type: 'brewpot'`, fields `by`, and
while fermenting `readyAt` + `brewKind`). `build_brewpot` raises one on a
free tile beside the founder, consuming `brew.buildLogs` logs and
`brew.buildOre` ore — **but only adjacent to a `house`.** The protocol
knows nothing of taverns; it knows only "a brewpot must stand by a
roof." A brewhouse — a house ringed with brewpots and the people who
gather there — is a meaning *players* assign, the way they made trade
routes of waystones. A citizen may own at most `brew.potCap` brewpots.
The cap is flat: capacity is bought, not leveled — running four pots is
an act of supply and organization, not a reward the protocol hands out
for grinding.

A brewpot is **walkable** — a citizen may stand on or step through its
tile — so no arrangement of pots can ever wall a doorway or fence a
citizen in or out; the commons stays passable. A pot **abandoned** (not
built, brewed, or collected at) for longer than `brew.decayTicks`
crumbles and returns its tile to the world, so brewpots can never
permanently enclose the buildable space against newcomers — active pots
reset the clock, only neglect reclaims. And a founder may `dismantle`
their own pot, recovering half its makings and freeing the ground, so a
brewhouse can be moved rather than merely abandoned. Owned, yes — but
never a permanent private claim on the common ground.

### 8b. Brew, wait, collect

At an idle brewpot they own, a founder `brew`s, consuming one input —
`grain → ale`, `raw-fish → broth` — and setting `readyAt = tick +
brew.ferment`. Nothing more happens until the world reaches that tick;
fermentation is **deterministic**, so a brewer knows exactly when a
batch lands (Interval treats time constitutionally; a brewer should not
be made to guess). Pots ferment on world-ticks whether their founder is
present or not. When `tick >= readyAt`, the founder `collect`s: the
draught enters the pack, Brewing XP is paid **on the completed batch**,
and the pot returns to idle. Active at both ends, patient in the middle.

### 8c. The goods

`ale` and `broth` are ordinary, stackable, tradeable items that
**restore** on `eat` (broth a little more than a cooked fish, ale a
little less) — restoration, not buffs, so Brewing stays inside the food
system without a layer of buff-management. Their point is the market:
farmer → grain → brewer → ale → everyone; fisher → fish → brewer →
broth. Brewing couples the professions that already exist.

### 8d. The constants are the world's

`brew: { ferment, potCap, buildLogs, buildOre, xpPerBatch }` lives in the
**genesis**, part of the founding record. The classic world founds
itself with values derived from a brew-simulation of a brewer tending a
rotation of pots — sized so mastery is a matter of *regular brewing over
time*, not a number of hours anyone announces. A larger or busier world
tunes its own. What is constitutional is the *shape* — start, wait,
collect, at a flat-capped rotation — not the numbers.

### 8e. Watchfires: Firemaking as public infrastructure (v0.53)

The public-light idea that first wore the name "Beaconry" belongs in
**Firemaking**, not in a skill of its own. A citizen is not "a
beacon-keeper"; they are an experienced firemaker tending a great fire.
Folded in, it enriches an existing profession and leaves the skill list,
and Master of Interval, honest.

A **watchfire** is an owned, placed node (`type: 'watchfire'`, fields
`by` and `fuelUntil`). At Firemaking `watch.level` a citizen may
`kindle` one on free ground, spending `watch.kindleLogs` logs at once. It
**burns** while `tick < fuelUntil`, and while it burns it lights the
country around it for every citizen who passes, not only its keeper. No
one owns the light.

**Fuel is the whole economy of it.** `stoke` feeds one log to any
watchfire and extends its burn by `watch.perLog` ticks, banking forward
from whichever is later, the present tick or the fire's remaining burn,
and never past `watch.cap` ticks ahead. A fire cannot be loaded with a
year of wood and abandoned; it must be *returned to*. Every log
delivered pays `watch.xpPerLog` Firemaking experience to **whoever
delivered it**, so feeding a neighbour's fire is not charity. While a
fire burns, its keeper earns a further `watch.burnXp` per tick: the light
is public, the vigil is theirs. Because burn time is bought only with
logs, that trickle is fuel-proportional, and no citizen earns anything a
forester did not first cut. A citizen keeps at most `watch.maxOwned`
watchfires, so the map cannot be carpeted for a passive wage.

Watchfires are **walkable**, as brewpots are: nothing a citizen builds
may wall a door or fence a neighbour in. A fire left cold for longer
than `watch.decayTicks` crumbles to ash and returns its ground to the
commons.

As with survey and brewing, `genesis.watch` lives in the founding
record, not the protocol: a larger, darker world may want longer burns,
cheaper fuel, or more fires to a keeper, and is free to found itself
that way. What is constitutional is the shape, logs in, light out,
never a wage without wood.

## 10. Standing and calling: who a citizen is (v0.55)

For a while every window invented its own idea of a citizen's "level" and
they disagreed about the same public state: one averaged three combat
skills, another averaged five and subtracted two, and computed the skill
levels themselves from a curve that was not the constitutional one. A
number shown beside a citizen's name was therefore a property of the
software someone happened to open, rather than of the person. In a world
whose windows are meant to be views of one truth, that is a category
error. Both are derived here instead.

**Standing** is the sum of a citizen's true level in all sixteen skills:

```
standing = sum over SKILLS of levelForXp(xp)
```

It is `levelForXp`, the continuing level of §4b, and deliberately not
`effLevel`: mastery at 99 is a milestone, not a ceiling, and a citizen
who keeps going past it keeps rising. The only limit on standing is the
representational one of §4b, which puts it near 3,392 and which nobody
will approach. It privileges no profession: an explorer who never draws
a sword and a knight who never brews are measured by the same rule,
which is the only honest measure in a world of sixteen trades.

There is deliberately **no combat level.** Combat is three skills of
sixteen. A world whose countries are wood, stone, water, danger, and
home does not rank its people by their capacity for violence.

**Calling** is the trade a citizen has the most **experience** in,
rendered as a word: forester, miner, fisher, cook, smith, firekeeper,
mourner, archer, sigilist, farmer, fletcher, fighter, warden,
cartographer, brewer.

Experience, not level, is what decides it. Levels are a step function of
experience, so the trade with the most experience always holds the
highest level as well: comparing experience gives the same answer
wherever the levels differ, and settles a tie between two equal levels
the way the citizen expects, in favour of the one they are further
along. Two skills at level 8 are not really equal to the person who
spent the evening at one of them. Only a tie in raw experience falls to
the constitutional skill order, so every node still answers identically.

Hitpoints is excluded, being a consequence of fighting rather than a
trade, and starting at 10 — without that exclusion every citizen would
be born a fighter. A citizen whose every trade is still level 1 has no
calling yet and is a **newcomer**.

A citizen who has mastered all sixteen has a calling of their own:
**Master of Interval**, the same condition the world announces. It is
written now, while nobody is close to it, for a constitutional reason
rather than an aesthetic one: every rule change is a fork, and the day
someone approaches total mastery is the worst possible day to need one.

A calling at mastery reads as one: **master brewer**, **master smith**.
Mastery is the single milestone this world already stops to announce, so
the word a citizen is known by says it. This needs no second rule, and
covers no second case: because the calling is the *most-experienced*
trade, a citizen who has mastered anything at all necessarily has at
least that much experience in their calling, so the word turns to master
exactly when they have mastered something. Past mastery it does not
change again; standing carries the rest. Hitpoints being
excluded, no amount of surviving makes anyone a master of anything.

Together they read as an introduction rather than a score:

```
Erik · brewer (412)
```

The number says how much of the world someone has touched; the word says
who they are. A single scalar would flatten sixteen professions into one
hierarchy, which this world refuses everywhere else. The calling restores
what the scalar throws away, and it is the more useful half socially:
it tells you who to ask for a smithing job, who sells charts, and whose
tavern you are standing in.

Both are pure functions of public state. Neither is stored, so neither
can drift from the skills it describes.

### 4c. The curve is computed exactly (v0.60)

The ninety-eight thresholds of §4b are constants, written out, not
recomputed. Past mastery the curve continues by the same recurrence, and
that continuation is evaluated in exact integer arithmetic rather than
with `Math.pow`, which ECMA-262 leaves implementation-defined. The same
rule governs terrain (§9b) and for the same reason: anything two
implementations could round differently is a place where one world can
quietly become two. A window that recomputes the thresholds instead of
copying them is making the same mistake more cheaply, and is equally
forbidden.

### 7c. The Reading Rule reaches loot (v0.64)

The rule of §7 is that chance may only judge deeds whose lots are not yet
drawn, because the beacon for a tick is public during that tick. It was
first applied to instant deeds: cooking and firemaking are counted, not
rolled, so no one can wait for a kind tick to light a fire.

Loot was not, and it should have been. A drop judged by the beacon can be
**timed**: fight the beast to its last point of life, read the beacon,
and withhold the killing blow until a favourable tick comes round. The
wait for a one-in-thirty-two drop is about twenty seconds, which makes it
not a rare drop but a slow certainty, and it rewards the patience to
exploit rather than the work.

Loot is therefore counted, on the same accumulator: the tally is per
citizen and per drop, so the thousandth troll yields what a troll owes,
in a fixed order that no timing can bend.

Something real is lost here and it is worth naming: the lottery. A rare
drop on the tenth kill is a story, and counting cannot tell it. But in a
world whose beacon is public, dice do not give that story to everyone
equally. A patient program reads the lots and lands its killing blows on
kind ticks; a person swinging in real time cannot. Dice here are not a
lottery, they are a tax on whoever is not automating, and this world's
first promise is that the ledger does not care which of the two you are.
Counting is what makes the rare thing cost the same for a bot and for a
citizen. Most citizens will not keep the tally anyway, so the moment
still arrives unannounced for the person actually playing; the program
knows exactly when it is coming, and feels nothing when it does.

Rates are given out of 65536. The old eight-bit denominator could not
express anything rarer than one in 256, which is not rare enough for a
thing that ends a search. Over any span the count
is exactly the promised rate, with no variance in either direction. The
rare thing stays rare, and it costs the same thirty-two fights whoever
you are.

### 6s. Weapons: the metal is the tier, the shape is the choice (v0.65)

There were two weapons worth carrying and everyone carried the same one.
A world where the only question is *how much ore have you got* answers
nothing about the person holding the sword.

So the shapes were separated from the tiers. No new material was added,
and none will be: the same ore and the same star-stone, worked into
different answers to the same question. A weapon differs along four axes
and each is a real trade, not a bigger number:

| | max blow | swings every | reach | odds |
|---|---|---|---|---|
| dagger | lowest | 2 ticks | 1 | **best** |
| sword | middling | 2 ticks | 1 | even |
| spear | modest | 2 ticks | **2** | even |
| maul | **highest** | 3 ticks | 1 | worst |

A dagger lands often for little, which is what you want against a
skeleton-knight's guard. A maul lands seldom for a great deal, and misses
in a way you feel. A spear keeps a tile between you and the troll. A
sword asks no questions. Bronze asks nothing of the arm; star-steel does.

The **old-chain** remains what it is and stands outside this: it swings
every tick, and nothing else ever will. The **horn-bow** is the archer's
equivalent, drawn from a bear about once in a thousand, and it is the
only reason to hunt one. Neither can be forged, and that is the point:
almost everything in this world is reachable through a skill, and those
two are reachable only through patience.

## 9. A world's geography is its own (v0.54)

Anchor's walls, Norwick's bounds, and the marches of the Wilds were
written as constants when there was only one world. The Wilds in
particular are **law**, not scenery: recall is refused from inside them
and the Brand is earned inside them, so where they lie is a
constitutional question. A constant cannot answer it for a world of a
different size — on a map four times the classic one, a fixed 34-by-22
rectangle is a rounding error in a corner.

So the three rectangles join the founding record as `genesis.geo`:

```
geo: { city: {x0,x1,y0,y1}, wilds: {...}, norwick: {...} }
```

Each region is optional, and **a genesis that names none of them gets
exactly the classic numbers**, so the classic world is unchanged to the
byte: same nodes, same mobs, same hashes. A world that names its own
regions is telling every node where its law runs, in the same record
that fixes its size, its seed, and its rules. `inWilds` now asks the
world it is standing in rather than a constant.

This is the same principle already governing `survey`, `brew`, and
`watch`: the *shape* of a rule is constitutional, its *numbers* belong
to the world that was founded with them.

### 9d. Geography is law

A generator does not merely place nodes: it publishes **named regions**,
and the boundary between them is a pure function of the founding record
like everything else. `biomeAt(genesis, x, y)` is as constitutional as
the terrain it partitions, and windows read it rather than inventing
their own idea of where the Fens begin.

This is not decoration. A world whose citizens cannot say *where* they
are cannot coordinate. "Meet me at the fens edge" is only useful if it
denotes one place to everyone who hears it, and a boundary each client
guessed at separately would denote as many places as there are clients.
So the countries are named in the constitution and drawn from the same
arithmetic everywhere: the Greenwood, the Crags, the Fens, the Wilds,
the Heartlands, and the seven settlements.

The boundary is a line, not a gradient, and it is crossed before the
country's heart is reached, exactly as a city limit is. A citizen walking
south from Anchor is *in* the Fens well before the water and the goblin
warrens begin, and their window says so, which is the warning and the
welcome both.

Regions are derived, never stored. Like standing and calling (§10), a
thing computable from the founding record does not belong in the state.

### 9c. A generator name means one landscape, forever

A founding record names its generator (`interval-expanse-v1`) but does
not hash the code behind that name. The name is therefore a **promise**:
whoever publishes a generator id promises that this id builds this
country, in every implementation, for as long as the world runs. Changing
what an id builds does not fork the world, which sounds harmless and is
the opposite: every node goes on claiming the same worldId while building
a different country, and nothing announces the split.

So a change to a published generator is published as a **new id**. The
old world keeps its landscape and its name; the new one is a new world,
and the divergence is visible in the founding record where it belongs. A
node that meets an id it does not implement refuses to build rather than
approximating, for the same reason.

### 9b. Terrain must be exactly reproducible

A generator's landscape is not decoration: it decides where nodes stand,
and those nodes are the founded world. So terrain may use only the
operations IEEE-754 requires to be **exactly rounded** — addition,
subtraction, multiplication, division, and square root — and never the
transcendentals (`Math.sin`, `cos`, `pow`, `exp`, `log`), which ECMA-262
leaves implementation-defined. Two engines that disagree in the last
place about a sine would place a river one tile apart and found two
worlds from one genesis, which no amount of consensus can later
reconcile. Meanders are built instead from hashed control points joined
by smoothstep, which is exact, and looks more like real water and real
footpaths than a sine wave does anyway.

### 9a. The expanse (`interval-expanse-v1`)

A second generator, and the first world designed for the founding record
rather than around it. Where the classic generator reads "a safe town,
then danger" — a radial gradient, identical in every direction — the
expanse gives every direction a meaning: **north is wood, east is stone,
south is water, west is danger, and the middle is home.** Five
countries, seven walled settlements, every road a spoke to Anchor, and
eighteen waystones. The country is *knowable*: a citizen who learns it
once still knows it after a year away, which is what a world owes people
who leave and come back.

Where a trail bends, something stands at the bend. The generator places
a boulder or an old tree at the straight line the path declined to take,
so a curve has a cause a traveller can see, and so the country can be
navigated the way people actually navigate: left at the split rock,
rather than by counting tiles. A landmark is an ordinary resource too,
so the thing you steer by is also somewhere to work.

The generator is not part of the rules hash — `SPEC.md` is — but the
world it founds is named in the genesis, and a node that does not
implement that generator refuses to guess at its landscape rather than
grow a different one.

### 8f. Constitutional consequences

`SKILLS` gains `brewing`; **Master of Interval is now mastery in all
sixteen.** The honors roll gains `master:brewing` and a first `brewer`.
`genesis.brew` joins the founding record. A new node `brewpot`, two
items (`ale`, `broth`), and three actions (`build_brewpot`, `brew`,
`collect`) join the vocabulary. Watchfires add the `watchfire` node, the
`kindle` and `stoke` actions, `genesis.watch`, and a first `watchfire`. Bot indifference holds: a bot brewer
still has to gather every log, every grain, and tend the rotation in
real returns — it simply runs a small business, like anyone else.

## 6j. Ranged (the bow and the bone arrow)

`fletch {slot, make}` works anywhere: `make: "bow"` turns 1 logs into
a `wooden-bow` (15 ranged xp); `make: "arrows"` turns 1 bones into 5
`arrows` (5 ranged xp): the second bones sink. With a bow wielded and
arrows carried, `attack` is valid at Chebyshev distance <= 4. Each
attack roll consumes one arrow, hit or miss: distance is paid for in
ammunition. Ranged max hit is `1 + floor(rangedLevel / 12)`; damage
grants 4 ranged xp per point and 1 hitpoints xp. A pinned target
endures under fire; hunting behavior is reserved for a future
amendment.

`ranged` joins the skills. The eleventh: `woodcutting`, `mining`,
`fishing`, `cooking`, `smithing`, `firemaking`, `prayer`, `ranged`,
`attack`, `defence`, `hitpoints`.

## 6h. Prayer (the bones sink)

`bury {slot}` is valid iff the slot holds `bones`. It resolves in the
same tick, always: the bones are consumed, the earth accepts them, and
25 prayer XP is awarded. Prayer has no mechanical effect yet; its
powers are reserved for a future amendment. The dead are patient.

## 6e. Mob drops lie where they fall

On a mob's death its drops become **ground items** (§3.4) on the mob's
tile rather than entering anyone's inventory. The killer has no special
claim: loot belongs to whoever walks over and takes it.

## 9c. Chat (auxiliary, never consensus)

Chat is NOT part of world state and never affects a state hash. It is a
separate gossip topic, `interval/<ns>/chat/1.0.0`, carrying
`{playerId, tick, text, sig}` signed by the speaking key. Nodes MUST
drop messages over 80 characters, with invalid signatures, or exceeding
one message per tick per key: the interval applies to speech too.
Clients may mute any key locally. The world does not remember what was
said; only who said it.

## 6u. Earned strength, open doors (v0.41)

- **Wield requirements.** star-sword: attack 20. old-chain: attack 30.
  star-helm: defence 15. star-plate: defence 30. Bronze has no
  requirement: the door is open; the tower is climbed.
- **Magic-rock mining floor.** Gathering a magic-rock requires mining
  level 10: the vein refuses an unpracticed pick.
- **`mend` (magic 20).** The sigil's second use: `cast {spell:"mend"}`
  consumes one sigil and restores 20 HP to the caster (v0.41: a strong heal, not a full reset). 40 magic XP.
  The same three stones, a deeper word.
- **The Brand.** A citizen who initiates `attackp` against a target not
  currently striking them wears `brandedUntil = tick + 1500`. The state
  is law; the windows choose the paint. The Brand carries no mechanical
  penalty (v0.41): it is reputation, made legible.
- **Gold trades.** `offer_trade` may name `wantGold` instead of
  `wantItem`: coin settles like any item, atomically, adjacent.
- **The store sells.** `buy {item}` adjacent to a store: currently
  `seeds` at 15 gold. Farming no longer waits on goblin luck.

## 7. Verifiable randomness: the drawing of lots (v0.38)

Each tick carries a **beacon** in the state itself: 32 bytes drawn
from the world's own history. The old formula
(`SHA-256("beacon" || genesisSeed || tick)`) was a pure function of
public constants: every roll for all eternity was computable at
genesis. The lots were dealt face-up. v0.38 redraws them from the one
thing nobody controls alone: the citizens' deeds.

```
beacon(0)   = SHA-256("beacon" || genesisSeed || tick0)   (migration seed)
deeds(T)    = SHA-256("deeds" || sorted signatures of inputs applied at T)
beacon(T+1) = SHA-256^N( beacon(T) || deeds(T) ),  N = 20,000

roll(beacon(T), playerId, tag) =
  first byte of SHA-256( beacon(T) || playerId || tag )
```

Properties, honestly stated:

- **Deterministic & replayable.** The beacon is part of the state; the
  same genesis and input log always reproduce it. Verification is
  recomputation, which is what a witness does all day anyway.
- **Unpredictable while it matters.** Tomorrow's lots depend on today's
  deeds, then walk N sequential hashes (~65ms on commodity hardware):
  by the time anyone could know them, the inputs that will be judged by
  them are already committed (the tick allocator stamps ahead).
- **Acting reshuffles the draw.** Your attack is itself an input to the
  digest that seeds the roll that judges it. You cannot read the lots
  and then act, because acting redraws the lots.
- **Residual bias, bounded.** A lone actor on a quiet night can grind at
  most one bit per tick (submit or withhold their own deed) and must
  still outrun the chain to see the result before committing. On a
  quiet night with no deeds at all the chain advances predictably: but
  the only rolls worth predicting involve acting, and acting ends the
  quiet. The bias buys nothing it doesn't immediately destroy.

No client-side randomness exists anywhere in the protocol.

### 7a. The Reading Rule (v0.39)

The beacon for tick T is public **during** T: it was drawn at the close
of T-1. Chance may therefore only judge deeds whose lots are not yet
drawn: multi-tick deeds (combat exchanges, gathering yields, drops on a
future death) are safe, because their rolls land on beacons that do not
exist when the deed is committed, and committing reshuffles them.

**Instant deeds are judged by counting, not chance.** Cooking and
firemaking resolve the same tick they are submitted; under any beacon
they could be pre-read and timed. They now use a per-citizen tally and
a Bresenham accumulator:

```
success on attempt n  iff  floor(n*q/256) > floor((n-1)*q/256)
q = min(64 + 2*level, 240)      (the same curve as before)
```

Over any window of attempts the success count is exact: the promised
rate with zero variance. Attempt n's outcome is a pure function of n
and level: no tick is kinder than another, so timing buys nothing.
The pan counts; it does not gamble.

## 8. Bot indifference (design doctrine)

Bots are not a problem this protocol tolerates: they are infrastructure
it depends on. Every witness node is a bot: they replay every tick,
verify every signature, and hold every checkpoint: **bots enforce the
rules.** Every scripted citizen chopping through the night keeps the
world's pulse and, since v0.38, feeds its randomness: their deeds are
entropy. A world with no bots is a world with no witnesses.

The rules therefore never ask "is this player human," and never need to:

- Resource nodes deplete and are shared → automation increases supply,
  which markets price in, rather than granting private infinite yield.
- Rare value comes from **scarcity mechanisms** (depletion timers,
  per-region caps), not per-player RNG lotteries that bots could farm
  in parallel for free: and since v0.39, instant actions carry no RNG
  at all.
- The clock may work, but it may never gate (v0.40): a bot's patience
  is infinite, so rules that tax patience tax only humans. There are
  none.

## 9. Worlds, versions, and forks

The genesis object contains the spec version and the **rules hash**
(SHA-256 of this document's canonical text), the genesis seed, the
anchor time, the world dimensions, and any imported founding citizens.
Two peers are in the same world if and only if their genesis objects
match byte-for-byte in canonical encoding.

**World identity (v0.43).** The world's identifier is

```
worldId = SHA-256(canonical(genesis))
```

hex-encoded, never truncated for protocol use (a short prefix is
display-only). The rules hash names a constitution; the worldId names
one exact founded world. Two worlds under the same constitution but
different seeds, anchors, sizes, or imports are different worlds and
different networks: every gossip topic and request protocol is
namespaced by the complete worldId
(`interval/<worldId>/inputs`, `interval/<worldId>/hashes`,
`interval/<worldId>/chat/2.0.0`, `/interval/<worldId>/checkpoint/2.0.0`,
`/interval/<worldId>/ticklog/2.0.0`).

**Genesis is immutable.** After founding, no field of genesis may
change, including `anchorMs`. A node that cannot honor the original
schedule catches up by replay or founds a NEW world (new anchor, new
worldId) whose genesis imports the citizens (`genesis.imported`), which
every node applies deterministically at world construction.

**Signature domains (v0.43).** Every signature binds a purpose and a
world. The signed bytes are `domain || canonical(payload-without-sig)`
with domains `INTERVAL_INPUT_V1|` (game inputs) and `INTERVAL_CHAT_V1|`
(chat). Every signed payload includes the full `worldId`; the state
machine rejects any input whose `worldId` is not this world's, so an
input signed for World A is unverifiable and invalid in World B.

Changing any rule changes the rules hash and creates a new world sharing
history up to the fork tick. Characters exist in every timeline that
shares their history. Clients display the spec version and worldId
prominently; players choose their constitution.

## 9a. Checkpoints and late join

A **checkpoint** is the envelope
`{formatVersion, worldId, tick, stateHash, state}` where `state` is the
full canonical world state at that tick. Checkpoints are self-verifying
up to identity: anyone can recompute the state hash. Before ANY
checkpoint is adopted (from disk or from a peer), the receiver MUST
verify: `worldId` equals its own, `state.genesis` is byte-identical in
canonical form, `state.tick === tick`, and the recomputed hash of
`state` equals `stateHash`. Trust that a checkpoint is *the* canonical
timeline comes from corroboration, not authority:

- Nodes persist a checkpoint locally through a serialized, crash-safe
  writer (one write in flight, newest snapshot wins, unique temp file,
  flush, atomic rename; failures are surfaced, never swallowed) and
  serve their latest on `/interval/<worldId>/checkpoint/2.0.0`.
- A joining peer MUST fetch checkpoints from at least two independent
  peers and verify the state hashes match before adopting one. More
  corroboration is better; one peer is never enough.
- After adopting a checkpoint at tick T, the peer buffers gossiped
  inputs and advances normally from T. Its hashes must then agree with
  the network's: if they don't, the peer adopted a minority timeline
  and should re-sync from different peers.

## 9b. Catch-up by replay

Nodes retain a recent **input log** (the exact input sets applied per
tick) and serve contiguous ranges of it on
`/interval/<worldId>/ticklog/2.0.0`, bounded per request (at most 256
ticks and 4 MiB per response). A node that stalls past one or more tick
boundaries recovers by fetching the missed range and replaying it
through the state machine: recomputing, not trusting: hash gossip
still judges the result. If no reachable peer's log extends back far
enough, the node falls back to checkpoint re-sync (§9a). Determinism
makes history replayable; replayability makes stalls survivable.

## 9d. Network limits (v0.43)

Every network surface is bounded before allocation. Nodes MUST reject:
gossip frames over 16 KiB (chat over 2 KiB) before parsing; inputs more
than 20 ticks in the future or for any other world; malformed player
ids; more than 4096 buffered inputs per interval or 64 buffered future
intervals; hash gossip outside a 512-tick window. Rate/retention maps
(input buffers, hash history, chat rate table) are pruned by tick or
capped in size. Values are protocol constants published by the
implementation (`LIMITS` in node.mjs).

## 9e. Two kinds of world

A genesis that lists a **witness set** (§9f) is an *authoritative
world*: intervals finalize only through quorum-attested bundles, and
the claim "one finalized world every honest node independently
verifies" holds against the network model in §9f. A genesis without one
runs the older optimistic mode — deterministic peer-to-peer input
propagation with state-hash divergence detection — which remains
accurately described as a prototype: adverse timing can make honest
nodes apply different input sets for a tick, and hash gossip detects
but does not repair this. Optimistic worlds exist for development and
demonstration; a network that intends to be one world MUST found with
witnesses.

## 9f. Certified interval bundles (v0.44)

Authoritative worlds finalize through **IntervalBundles**: for each
tick, one canonical, certified set of inputs.

**Witnesses and quorum.** `genesis.witnesses` is an ordered list of
ed25519 public keys; `genesis.quorum` is an integer with
`1 <= quorum <= |witnesses|` and — constitutionally —
`2 * quorum > |witnesses|`, so any two quorums intersect. A genesis
violating this MUST be refused at founding and by every verifier. Both
are founding facts: immutable forever, committed to by the worldId, and
never changed in-protocol; witness replacement means founding a new
world (with imports). A different witness configuration is a different
world.

**Proposal.** The proposer for `(tick, round)` is
`witnesses[(H(worldId || previousStateHash || tick) + round) mod n]`.
At the schedule boundary the round-0 proposer publishes a bundle
`{v, worldId, tick, round, previousStateHash, proposer, inputs, sig}`
where `inputs` are player-signed inputs sorted by
`(playerId, inputHash)`, at most **two** per player (one action, or the
pair that proves equivocation, which the state machine's duplicate rule
then excludes deterministically), and `sig` is the proposer's signature
under domain `INTERVAL_BUNDLE_V1|`. The proposer selects which inputs a
tick contains; it cannot invent one (all remain player-signed) and
cannot forge an outcome (see attestation).

**Attestation and the vote lock.** Every witness that receives a bundle
validates it structurally (world, tick, lineage via
`previousStateHash`, expected proposer, order, caps, every input
signature), **recomputes the state transition itself**, and publishes
an attestation `{v, worldId, tick, round, bundleHash,
resultingStateHash, witness, sig}` under domain
`INTERVAL_ATTESTATION_V1|`. Voting is governed by the **tick lock**
(CONSENSUS.md §4): the first valid bundle a witness signs for a tick is
written durably to disk *before* the attestation is broadcast, and the
witness thereafter signs no other bundle hash for that tick — across
ALL rounds, across restarts. The identical bundle may be re-attested
and rebroadcast freely. Locks are released only by finalization of the
tick, never by rounds or timeouts.

**Finality.** An interval is FINAL when `quorum` distinct witnesses
attest to the same `(bundleHash, resultingStateHash)`. The bundle plus
that quorum of attestations is a **finality record**: a portable proof
anyone can verify against genesis alone. Nothing finalizes on a timer;
the 600 ms schedule only paces proposals. `scheduledTick` (what local
time predicts) and the finalized tick (what quorum evidence proves) are
distinct quantities and MUST NOT be conflated.

**Timeout and fallback.** If round `r` produces no finalization within
`ROUND_TIMEOUT_MS`, round `r+1` opens with the next proposer in
canonical order. A round cannot be jumped early. If quorum is
unreachable (partition, dead witnesses), the world **stops finalizing**
and resumes when quorum returns: a stopped world, never two worlds.
Because locks are never released, a multi-round partition can strand
locks across bundles such that a tick can never finalize
(CONSENSUS.md §8, H2): that too is a stop, recovered by refounding, and
is the accepted price of fork-freedom.

**Fairness (honesty clause).** The protocol guarantees deterministic
execution and deterministic finality; it does NOT guarantee complete
input inclusion. The round's proposer chooses the bundle from what it
saw; an omitted input dies with its tick (inputs are tick-bound) and
the client resubmits. Proposer misbehavior — omission or signing two
bundles for one round — is detectable, and proposer equivocation yields
portable evidence. See CONSENSUS.md §7.

**Mismatch means halt.** A node whose own computation of a certified
bundle's result differs from the quorum-certified
`resultingStateHash` — or that observes a quorum certify a structurally
invalid bundle — HALTS: it refuses to finalize further intervals,
preserves the conflicting evidence, and recovers only from a certified
checkpoint. Silent self-repair onto an unverified state is forbidden.

**The consensus specification.** The full agreement protocol — model,
fault assumptions, locking rules, the common verifier, liveness limits,
halting conditions, and witness lifecycle — is normatively specified in
CONSENSUS.md v1.0. Where implementation and CONSENSUS.md disagree, the
document wins.

**Certified sync.** A checkpoint from an authoritative world carries
the finality record certifying its state; a receiver verifies the proof
and the recomputed state hash, so a checkpoint from ONE peer is
trustworthy (§9a's two-peer corroboration remains the rule only for
optimistic worlds). Catch-up serves finality records, not raw inputs:
the recovering node verifies each proof and replays each bundle,
demanding the certified result byte-for-byte.

## 10. Out of scope for v0.1

Sharding, combat, hidden information, name release/transfer,
multi-item trades, distributed beacon. The v0.x series exists to prove one thing:
**independent implementations replaying the same inputs agree on every
byte of the world: and anyone can join it, leave it, or fork it.**
