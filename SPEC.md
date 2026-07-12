# Interval: Protocol Specification v0.23 ("The Constitution")

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
4. **Bot indifference.** The protocol does not attempt to detect bots.
   Economy and progression must be designed so automation is priced in,
   not policed (see §8).
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
`{specVersion, rulesHash, genesisSeed, anchorMs, worldW, worldH}`.

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

## 4. Skills and XP

v0.18 skills: `woodcutting`, `mining`, `fishing` (gathering);
`cooking`, `smithing`, `firemaking` (processing); `attack`, `defence`,
`hitpoints` (combat). Gathering
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
recurrence, without bound. Every mechanic that reads a level reads
`min(level, 99)`: mastery is the ceiling of power, and nothing past it
buys a stronger swing or a faster axe. Levels past 99 are honor, proof
of intervals spent. A bot can reach them; so can you. The ledger does
not care, and that is the point.

## 5. Actions

Players submit **inputs**, each signed by their key:

```
{ tick, playerId, type, ...params, sig }
```

v0.1 input types:

- `move` → `{dx, dy}` where dx,dy ∈ {-1,0,1}; moves 1 tile per tick.
  The world is a bounded grid of **genesis-defined size**: the genesis
  object carries `worldW` and `worldH` (defaults 14 × 8), and a move
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

If a player's HP reaches 0: they respawn at the spawn point at full HP
with their action cleared and their **entire inventory and equipment
destroyed**. Skills, XP, name, and **bank** survive. Destroyed items leave the world: death
is the deepest sink. This severity is explicitly provisional; softer
death rules are an expected and legitimate fork.

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

## 7. Verifiable randomness

Each tick has a **beacon value** `B(tick)`: 32 bytes agreed by the
network (v0.2 reference: `SHA-256("beacon" || genesisSeed || tick)`;
production: a distributed randomness beacon such as drand).

```
roll(B, tick, playerId, tag) =
  first byte of SHA-256( B(tick) || playerId || tag )
```

No client-side randomness exists anywhere in the protocol.

## 8. Bot indifference (design doctrine)

- No rule may depend on "is this player human."
- Resource nodes deplete and are shared → automation increases supply,
  which markets price in, rather than granting private infinite yield.
- Rare value should come from **scarcity mechanisms** (depletion timers,
  per-region caps), not from per-player RNG lottery that bots can farm
  in parallel for free.
- Future economy work (v0.2+): sink-heavy design, decay, region caps.

## 9. Worlds, versions, and forks

The genesis object contains the spec version and the **rules hash**
(SHA-256 of this document's canonical text). Two peers are in the same
world if and only if their genesis objects match.

Changing any rule changes the rules hash and creates a new world sharing
history up to the fork tick. Characters exist in every timeline that
shares their history. Clients display the spec version and rules hash
prominently; players choose their constitution.

## 9a. Checkpoints and late join

A **checkpoint** is `{tick, state}` where `state` is the full canonical
world state at that tick. Checkpoints are self-verifying up to identity:
anyone can recompute the state hash. Trust that a checkpoint is *the*
canonical timeline comes from corroboration, not authority:

- Nodes persist a checkpoint locally every tick and serve their latest
  checkpoint on the protocol `interval/<ns>/checkpoint/1.0.0`.
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
`interval/<ns>/ticklog/1.0.0`. A node that stalls past one or more tick
boundaries recovers by fetching the missed range and replaying it
through the state machine: recomputing, not trusting: hash gossip
still judges the result. If no reachable peer's log extends back far
enough, the node falls back to checkpoint re-sync (§9a). Determinism
makes history replayable; replayability makes stalls survivable.

## 10. Out of scope for v0.1

Sharding, combat, hidden information, name release/transfer,
multi-item trades, distributed beacon. The v0.x series exists to prove one thing:
**independent implementations replaying the same inputs agree on every
byte of the world: and anyone can join it, leave it, or fork it.**
