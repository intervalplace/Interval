// Interval reference engine v0.2
// Pure deterministic state machine: nextState(state, inputs, beacon)
// No I/O, no Date, no Math.random, no floats in game logic.
// v0.2: ed25519-signed inputs verified in the state machine,
//       hardcoded XP table (spec constants), genesis object with rules hash.
// v0.4: names as in-world objects (claim_name, spec §5a).
// v0.6: spawning (§5b) and adjacent atomic trade (§5c).

'use strict';
// Universal crypto: @noble libraries are pure, audited, deterministic JS,
// the same engine bytes run in Node, browsers, and anywhere else.
const { sha256: nobleSha256, sha512 } = require('@noble/hashes/sha2.js');
const ed = require('@noble/ed25519');
ed.hashes.sha512 = sha512;
const hex = (u8) => Buffer.from(u8).toString('hex');

const SPEC_VERSION = '0.41';
const TICK_MS = 600;
const INV_SLOTS = 28;
const DEPLETE_TICKS = 8;
const NODE_YIELD = {
  'tree':         { item: 'logs',        skill: 'woodcutting', xp: 25 },
  'rock':         { item: 'ore',         skill: 'mining',      xp: 35 },
  'fishing-spot': { item: 'raw-fish',    skill: 'fishing',     xp: 30 },
  'magic-rock':   { item: 'magic-stone', skill: 'mining',      xp: 30 },
};
// v0.40: the night gate is repealed. It was constitutional arithmetic
// (tick % 2400), not wall-clock authority: but its only effect was
// mandatory waiting, and waiting is the one cost this world rejects.
// The stones price the sigil; the sky is for the windows to paint.
// v0.41: strength must be earned before it is worn. Smithing gated the
// forge; nothing gated the arm. Bronze stays free: the door is open.
const WIELD_REQS = {
  'star-sword': { attack: 20 }, 'old-chain': { attack: 30 },
  'star-helm': { defence: 15 }, 'star-plate': { defence: 30 },
};
const STORE_SELLS = { seeds: 15 }; // farming no longer waits on goblin luck
const MAGIC_ROCK_MINING = 10; // the vein refuses an unpracticed pick
const DEATH_TICKS = 5; // the world holds its breath; windows may grieve
const BRAND_TICKS = 1500; // strike first in the Wilds, wear it 15 minutes
const XP_COOK = 30;
const HEAL_FISH = 3;
const HP_START_XP = 1154; // hitpoints level 10
const MOB_STATS = {
  goblin: { maxHp: 5, atk: 1, def: 1, maxHit: 1, respawn: 16,
            drops: [{ item: 'bones' }, { item: 'ore', chance: 64 }, { item: 'seeds', chance: 64 }] },
  wolf:   { maxHp: 8, atk: 2, def: 2, maxHit: 2, respawn: 150,
            drops: [{ item: 'bones' }, { item: 'bones', chance: 96 }] },
  troll:  { maxHp: 20, atk: 4, def: 4, maxHit: 3, respawn: 300,
            drops: [{ item: 'bones' }, { item: 'ore' }, { item: 'bronze-plate', chance: 24 },
                    { item: 'old-chain', chance: 5 }] },
  bear:   { maxHp: 14, atk: 3, def: 3, maxHit: 2, respawn: 220,
            drops: [{ item: 'bones' }, { item: 'bones', chance: 128 }, { item: 'bronze-hatchet', chance: 16 }] },
};
// the store's ledger (spec 6l)
const GROW_TICKS_RIPE = 1200; // spec 6o: twelve minutes, seed to harvest
const PRICES = {
  'logs': 2, 'ore': 5, 'raw-fish': 3, 'cooked-fish': 6, 'bones': 2, 'arrows': 1,
  'magic-stone': 20, 'bronze-sword': 15, 'bronze-hatchet': 10, 'bronze-pickaxe': 10,
  'bronze-helm': 12, 'bronze-plate': 30, 'wooden-bow': 8, 'grain': 4,
  'star-sword': 120, 'star-helm': 60, 'star-plate': 200,
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// the Wilds (spec 2g): where citizens may hunt citizens
const inWilds = (x, y) => x >= 1 && x <= 34 && y >= 1 && y <= 22; // grown with the world (2h)
// the city of Anchor (spec 2d): mob-forbidden bounds
function cityRectOf(g) {
  const cx = Math.floor(g.worldW / 2);
  return { x0: cx - 8, x1: cx + 8, y0: 2, y1: 10 };
}
const inCity = (g, x, y) => {
  const r = cityRectOf(g);
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
};
const RECIPES = {
  'bronze-sword':   { ore: 2, logs: 1 },
  'bronze-hatchet': { ore: 1, logs: 1 },
  'bronze-pickaxe': { ore: 1, logs: 1 },
  'bronze-helm':    { ore: 1, logs: 1 },
  'bronze-plate':   { ore: 3, logs: 1 },
  'star-sword':     { 'magic-stone': 3, ore: 2 },
  'star-helm':      { 'magic-stone': 2, ore: 1 },
  'star-plate':     { 'magic-stone': 4, ore: 3 },
};
const EQUIPPABLE = new Set([...Object.keys(RECIPES), 'wooden-bow', 'old-chain']);
const EQUIP_SLOT = { 'bronze-helm': 'head', 'bronze-plate': 'body', 'star-helm': 'head', 'star-plate': 'body' }; // default: weapon
// the first level requirements (spec 6q): an unearned hammer strikes nothing
const SMITH_REQS = { 'star-sword': { smithing: 20, magic: 10 },
  'star-helm': { smithing: 15, magic: 5 }, 'star-plate': { smithing: 30, magic: 15 } };
const SOAK = (item) => item?.startsWith('star-') ? 2 : 1; // starmetal turns aside more
const slotOf = (item) => EQUIP_SLOT[item] ?? 'weapon';
const TOOL_FOR = { tree: 'bronze-hatchet', rock: 'bronze-pickaxe' };
const XP_SMITH_PER_ORE = 30;
const XP_FIREMAKING = 40;
const XP_BURY = 25;
const FIRE_TICKS = 100;
const SLEEP_AFTER = 500;
function isAwake(p, tick) {
  return p.action !== null || tick - (p.lastInput ?? 0) <= SLEEP_AFTER;
}

const spawnOf = (g) => ({ x: Math.floor(g.worldW / 2), y: Math.floor(g.worldH / 2) });

// ---------- XP table: spec constants (Appendix A). Index = level. ----------
const XP_TABLE = [0,0,83,174,276,388,512,650,801,969,1154,1358,1584,1833,2107,2411,2746,3115,3523,3973,4470,5018,5624,6291,7028,7842,8740,9730,10824,12031,13363,14833,16456,18247,20224,22406,24815,27473,30408,33648,37224,41171,45529,50339,55649,61512,67983,75127,83014,91721,101333,111945,123660,136594,150872,166636,184040,203254,224466,247886,273742,302288,333804,368599,407015,449428,496254,547953,605032,668051,737627,814445,899257,992895,1096278,1210421,1336443,1475581,1629200,1798808,1986068,2192818,2421087,2673114,2951373,3258594,3597792,3972294,4385776,4842295,5346332,5902831,6517253,7195629,7944614,8771558,9684577,10692629,11805606,13034431];

function levelForXp(xp) {
  let lvl = 1;
  while (lvl < 99 && xp >= XP_TABLE[lvl + 1]) lvl++;
  if (lvl < 99 || xp < XP_TABLE[99]) return lvl;
  // beyond mastery (spec 4b): the same recurrence, continued without bound
  let points = XP_TABLE[99] * 4;
  while (true) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    if (xp < Math.floor(points / 4)) return lvl;
    lvl++;
  }
}
// mechanics read capped mastery (spec 4b)
const effLevel = (xp) => Math.min(levelForXp(xp), 99);

// ---------- canonical encoding & hashing ----------

function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256(buf) {
  return Buffer.from(nobleSha256(buf));
}

function stateHash(state) {
  return sha256(Buffer.from(canonical(state))).toString('hex');
}

// ---------- identity: ed25519 keypairs (noble, universal) ----------
// playerId = hex of the raw 32-byte public key.
// privateKey = raw 32-byte secret (Uint8Array). Guard it: it IS the character.

function generateIdentity() {
  const privateKey = ed.utils.randomSecretKey();
  return { playerId: hex(ed.getPublicKey(privateKey)), privateKey };
}

// The signed payload is the canonical input without its sig field.
function inputPayload(input) {
  const { sig, ...rest } = input;
  return Buffer.from(canonical(rest));
}

function signInput(input, privateKey) {
  return { ...input, sig: hex(ed.sign(inputPayload(input), privateKey)) };
}

function verifyInputSig(input) {
  if (typeof input.sig !== 'string' || typeof input.playerId !== 'string') return false;
  try {
    return ed.verify(
      Buffer.from(input.sig, 'hex'),
      inputPayload(input),
      Buffer.from(input.playerId, 'hex'),
    );
  } catch {
    return false;
  }
}

// ---------- verifiable randomness (spec §7) ----------

function beaconValue(genesisSeed, tick) {
  return sha256(Buffer.concat([
    Buffer.from('beacon'),
    Buffer.from(genesisSeed),
    Buffer.from(String(tick)),
  ]));
}

// v0.38: the lots are drawn from the citizens' own deeds. The old beacon
// was a pure function of public constants: every roll for all eternity
// was computable at genesis. The lots were face-up. Now each tick's
// beacon folds in the digest of the inputs actually applied, then walks
// a sequential hash chain too long to outrun inside a tick. Predicting
// tomorrow's roll requires knowing today's deeds first, and your own
// deed reshuffles the very lots you were trying to read. Verification
// is recomputation, which is what a witness already does all day.
const LOTS_N = 20000; // sequential hashes per tick: the delay
function inputsDigest(inputs) {
  const sigs = inputs.map((i) => i.sig ?? '').sort();
  return sha256(Buffer.from('deeds' + JSON.stringify(sigs)));
}
function delayChain(prevBeacon, digest) {
  let h = sha256(Buffer.concat([prevBeacon, digest]));
  for (let i = 1; i < LOTS_N; i++) h = sha256(h);
  return h;
}

// v0.39, the Reading Rule: chance may only judge deeds whose lots are
// not yet drawn. The beacon for tick T is public DURING T (drawn at
// T-1's close), so any instant deed judged by it can be pre-read and
// timed: perfect cooking from level 1 by waiting for kind ticks.
// Instant deeds are therefore judged by COUNTING: a Bresenham
// accumulator that grants successes at exactly the constitutional
// rate, in a fixed order no timing can bend. Same curve, no dice.
// countedSuccess(n, q256): true iff attempt n (1-based) crosses a new
// multiple of the rate q/256. Over any window the success count is
// floor(n*q/256): the promised rate, exactly, with zero variance.
function countedSuccess(n, q256) {
  return Math.floor((n * q256) / 256) > Math.floor(((n - 1) * q256) / 256);
}

function roll(beacon, playerId, tag) {
  return sha256(Buffer.concat([
    beacon,
    Buffer.from(playerId),
    Buffer.from(tag),
  ]))[0]; // uniform integer in [0, 255]
}

// ---------- genesis & world (spec §9) ----------
// Two peers are in the same world iff their genesis objects match.

function makeGenesis(genesisSeed, rulesHash, anchorMs, worldW = 14, worldH = 8) {
  return { specVersion: SPEC_VERSION, rulesHash, genesisSeed, anchorMs, worldW, worldH };
}

// ---------- identity persistence: your key IS your character ----------

function exportIdentity(identity) {
  return { playerId: identity.playerId, privateKey: hex(identity.privateKey) };
}

function importIdentity(obj) {
  return { playerId: obj.playerId, privateKey: Buffer.from(obj.privateKey, 'hex') };
}

function loadOrCreateIdentity(fs, file) {
  if (fs.existsSync(file)) {
    try {
      const id = importIdentity(JSON.parse(fs.readFileSync(file)));
      if (id.privateKey.length === 32) return id; // raw ed25519 secret
      // pre-noble key format (pkcs8): unusable: preserve and regenerate
      fs.renameSync(file, file + '.old-format');
    } catch { /* corrupt file: fall through and regenerate */ }
  }
  const id = generateIdentity();
  fs.writeFileSync(file, JSON.stringify(exportIdentity(id)));
  return id;
}

function newWorld(genesis) {
  return {
    genesis,
    tick: 0,
    players: {},
    nodes: {},
    names: {},
    mobs: {},
    ground: {},
  };
}

function sameWorld(a, b) {
  return canonical(a.genesis) === canonical(b.genesis);
}

function addPlayer(state, playerId, x, y) {
  state.players[playerId] = {
    x, y,
    skills: { woodcutting: 0, mining: 0, fishing: 0, cooking: 0, smithing: 0,
              firemaking: 0, prayer: 0, ranged: 0, magic: 0, farming: 0, fletching: 0, attack: 0, defence: 0, hitpoints: HP_START_XP },
    hp: 10,
    equipment: { weapon: null, head: null, body: null },
    bank: {},
    lastInput: state.tick,
    gold: 0,
    inventory: Array(INV_SLOTS).fill(null),
    action: null,
    name: null,
    trade: null,
  };
}

function addMob(state, mobId, type, x, y) {
  state.mobs[mobId] = { type, x, y, hx: x, hy: y, hp: MOB_STATS[type].maxHp, respawnAt: 0 };
}

function addNode(state, nodeId, type, x, y) {
  state.nodes[nodeId] = { type, x, y, depletedUntil: 0 };
}

function firstFreeSlot(inv) {
  for (let i = 0; i < inv.length; i++) if (inv[i] === null) return i;
  return -1;
}

function adjacent(p, n) { // orthogonal (§5): you face what you work
  return Math.abs(p.x - n.x) + Math.abs(p.y - n.y) === 1;
}

// ---------- input validation (spec §5) ----------
// v0.2: the state machine itself verifies signatures. An input with a
// bad or missing signature is invalid regardless of content.

function validInput(state, input) {
  if (input.tick !== state.tick) return false;
  if (!verifyInputSig(input)) return false;
  const p = state.players[input.playerId];
  if (input.type === 'spawn') return !p; // §5b: the only input for unknown ids
  if (!p) return false;
  if (p.hp <= 0) return false; // the dead act on nothing (v0.41)
  switch (input.type) {
    case 'move': {
      const { dx, dy } = input;
      if (![ -1, 0, 1 ].includes(dx) || ![ -1, 0, 1 ].includes(dy)) return false;
      const nx = p.x + dx, ny = p.y + dy;
      // the hedge is law (spec 2c): the outer ring is impassable
      if (nx < 1 || nx >= state.genesis.worldW - 1 || ny < 1 || ny >= state.genesis.worldH - 1) return false;
      // nodes are impassable (§5): you fish beside the water, not in it
      return !Object.values(state.nodes).some(n => n.x === nx && n.y === ny);
    }
    case 'gather': {
      const n = state.nodes[input.nodeId];
      if (!n || !(n.type in NODE_YIELD) || n.depletedUntil > state.tick || !adjacent(p, n)) return false;
      if (n.type === 'magic-rock' && effLevel(p.skills.mining) < MAGIC_ROCK_MINING) return false;
      return true;
    }
    case 'cook': {
      const slot = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || !slot || slot.item !== 'raw-fish') return false;
      return Object.values(state.nodes).some(n => (n.type === 'campfire' || n.type === 'fire') && adjacent(p, n));
    }
    case 'stop':
      return true;
    case 'claim_name': {
      // spec §5a: lowercase a-z0-9- (no leading/trailing -), 1-12 chars,
      // name unclaimed, claimant nameless
      const { name } = input;
      if (typeof name !== 'string' || !/^[a-z0-9-]{1,12}$/.test(name)) return false;
      if (name.startsWith('-') || name.endsWith('-')) return false;
      return !(name in state.names) && p.name === null;
    }
    case 'offer_trade': {
      const t = state.players[input.to];
      if (!t || input.to === input.playerId) return false;
      if (!Number.isInteger(input.giveSlot) || !p.inventory[input.giveSlot]) return false;
      // v0.41: gold is tradeable: want an item, or want coin
      if (typeof input.wantItem === 'string') return true;
      return Number.isInteger(input.wantGold) && input.wantGold > 0;
    }
    case 'accept_trade': {
      const o = state.players[input.from];
      if (!o || !o.trade || o.trade.to !== input.playerId) return false;
      if (!adjacent(p, o)) return false;
      if (o.trade.wantGold) return (p.gold ?? 0) >= o.trade.wantGold;
      return p.inventory.some(s => s && s.item === o.trade.wantItem);
    }
    case 'cancel_trade':
      return p.trade !== null;
    case 'buy': {
      if (!(input.item in STORE_SELLS)) return false;
      if ((p.gold ?? 0) < STORE_SELLS[input.item] || firstFreeSlot(p.inventory) === -1) return false;
      return Object.values(state.nodes).some(n => n.type === 'store' && adjacent(p, n));
    }
    case 'attack': {
      const m = state.mobs[input.mobId];
      if (!m || m.hp <= 0) return false;
      if (adjacent(p, m)) return true;
      // ranged (spec 6j): a wielded bow and a carried arrow reach to 4
      const cheb = Math.max(Math.abs(p.x - m.x), Math.abs(p.y - m.y));
      return cheb <= 4 && p.equipment.weapon?.item === 'wooden-bow'
        && p.inventory.some(sl => sl?.item === 'arrows');
    }
    case 'attackp': {
      const q = state.players[input.targetId];
      if (!q || q.hp <= 0 || input.targetId === p.playerId) return false;
      if (!inWilds(p.x, p.y) || !inWilds(q.x, q.y)) return false;
      if (adjacent(p, q)) return true;
      const cheb = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      return cheb <= 4 && p.equipment.weapon?.item === 'wooden-bow'
        && p.inventory.some(sl => sl?.item === 'arrows');
    }
    case 'plant': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || sl?.item !== 'seeds') return false;
      return Object.values(state.nodes).some(n => n.type === 'plot' && !n.plantedAt && adjacent(p, n));
    }
    case 'harvest': {
      const n = state.nodes[input.nodeId];
      return !!n && n.type === 'plot' && n.plantedAt > 0 && n.by === input.playerId
        && (state.tick - n.plantedAt) >= GROW_TICKS_RIPE && adjacent(p, n)
        && firstFreeSlot(p.inventory) !== -1;
    }
    case 'sell': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || !sl || !(sl.item in PRICES)) return false;
      return Object.values(state.nodes).some(n => n.type === 'store' && adjacent(p, n));
    }
    case 'invoke': {
      // three stones, any hour (v0.40): the cost is the mining, not the wait
      return p.inventory.filter(sl => sl?.item === 'magic-stone').length >= 3;
    }
    case 'cast': {
      if (input.spell === 'anchor') return p.inventory.some(sl => sl?.item === 'sigil');
      if (input.spell === 'mend') // v0.41: the same sigil, a deeper use
        return effLevel(p.skills.magic) >= 20 && p.inventory.some(sl => sl?.item === 'sigil');
      return false;
    }
    case 'fletch': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || !sl) return false;
      return (input.make === 'bow' && sl.item === 'logs')
        || (input.make === 'arrows' && sl.item === 'bones');
    }
    case 'smith': {
      const r = RECIPES[input.recipe];
      if (!r) return false;
      if (!Object.values(state.nodes).some(n => n.type === 'anvil' && adjacent(p, n))) return false;
      const req = SMITH_REQS[input.recipe];
      if (req && !Object.entries(req).every(([sk, lv]) => effLevel(p.skills[sk]) >= lv)) return false;
      const have = (item) => p.inventory.filter(sl => sl && sl.item === item).length;
      return Object.entries(r).every(([item, qty]) => have(item) >= qty);
    }
    case 'wield': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || !sl || !EQUIPPABLE.has(sl.item)) return false;
      const req = WIELD_REQS[sl.item];
      if (req) for (const [sk, lv] of Object.entries(req))
        if (effLevel(p.skills[sk]) < lv) return false; // earned, then worn (v0.41)
      return true;
    }
    case 'unwield': {
      const g = ['weapon', 'head', 'body'].includes(input.gear) ? input.gear : 'weapon';
      return p.equipment[g] !== null && firstFreeSlot(p.inventory) !== -1;
    }
    case 'light': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || !sl || sl.item !== 'logs') return false;
      return !Object.values(state.nodes).some(n => n.x === p.x && n.y === p.y);
    }
    case 'bury': {
      const sl = p.inventory[input.slot];
      return Number.isInteger(input.slot) && !!sl && sl.item === 'bones';
    }
    case 'deposit': {
      if (!Number.isInteger(input.slot) || !p.inventory[input.slot]) return false;
      return Object.values(state.nodes).some(n => n.type === 'bank' && adjacent(p, n));
    }
    case 'withdraw': {
      if (typeof input.item !== 'string' || !(p.bank[input.item] > 0)) return false;
      if (firstFreeSlot(p.inventory) === -1) return false;
      return Object.values(state.nodes).some(n => n.type === 'bank' && adjacent(p, n));
    }
    case 'drop': {
      return Number.isInteger(input.slot) && !!p.inventory[input.slot];
    }
    case 'pickup': {
      const g2 = state.ground[input.groundId];
      if (!g2 || g2.x !== p.x || g2.y !== p.y) return false;
      return firstFreeSlot(p.inventory) !== -1;
    }
    case 'eat': {
      const slot = p.inventory[input.slot];
      return Number.isInteger(input.slot) && !!slot && slot.item === 'cooked-fish';
    }
    default:
      return false;
  }
}

// ---------- the transition function ----------

function nextState(state, inputs, _legacyBeacon) {
  const s = JSON.parse(JSON.stringify(state)); // pure: never mutate caller's state
  s.tick = state.tick + 1;
  // the beacon rides IN the state now (v0.38). A pre-0.38 state migrates
  // itself: seeded once from the old formula, then history takes over.
  if (!s.beacon) s.beacon = beaconValue(state.genesis.genesisSeed, state.tick).toString('hex');
  const beacon = Buffer.from(s.beacon, 'hex');

  // the dead return (spec §6c, v0.41): processed at tick start
  for (const pl2 of Object.values(s.players)) {
    if (pl2.hp <= 0 && pl2.deadUntil !== undefined && s.tick >= pl2.deadUntil) {
      const sp2 = spawnOf(s.genesis);
      pl2.x = sp2.x; pl2.y = sp2.y;
      pl2.hp = effLevel(pl2.skills.hitpoints);
      delete pl2.deadUntil;
    }
  }
  // mob respawns (spec §3.3): processed at tick start
  for (const m of Object.values(s.mobs)) {
    if (m.hp <= 0 && m.respawnAt <= s.tick) {
      m.hp = MOB_STATS[m.type].maxHp;
      m.x = m.hx; m.y = m.hy; // the dead come back where they belong
    }
  }
  // wandering (spec §3.3): the beacon paces the goblins, identically everywhere
  const pinned = new Set();
  for (const p of Object.values(s.players)) if (p.action?.mobId) pinned.add(p.action.mobId);
  for (const mid of Object.keys(s.mobs).sort()) {
    const m = s.mobs[mid];
    if (m.hp <= 0 || pinned.has(mid)) continue;
    if (roll(beacon, mid, 'wander') >= 48) continue;
    const [dx, dy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][roll(beacon, mid, 'dir') % 4];
    const nx = m.x + dx, ny = m.y + dy;
    if (nx < 1 || nx >= s.genesis.worldW - 1 || ny < 1 || ny >= s.genesis.worldH - 1) continue;
    if (inCity(s.genesis, nx, ny)) continue; // no mob enters Anchor (spec 2d)
    if (Math.max(Math.abs(nx - m.hx), Math.abs(ny - m.hy)) > 2) continue;
    if (Object.values(s.nodes).some(n => n.x === nx && n.y === ny)) continue;
    m.x = nx; m.y = ny;
  }
  // player-made fires burn out (spec §6f)
  for (const [nid, n2] of Object.entries(s.nodes)) {
    if (n2.expiresAt && n2.expiresAt <= s.tick) delete s.nodes[nid];
  }
  // ground decay (spec §3.4): the ground forgets
  for (const [gid, g2] of Object.entries(s.ground)) {
    if (g2.expiresAt <= s.tick) delete s.ground[gid];
  }

  // discard duplicate-input bundles (spec §5)
  const seen = new Map();
  for (const inp of inputs) {
    seen.set(inp.playerId, seen.has(inp.playerId) ? 'DUP' : inp);
  }

  // apply inputs in canonical playerId order for determinism
  const order = [...seen.keys()].sort();
  for (const pid of order) {
    const inp = seen.get(pid);
    if (inp === 'DUP' || !validInput(state, inp)) continue;
    if (inp.type === 'spawn') { const sp = spawnOf(s.genesis); addPlayer(s, pid, sp.x, sp.y); continue; }
    const p = s.players[pid];
    if (p) p.lastInput = s.tick; // presence (spec 5e)
    if (inp.type === 'move') {
      p.x += inp.dx;
      p.y += inp.dy;
      p.action = null;
    } else if (inp.type === 'gather') {
      p.action = { type: 'gather', nodeId: inp.nodeId };
    } else if (inp.type === 'stop') {
      p.action = null;
    } else if (inp.type === 'offer_trade') {
      p.trade = { to: inp.to, giveSlot: inp.giveSlot, wantItem: inp.wantItem, wantGold: inp.wantGold }; // coin or kind (v0.41)
    } else if (inp.type === 'cancel_trade') {
      p.trade = null;
    } else if (inp.type === 'accept_trade') {
      // re-validate against the NEW state (§5c): all-or-nothing
      const o = s.players[inp.from];
      if (o && o.trade && o.trade.to === pid && adjacent(p, o)) {
        const giveItem = o.inventory[o.trade.giveSlot];
        if (o.trade.wantGold) { // v0.41: coin settles like any item
          if (giveItem && (p.gold ?? 0) >= o.trade.wantGold) {
            const fs3 = firstFreeSlot(p.inventory);
            if (fs3 !== -1) {
              p.gold -= o.trade.wantGold;
              o.gold = (o.gold ?? 0) + o.trade.wantGold;
              p.inventory[fs3] = giveItem;
              o.inventory[o.trade.giveSlot] = null;
              o.trade = null;
            }
          }
        } else {
          const j = p.inventory.findIndex(sl => sl && sl.item === o.trade.wantItem);
          if (giveItem && j !== -1) {
            const wantSlotItem = p.inventory[j];
            o.inventory[o.trade.giveSlot] = wantSlotItem;
            p.inventory[j] = giveItem;
            o.trade = null;
          }
        }
      }
    } else if (inp.type === 'attack') {
      p.action = { type: 'attack', mobId: inp.mobId, since: s.tick };
    } else if (inp.type === 'smith') {
      const r = RECIPES[inp.recipe];
      const nearAnvil = Object.values(s.nodes).some(n => n.type === 'anvil' && adjacent(p, n));
      const have = (item) => p.inventory.filter(sl => sl && sl.item === item).length;
      if (r && nearAnvil && Object.entries(r).every(([item, qty]) => have(item) >= qty)) {
        for (const [item, qty] of Object.entries(r)) {
          let left = qty;
          for (let i = 0; i < p.inventory.length && left > 0; i++) {
            if (p.inventory[i]?.item === item) { p.inventory[i] = null; left--; }
          }
        }
        const slot = firstFreeSlot(p.inventory);
        if (slot !== -1) p.inventory[slot] = { item: inp.recipe, qty: 1 };
        p.skills.smithing += XP_SMITH_PER_ORE * r.ore;
      }
    } else if (inp.type === 'wield') {
      const sl = p.inventory[inp.slot];
      if (sl && EQUIPPABLE.has(sl.item)) {
        const g = slotOf(sl.item);
        const cur = p.equipment[g];
        p.equipment[g] = sl;
        p.inventory[inp.slot] = cur;
      }
    } else if (inp.type === 'buy') {
      const price = STORE_SELLS[inp.item];
      const nearStore = Object.values(s.nodes).some(n => n.type === 'store' && adjacent(p, n));
      const fs2 = firstFreeSlot(p.inventory);
      if (price && nearStore && (p.gold ?? 0) >= price && fs2 !== -1) {
        p.gold -= price;
        p.inventory[fs2] = { item: inp.item, qty: 1 };
      }
    } else if (inp.type === 'attackp') {
      const q = s.players[inp.targetId];
      if (q && q.hp > 0 && inWilds(p.x, p.y) && inWilds(q.x, q.y)) {
        p.action = { type: 'attackp', targetId: inp.targetId, since: s.tick };
        // the Brand (v0.41): striking one who was not striking you is
        // worn openly. Windows paint it as they wish; the state is law.
        const q3 = s.players[inp.targetId];
        if (q3 && !(q3.action?.type === 'attackp' && q3.action.targetId === pid))
          p.brandedUntil = s.tick + BRAND_TICKS;
      }
    } else if (inp.type === 'plant') {
      const sl = p.inventory[inp.slot];
      const plot = Object.values(s.nodes).find(n => n.type === 'plot' && !n.plantedAt && adjacent(p, n));
      if (sl?.item === 'seeds' && plot) {
        sl.qty = (sl.qty ?? 1) - 1;
        if (sl.qty <= 0) p.inventory[inp.slot] = null;
        plot.plantedAt = s.tick;
        plot.by = pid;
        p.skills.farming += 10;
      }
    } else if (inp.type === 'harvest') {
      const n = s.nodes[inp.nodeId];
      if (n?.type === 'plot' && n.plantedAt > 0 && n.by === pid
        && (s.tick - n.plantedAt) >= GROW_TICKS_RIPE && adjacent(p, n)) {
        const ex = p.inventory.findIndex(s2 => s2?.item === 'grain');
        const slot = firstFreeSlot(p.inventory);
        if (ex !== -1) p.inventory[ex].qty += 2;
        else if (slot !== -1) p.inventory[slot] = { item: 'grain', qty: 2 };
        else { continue; }
        n.plantedAt = 0;
        delete n.by;
        p.skills.farming += 40;
      }
    } else if (inp.type === 'sell') {
      const sl = p.inventory[inp.slot];
      const nearStore = Object.values(s.nodes).some(n => n.type === 'store' && adjacent(p, n));
      if (sl && PRICES[sl.item] && nearStore) {
        p.gold = (p.gold ?? 0) + PRICES[sl.item] * (sl.qty ?? 1);
        p.inventory[inp.slot] = null;
      }
    } else if (inp.type === 'invoke') {
      const slots = [];
      for (let i2 = 0; i2 < p.inventory.length && slots.length < 3; i2++) {
        if (p.inventory[i2]?.item === 'magic-stone') slots.push(i2);
      }
      if (slots.length === 3) {
        for (const i2 of slots) p.inventory[i2] = null;
        p.inventory[slots[0]] = { item: 'sigil', qty: 1 };
        p.skills.magic += 20;
      }
    } else if (inp.type === 'cast') {
      const si = p.inventory.findIndex(sl => sl?.item === 'sigil');
      if (inp.spell === 'mend' && si !== -1) {
        p.inventory[si] = null;
        p.hp = effLevel(p.skills.hitpoints); // made whole (v0.41)
        p.skills.magic += 40;
      } else if (inp.spell === 'anchor' && si !== -1) {
        p.inventory[si] = null;
        const cx2 = Math.floor(s.genesis.worldW / 2);
        p.x = cx2; p.y = 7; // the plaza beside the well: the fixed point
        p.action = null;
        p.trade = null;
        p.skills.magic += 30;
      }
    } else if (inp.type === 'fletch') {
      const sl = p.inventory[inp.slot];
      if (sl && inp.make === 'bow' && sl.item === 'logs') {
        p.inventory[inp.slot] = { item: 'wooden-bow', qty: 1 };
        p.skills.fletching += 15;
      } else if (sl && inp.make === 'arrows' && sl.item === 'bones') {
        const ex = p.inventory.findIndex((s2, i2) => s2?.item === 'arrows' && i2 !== inp.slot);
        p.inventory[inp.slot] = null;
        if (ex !== -1) p.inventory[ex].qty += 5;                    // the quiver (6n)
        else p.inventory[inp.slot] = { item: 'arrows', qty: 5 };
        p.skills.fletching += 5;
      }
    } else if (inp.type === 'unwield') {
      const g = ['weapon', 'head', 'body'].includes(inp.gear) ? inp.gear : 'weapon';
      const slot = firstFreeSlot(p.inventory);
      if (p.equipment[g] && slot !== -1) {
        p.inventory[slot] = p.equipment[g];
        p.equipment[g] = null;
      }
    } else if (inp.type === 'light') {
      const sl = p.inventory[inp.slot];
      const clear = !Object.values(s.nodes).some(n => n.x === p.x && n.y === p.y);
      if (sl && sl.item === 'logs' && clear) {
        const lvl = effLevel(p.skills.firemaking);
        p.lightsTried = (p.lightsTried ?? 0) + 1; // the tally, not the dice
        if (countedSuccess(p.lightsTried, Math.min(64 + 2 * lvl, 240))) {
          p.inventory[inp.slot] = null;
          p.skills.firemaking += XP_FIREMAKING;
          s.nodes['f' + s.tick + '-' + pid.slice(0, 8)] =
            { type: 'fire', x: p.x, y: p.y, depletedUntil: 0, expiresAt: s.tick + FIRE_TICKS };
          // step aside (§6f): west, east, south, north: first free tile
          for (const [mx, my] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) {
            const nx = p.x + mx, ny = p.y + my;
            if (nx < 1 || nx >= s.genesis.worldW - 1 || ny < 1 || ny >= s.genesis.worldH - 1) continue;
    if (inCity(s.genesis, nx, ny)) continue; // no mob enters Anchor (spec 2d)
            if (Object.values(s.nodes).some(n => n.x === nx && n.y === ny)) continue;
            p.x = nx; p.y = ny;
            break;
          }
        }
      }
    } else if (inp.type === 'bury') {
      const sl = p.inventory[inp.slot];
      if (sl && sl.item === 'bones') {
        p.inventory[inp.slot] = null;
        p.skills.prayer += XP_BURY;
      }
    } else if (inp.type === 'deposit') {
      const sl = p.inventory[inp.slot];
      const nearBank = Object.values(s.nodes).some(n => n.type === 'bank' && adjacent(p, n));
      if (sl && nearBank) {
        p.bank[sl.item] = (p.bank[sl.item] ?? 0) + 1;
        p.inventory[inp.slot] = null;
      }
    } else if (inp.type === 'withdraw') {
      const slot = firstFreeSlot(p.inventory);
      const nearBank = Object.values(s.nodes).some(n => n.type === 'bank' && adjacent(p, n));
      if (p.bank[inp.item] > 0 && slot !== -1 && nearBank) {
        p.bank[inp.item]--;
        if (p.bank[inp.item] === 0) delete p.bank[inp.item];
        p.inventory[slot] = { item: inp.item, qty: 1 };
      }
    } else if (inp.type === 'drop') {
      const it = p.inventory[inp.slot];
      if (it) {
        p.inventory[inp.slot] = null;
        const gid = 'g' + s.tick + '-' + pid.slice(0, 8) + '-' + inp.slot;
        s.ground[gid] = { item: it.item, x: p.x, y: p.y, expiresAt: s.tick + 100 };
      }
    } else if (inp.type === 'pickup') {
      const g2 = s.ground[inp.groundId];
      const onTile = g2 && g2.x === p.x && g2.y === p.y;
      const ex = onTile && g2.item === 'arrows' ? p.inventory.findIndex(s2 => s2?.item === 'arrows') : -1;
      const slot = firstFreeSlot(p.inventory);
      if (onTile && ex !== -1) {                       // the quiver (6n): arrows pool
        p.inventory[ex].qty += g2.qty ?? 1;
        delete s.ground[inp.groundId];
      } else if (onTile && slot !== -1) {
        p.inventory[slot] = { item: g2.item, qty: g2.qty ?? 1 }; // the whole stack, not one of it
        delete s.ground[inp.groundId];
      }
    } else if (inp.type === 'eat') {
      const slot = p.inventory[inp.slot];
      if (slot && slot.item === 'cooked-fish') {
        p.inventory[inp.slot] = null;
        p.hp = Math.min(p.hp + HEAL_FISH, effLevel(p.skills.hitpoints));
        // v0.32 (spec 6m): eating does not lower your guard; the fight holds
      }
    } else if (inp.type === 'cook') {
      // re-check against new state; instant, same-tick resolution (§6a)
      const slot = p.inventory[inp.slot];
      const nearFire = Object.values(s.nodes).some(n => (n.type === 'campfire' || n.type === 'fire') && adjacent(p, n));
      if (slot && slot.item === 'raw-fish' && nearFire) {
        const lvl = effLevel(p.skills.cooking);
        p.cooksTried = (p.cooksTried ?? 0) + 1; // the pan counts; it does not gamble
        if (countedSuccess(p.cooksTried, Math.min(64 + 2 * lvl, 240))) {
          p.inventory[inp.slot] = { item: 'cooked-fish', qty: 1 };
          p.skills.cooking += XP_COOK;
        } else {
          p.inventory[inp.slot] = { item: 'burnt-fish', qty: 1 };
        }
      }
    } else if (inp.type === 'claim_name') {
      // re-check against the NEW state: two claims for the same name in
      // one tick resolve by canonical playerId order (first applier wins)
      if (!(inp.name in s.names)) {
        s.names[inp.name] = pid;
        p.name = inp.name;
      }
    }
  }

  // resolve ongoing actions (spec §6, §6b), canonical order
  for (const pid of Object.keys(s.players).sort()) {
    const p = s.players[pid];
    if (!p.action) continue;

    if (p.action.type === 'attackp') {
      const q = s.players[p.action.targetId];
      const both = q && q.hp > 0 && inWilds(p.x, p.y) && inWilds(q.x, q.y);
      const near = both && (adjacent(p, q)
        || (Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= 4
            && p.equipment.weapon?.item === 'wooden-bow'
            && p.inventory.some(sl => sl?.item === 'arrows')));
      if (!near) { p.action = null; }
      else if (p.equipment.weapon?.item !== 'old-chain'
        && (s.tick - (p.action.since ?? 0)) % 2 !== 0) { /* combat breathes (6m); the chain does not (6r) */ }
      else {
        const bowDrawn2 = p.equipment.weapon?.item === 'wooden-bow' && !adjacent(p, q);
        let lvl2, tag2;
        if (bowDrawn2) {
          const aSlot = p.inventory.findIndex(sl => sl?.item === 'arrows');
          if (aSlot === -1) { p.action = null; continue; }
          p.inventory[aSlot].qty -= 1;
          if (p.inventory[aSlot].qty <= 0) p.inventory[aSlot] = null;
          lvl2 = effLevel(p.skills.ranged); tag2 = 'ranged';
        } else { lvl2 = effLevel(p.skills.attack); tag2 = 'attack'; }
        const defL = effLevel(q.skills.defence);
        const Tp = clamp(128 + 4 * (lvl2 - defL), 16, 240);
        if (roll(beacon, pid, 'atk') < Tp) {
          const maxHit = 1 + Math.floor(lvl2 / (bowDrawn2 ? 12 : 10))
            + (!bowDrawn2 ? (p.equipment.weapon?.item === 'bronze-sword' ? 2
              : p.equipment.weapon?.item === 'star-sword' ? 4
              : p.equipment.weapon?.item === 'old-chain' ? 1 : 0) : 0);
          const soak = (q.equipment.head ? SOAK(q.equipment.head.item) : 0) + (q.equipment.body ? SOAK(q.equipment.body.item) : 0);
          const dmg = Math.max(0, 1 + (roll(beacon, pid, 'dmg') % maxHit) - soak);
          q.hp -= dmg;
          p.skills[tag2] += 4 * dmg;
          p.skills.hitpoints += dmg;
          if (q.hp > 0 && q.action?.type !== 'attackp' && q.action?.type !== 'attack') {
            q.action = { type: 'attackp', targetId: pid, since: s.tick + 1 }; // struck: strikes back
          }
          if (q.hp <= 0) {
            // slain in the Wilds (spec 2g): the pack spills where they fall,
            // and the body lies beside it awhile (v0.41)
            for (const sl of q.inventory) if (sl) {
              s.ground['g' + s.tick + '-' + Object.keys(s.ground).length] =
                { item: sl.item, qty: sl.qty ?? 1, x: q.x, y: q.y, expiresAt: s.tick + 100 };
            }
            q.inventory = q.inventory.map(() => null);
            q.equipment = { weapon: null, head: null, body: null };
            q.action = null; q.trade = null;
            q.deadUntil = s.tick + DEATH_TICKS;
          }
        }
      }
      continue;
    }
    if (p.action.type === 'attack') {
      const m = s.mobs[p.action.mobId];
      const stats = m && MOB_STATS[m.type];
      if (!m || m.hp <= 0) { p.action = null; continue; }
      const bowHeld = p.equipment.weapon?.item === 'wooden-bow'
        && Math.max(Math.abs(p.x - m.x), Math.abs(p.y - m.y)) <= 4;
      if (!adjacent(p, m) && !bowHeld) { p.action = null; continue; }
      const chained = p.equipment.weapon?.item === 'old-chain';
      if (!chained && (s.tick - (p.action.since ?? 0)) % 2 !== 0) continue; // combat breathes (6m); the chain does not (6r)
      const mobTurn = (s.tick - (p.action.since ?? 0)) % 2 === 0; // the defender keeps the old rhythm

      const bowDrawn = p.equipment.weapon?.item === 'wooden-bow' && !adjacent(p, m);
      if (bowDrawn) { // ranged (spec 6j): every draw costs an arrow, hit or miss
        const aSlot = p.inventory.findIndex(sl => sl?.item === 'arrows');
        if (aSlot === -1) { p.action = null; continue; }
        p.inventory[aSlot].qty -= 1;
        if (p.inventory[aSlot].qty <= 0) p.inventory[aSlot] = null;
        const rLvl = effLevel(p.skills.ranged);
        const Tr = clamp(128 + 4 * (rLvl - stats.def), 16, 240);
        if (roll(beacon, pid, 'atk') < Tr) {
          const maxHit = 1 + Math.floor(rLvl / 12);
          const dmg = 1 + (roll(beacon, pid, 'dmg') % maxHit);
          m.hp -= dmg;
          p.skills.ranged += 4 * dmg;
          p.skills.hitpoints += dmg;
        }
      } else {
      const atkLvl = effLevel(p.skills.attack);
      const T = clamp(128 + 4 * (atkLvl - stats.def), 16, 240);
      if (roll(beacon, pid, 'atk') < T) {
        const maxHit = 1 + Math.floor(atkLvl / 10)
          + (p.equipment.weapon?.item === 'bronze-sword' ? 2
            : p.equipment.weapon?.item === 'star-sword' ? 4
            : p.equipment.weapon?.item === 'old-chain' ? 1 : 0);
        const dmg = 1 + (roll(beacon, pid, 'dmg') % maxHit);
        m.hp -= dmg;
        p.skills.attack += 4 * dmg;
        p.skills.hitpoints += dmg;
      }
      }

      if (m.hp <= 0) {
        // drops lie where they fall (spec §6e): loot belongs to whoever takes it
        for (const d of stats.drops) {
          if (d.chance !== undefined && roll(beacon, pid, 'loot-' + d.item) >= d.chance) continue;
          const gid = 'g' + s.tick + '-' + p.action.mobId + '-' + d.item;
          s.ground[gid] = { item: d.item, x: m.x, y: m.y, expiresAt: s.tick + 100 };
        }
        m.respawnAt = s.tick + stats.respawn;
        p.action = null;
      } else {
        // retaliation (spec §6b.4)
        const defLvl = effLevel(p.skills.defence);
        const Tm = clamp(128 + 4 * (stats.atk - defLvl), 16, 240);
        if (roll(beacon, pid, 'mobatk') < Tm && !bowDrawn && mobTurn) {
          // armor soaks (spec 6i): each worn piece turns aside 1 damage
          const soak = (p.equipment.head ? SOAK(p.equipment.head.item) : 0) + (p.equipment.body ? SOAK(p.equipment.body.item) : 0);
          p.hp -= Math.max(0, 1 + (roll(beacon, pid, 'mobdmg') % stats.maxHit) - soak);
          if (p.hp <= 0) {
            // death (spec §6c, v0.41): the body lies where it fell for
            // DEATH_TICKS: the world holds its breath, windows may grieve.
            p.inventory = Array(INV_SLOTS).fill(null);
            p.equipment = { weapon: null, head: null, body: null }; // the sink spares nothing (§5d)
            p.action = null;
            p.trade = null;
            p.deadUntil = s.tick + DEATH_TICKS;
          }
        } else {
          p.skills.defence += 4;
        }
      }
      continue;
    }

    if (p.action.type !== 'gather') continue;
    const n = s.nodes[p.action.nodeId];

    if (!n || n.depletedUntil > s.tick || !adjacent(p, n)) {
      p.action = null;
      continue;
    }
    const slot = firstFreeSlot(p.inventory);
    if (slot === -1) { p.action = null; continue; }

    const y = NODE_YIELD[n.type];
    const lvl = effLevel(p.skills[y.skill]);
    const toolBonus = p.equipment.weapon?.item === TOOL_FOR[n.type] ? 24 : 0;
    const threshold = Math.min(64 + 2 * lvl + toolBonus, 240);
    const r = roll(beacon, pid, 'gather');

    if (r < threshold) {
      p.inventory[slot] = { item: y.item, qty: 1 };
      p.skills[y.skill] += y.xp;
      n.depletedUntil = s.tick + DEPLETE_TICKS;
    }
  }

  // tomorrow's lots, drawn from today's deeds (spec 7, v0.38)
  s.beacon = delayChain(beacon, inputsDigest(inputs)).toString('hex');
  return s;
}

module.exports = {
  SPEC_VERSION, TICK_MS, INV_SLOTS,
  XP_TABLE, levelForXp,
  canonical, stateHash, sha256, beaconValue, roll,
  generateIdentity, signInput, verifyInputSig,
  exportIdentity, importIdentity, loadOrCreateIdentity,
  SLEEP_AFTER, isAwake, effLevel, cityRectOf, inCity, PRICES, inWilds, spawnOf, makeGenesis, newWorld, sameWorld, addPlayer, addNode, addMob, nextState, MOB_STATS, RECIPES, EQUIPPABLE,
};
