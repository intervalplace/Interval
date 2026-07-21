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
//
// Node interop (final pre-freeze brief §7): @noble/hashes@2 is a pure-ESM
// package. engine.js is CommonJS, and require()-ing an ESM module at CJS
// load time RACES when engine.js is dynamically import()-ed concurrently
// (Node 22.x throws "module is not yet fully loaded"). To be
// order-independent AND portable, resolve SHA lazily:
//   - in Node, use the built-in `crypto` (no ESM require, no race);
//   - elsewhere (browsers/bundlers), fall back to @noble/hashes.
// ed25519 is fed sha512 from the same resolved source. Accessor names are
// unambiguous (nobleSha256/nobleSha512) and never shadow an import.
const ed = require('@noble/ed25519');

let _hashImpl = null;
function hashImpl() {
  if (_hashImpl) return _hashImpl;
  // prefer Node's native crypto: synchronous, always loaded, race-free
  try {
    const nc = require('crypto');
    if (nc && typeof nc.createHash === 'function') {
      _hashImpl = {
        sha256: (buf) => new Uint8Array(nc.createHash('sha256').update(Buffer.from(buf)).digest()),
        sha512: (buf) => new Uint8Array(nc.createHash('sha512').update(Buffer.from(buf)).digest()),
      };
      return _hashImpl;
    }
  } catch { /* not Node — fall through to noble */ }
  // browser/bundler path: pure-JS noble hashes
  const noble = require('@noble/hashes/sha2.js');
  _hashImpl = { sha256: noble.sha256, sha512: noble.sha512 };
  return _hashImpl;
}
function nobleSha256(buf) { return hashImpl().sha256(buf); }
function nobleSha512(buf) { return hashImpl().sha512(buf); }
let _sha512wired = false;
function ensureEdHash() {
  if (!_sha512wired) { ed.hashes.sha512 = nobleSha512; _sha512wired = true; }
}
// public: any code using @noble/ed25519 directly (e.g. a simulator minting
// keys) must call this once so ed25519 has its sha512 — the engine wires it
// lazily now, rather than at import time, to stay race-free across Node
// versions (§7).
function initCrypto() { ensureEdHash(); _selectEdBackend(); }
const hex = (u8) => Buffer.from(u8).toString('hex');

const SPEC_VERSION = '0.76';
const TICK_MS = 600;
const INV_SLOTS = 28;
// v0.70: a name is claimed once and held forever (§5a), with no release and no
// transfer, so an unclaimed name is a commons that can be taken permanently.
// Free identities made that a land grab: mint keys, claim every short word, and
// nobody can ever have them back. Standing is the toll, because standing is
// time and time is the one thing an attacker cannot parallelize away.
const NAME_STANDING = 50;
// The most inputs one tick may apply. A protocol limit, not a node's memory
// setting: it decides which deeds happen, so it decides state, so it belongs
// to the constitution.
const MAX_APPLIED_INPUTS = 4096;
// v0.76: and a part of that is always kept for people this world has never
// seen. Serving known citizens first (v0.70) stopped a flood of fresh keys
// from pushing established citizens out of the tick, but it handed whoever
// arrived first a permanent claim: spawning is free, so an attacker present on
// day one can mint citizens by the thousand and thereafter occupy the whole
// applied cap as KNOWN, with every honest newcomer behind them forever. A
// world that cannot be entered is a world that ends with the people already
// in it. This share is not a courtesy; it is the door.
const STRANGER_SHARE = 256;
// Typed error codes for the CJS engine (mirrors errors.mjs; kept in sync by
// test/version.test.mjs). Identity corruption is the one safety-critical
// engine throw that operators classify.
const ENGINE_ERR = { CORRUPT_IDENTITY: 'ERR_CORRUPT_IDENTITY', BACKEND_DISAGREEMENT: 'ERR_ED25519_BACKEND_DISAGREEMENT' };
function engineThrow(code, message) { const e = new Error(message); e.code = code; e.name = 'IntervalError'; throw e; }
// Constitutional tables (rev4 brief §11): ONE shared source — execution,
// validation, and tests all reference these. A validator with its own
// copy of the constitution eventually disagrees with the engine (it
// happened: signpost text), so neither may define these locally.
const SKILLS = ['woodcutting', 'mining', 'fishing', 'cooking', 'smithing',
  'firemaking', 'prayer', 'ranged', 'magic', 'farming', 'fletching', 'attack', 'defence', 'hitpoints', 'exploration', 'brewing'];
const EQUIP_SLOTS = ['weapon', 'head', 'body'];
const NODE_TYPES = ['tree', 'rock', 'magic-rock', 'fishing-spot', 'plot',
  'waystone', 'bank', 'anvil', 'campfire', 'fire', 'guard', 'house', 'signpost', 'smith', 'store', 'wall', 'well', 'brewpot', 'watchfire'];
// The constitutional NAME rule (spec §5a) as ONE shared validator (rev5
// §3): claim_name input validation, checkpoint validation, imports, and
// the registry all call this — never a private regex.
function isValidName(name) {
  return typeof name === 'string' && /^[a-z0-9-]{1,12}$/.test(name)
    && !name.startsWith('-') && !name.endsWith('-');
}
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
  'star-sword': { attack: 20 }, 'star-dagger': { attack: 20 }, 'old-chain': { attack: 30 },
  'star-spear': { attack: 20 }, 'star-maul': { attack: 25 }, 'horn-bow': { ranged: 20 },
  'star-helm': { defence: 15 }, 'star-plate': { defence: 30 },
};
const STORE_SELLS = { seeds: 15 }; // the keeper's OWN goods, made from nothing
// v0.74: the keeper's shelf. What a citizen sells is no longer annihilated: it
// sits in that store until somebody buys it. Two stores keep two shelves, so
// Anchor and Milbrook develop separate strengths and carrying goods between
// them is a trade in itself.
//
// The keeper takes a cut. A citizen sells at PRICES and the next buyer pays
// PRICES + max(1, PRICES/10), and the difference is destroyed. That spread is
// the world's only gold sink: before it, selling minted coin from nothing and
// nothing ever unmade it. A flat tenth would have rounded to zero on the nine
// cheapest goods, which are the ones that actually move, so the cut is never
// less than a single coin.
const SHELF_CAP = 1000;        // per item, per store: consensus state is forever
const SHELF_DECAY_EVERY = 1500; // 15 minutes
const SHELF_DECAY_SHIFT = 4;    // a sixteenth rots away: goods nobody wanted // farming no longer waits on goblin luck
const MAGIC_ROCK_MINING = 10; // the vein refuses an unpracticed pick
const DEATH_TICKS = 5; // the world holds its breath; windows may grieve
const BRAND_TICKS = 1500; // strike first in the Wilds, wear it 15 minutes
// the star-dagger's root (v0.49): rare and expensive by design — a 3-tick
// freeze on a 120-tick leash, and a 10-tick immunity after so no one is
// chain-frozen. Landing it is a decision, not a rhythm.
const ROOT_TICKS = 3, ROOT_IMMUNE = 10, ROOT_CD = 120;
const XP_COOK = 30;
// v0.73: the gullet has its own rhythm, as the arm does (§6b, lastSwing).
// Without one, a citizen ate every interval while the fight held, and broth
// heals 5 against a skeleton-knight's 2 hp per interval at absolute maximum:
// nobody carrying brews could die, so death, the Wilds and the brand were all
// decoration. Eating mid-fight stays legal, as §6m intends. It simply has a
// rate now, and that rate is what makes a beast dangerous to the unready.
const EAT_EVERY = 8;
const HEAL_FISH = 3;
const HEAL_BROTH = 5, HEAL_ALE = 4; // brewed restoration (v0.51)
const HP_START_XP = 1154; // hitpoints level 10
// ---- weapons (v0.65): the metal is the tier, the shape is the choice ----
// No new materials. The same ore and star-stone, worked into different answers
// to the same question, so that how a citizen fights is something they chose
// rather than something the tier chose for them.
//   hit   added to the maximum blow
//   every ticks between swings (combat breathes; the chain does not)
//   reach how far the weapon touches (1 is arm's length)
//   acc   added to the odds of landing at all
// A dagger lands often for little; a maul lands seldom for a lot; a spear
// keeps its distance; a sword asks no questions. The chain is the chain.
const WEAPONS = {
  'bronze-dagger': { hit: 0, every: 2, reach: 1, acc: 24 },
  'bronze-sword':  { hit: 2, every: 2, reach: 1, acc: 0 },
  'bronze-spear':  { hit: 1, every: 2, reach: 2, acc: 0 },
  'bronze-maul':   { hit: 4, every: 3, reach: 1, acc: -24 },
  'star-dagger':   { hit: 2, every: 2, reach: 1, acc: 24 },
  'star-sword':    { hit: 4, every: 2, reach: 1, acc: 0 },
  'star-spear':    { hit: 3, every: 2, reach: 2, acc: 0 },
  'star-maul':     { hit: 7, every: 3, reach: 1, acc: -24 },
  'old-chain':     { hit: 1, every: 1, reach: 1, acc: 0 },
  'wooden-bow':    { hit: 0, every: 2, reach: 4, acc: 0, ranged: true },
  'horn-bow':      { hit: 2, every: 2, reach: 5, acc: 0, ranged: true },
};
const weaponOf = (p) => WEAPONS[p?.equipment?.weapon?.item] ?? null;
const reachOf = (p) => weaponOf(p)?.reach ?? 1;
const isRanged = (p) => weaponOf(p)?.ranged === true;
// a ranged weapon is drawn only at distance; in your face it is a club
const drawnAt = (p, t) => isRanged(p) && !adjacent(p, t);
const inReach = (p, t) => Math.max(Math.abs(p.x - t.x), Math.abs(p.y - t.y)) <= reachOf(p);

const MOB_STATS = {
  goblin: { maxHp: 5, atk: 1, def: 1, maxHit: 1, respawn: 16,
            drops: [{ item: 'bones' }, { item: 'ore', chance: 16384 }, { item: 'seeds', chance: 16384 }] },
  wolf:   { maxHp: 8, atk: 2, def: 2, maxHit: 2, respawn: 150,
            drops: [{ item: 'bones' }, { item: 'bones', chance: 24576 }] },
  // v0.75: the old-chain falls at 2/65536, one troll in 32,768, which is some
  // nine days of an executor farming trolls without pause. It is the only item
  // in the world with no price at any store, so it can never be sold to a
  // keeper and only ever passes between citizens. The best weapon here is the
  // one thing gold cannot be turned into except by asking someone who has one.
  troll:  { maxHp: 20, atk: 4, def: 4, maxHit: 3, respawn: 300,
            drops: [{ item: 'bones' }, { item: 'ore' }, { item: 'bronze-plate', chance: 6144 },
                    { item: 'old-chain', chance: 2 }] },
  bear:   { maxHp: 14, atk: 3, def: 3, maxHit: 2, respawn: 220,
            drops: [{ item: 'bones' }, { item: 'bones', chance: 32768 }, { item: 'bronze-hatchet', chance: 4096 },
                    { item: 'horn-bow', chance: 66 }] },
  // the skeleton-knight (v0.42): a horned, shield-bearing warrior of the frontier.
  // Seldom alone — they muster in warbands in and around the Wilds. The round
  // shield makes them hard to strike (high def); the longsword bites back. And
  // their bones are rich: a fallen knight gives up twice what a lesser thing does.
  'skeleton-knight': { maxHp: 18, atk: 5, def: 6, maxHit: 4, respawn: 120,
            drops: [{ item: 'bones' }, { item: 'bones' },   // double bones — the warrior's due
                    { item: 'ore', chance: 12288 },            // scavenged metal
                    { item: 'star-helm', chance: 328 }] },    // rare: the horned helm itself
};
// the store's ledger (spec 6l)
const GROW_TICKS_RIPE = 1200; // spec 6o: twelve minutes, seed to harvest
const PRICES = {
  'bronze-dagger': 8, 'bronze-spear': 14, 'bronze-maul': 22,
  'star-spear': 100, 'star-maul': 160, 'horn-bow': 90,
  'logs': 2, 'ore': 5, 'raw-fish': 3, 'cooked-fish': 6, 'bones': 2, 'arrows': 1,
  'magic-stone': 20, 'bronze-sword': 15, 'bronze-hatchet': 10, 'bronze-pickaxe': 10,
  'bronze-helm': 12, 'bronze-plate': 30, 'wooden-bow': 8, 'grain': 4,
  'star-sword': 120, 'star-helm': 60, 'star-plate': 200,
};
const storeAsk = (item) => PRICES[item] + Math.max(1, Math.floor(PRICES[item] / 10));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// the Wilds (spec 2g): where citizens may hunt citizens
// ---- a world's own geography lives in its founding record (v0.54) ----
// The classic world's rectangles were written as constants when there was
// only one world. They are now defaults: a genesis that names `geo` supplies
// its own, and a genesis that does not gets exactly the classic numbers, so
// the founded world is unchanged to the byte.
function wildsRectOf(g) { return g?.geo?.wilds ?? { x0: 1, x1: 34, y0: 1, y1: 22 }; } // spec 2h
const inWilds = (g, x, y) => {
  const r = wildsRectOf(g);
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
};
// the city of Anchor (spec 2d): mob-forbidden bounds
function cityRectOf(g) {
  if (g?.geo?.city) return g.geo.city;
  const cx = Math.floor(g.worldW / 2);
  return { x0: cx - 8, x1: cx + 8, y0: 2, y1: 10 };
}
// Norwick (spec 2i): the garrison town, a second safe settlement on the Wilds frontier
function norwickRectOf(g) {
  return g?.geo?.norwick ?? { x0: 36, x1: 50, y0: 24, y1: 36 };
}
const inCity = (g, x, y) => {
  const c = cityRectOf(g), n = norwickRectOf(g);
  return (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1)
      || (x >= n.x0 && x <= n.x1 && y >= n.y0 && y <= n.y1);
};
const RECIPES = {
  'bronze-dagger': { ore: 1 },
  'bronze-spear': { ore: 1, logs: 1 },
  'bronze-maul': { ore: 2, logs: 1 },
  'star-spear': { 'magic-stone': 2, ore: 1, logs: 1 },
  'star-maul': { 'magic-stone': 3, ore: 2, logs: 1 },
  'bronze-sword':   { ore: 2, logs: 1 },
  'bronze-hatchet': { ore: 1, logs: 1 },
  'bronze-pickaxe': { ore: 1, logs: 1 },
  'bronze-helm':    { ore: 1, logs: 1 },
  'bronze-plate':   { ore: 3, logs: 1 },
  'star-sword':     { 'magic-stone': 3, ore: 2 },
  'star-helm':      { 'magic-stone': 2, ore: 1 },
  'star-plate':     { 'magic-stone': 4, ore: 3 },
  'star-dagger':    { 'magic-stone': 2, ore: 1 },
};
const EQUIPPABLE = new Set([...Object.keys(RECIPES), 'wooden-bow', 'horn-bow', 'old-chain']);
// The constitutional ITEM vocabulary (rev5 §4): every item the engine can
// mint, derived from protocol constants plus the base gather/drop set. A
// syntactically pretty identifier that is not in this set is contraband:
// validation rejects it in inventories, banks, equipment, ground, trades,
// and imports alike.
const ITEMS = new Set([
  'seeds', 'grain', 'logs', 'ore', 'raw-fish', 'cooked-fish', 'burnt-fish',
  'bones', 'arrows', 'wooden-bow', 'horn-bow', 'magic-stone', 'sigil', 'old-chain', 'ale', 'broth',
  ...Object.keys(RECIPES),
]);
const EQUIP_SLOT = { 'bronze-helm': 'head', 'bronze-plate': 'body', 'star-helm': 'head', 'star-plate': 'body' }; // default: weapon
// the first level requirements (spec 6q): an unearned hammer strikes nothing
const SMITH_REQS = { 'star-sword': { smithing: 20, magic: 10 },
  'star-helm': { smithing: 15, magic: 5 }, 'star-plate': { smithing: 30, magic: 15 },
  'star-dagger': { smithing: 20, magic: 15 },
  'star-spear': { smithing: 22, magic: 12 }, 'star-maul': { smithing: 28, magic: 15 } };
const SOAK = (item) => item?.startsWith('star-') ? 2 : 1; // starmetal turns aside more
const slotOf = (item) => EQUIP_SLOT[item] ?? 'weapon';
const TOOL_FOR = { tree: 'bronze-hatchet', rock: 'bronze-pickaxe' };

// Canonical signed-input schemas (pre-freeze §1–§4): every semantic
// action has EXACTLY one accepted signed representation. The shape
// validator has one responsibility — accept only structurally canonical
// protocol inputs: exact base fields with exact formats, exact per-action
// fields with exact primitive types, constitutional vocabularies, and
// canonical null/zero conventions. State-dependent questions (does the
// target exist, is the slot occupied, is the node adjacent) belong to
// validInput's per-case code, never here.
const T = {
  unit: (v) => [-1, 0, 1].includes(v) || 'must be -1, 0, or 1',
  slot: (v) => (Number.isInteger(v) && v >= 0 && v < INV_SLOTS) || 'must be an inventory slot index',
  // v0.69: a trade names one or more of the offerer's slots. Ordered, unique,
  // never empty, never longer than the pack: canonical so two nodes reading
  // the same offer always read the same offer.
  slotList: (v) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > INV_SLOTS) return 'must be 1..' + INV_SLOTS + ' inventory slots';
    for (let i = 0; i < v.length; i++) {
      if (!Number.isInteger(v[i]) || v[i] < 0 || v[i] >= INV_SLOTS) return 'must be inventory slot indexes';
      if (i > 0 && v[i] <= v[i - 1]) return 'slots must be ascending and unique';
    }
    return true;
  },
  nonnegInt: (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e12) || 'must be a nonnegative integer',
  id: (v) => (typeof v === 'string' && /^[a-z0-9_-]{1,64}$/i.test(v)) || 'must be an identifier',
  hex64: (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) || 'must be lowercase 64-hex',
  item: (v) => ITEMS.has(v) || 'must be a constitutional item',
  itemOrNull: (v) => v === null || ITEMS.has(v) || 'must be a constitutional item or null',
  recipe: (v) => (typeof v === 'string' && v in RECIPES) || 'must be a constitutional recipe',
  gear: (v) => EQUIP_SLOTS.includes(v) || 'must be an equipment slot name',
  spell: (v) => ['anchor', 'mend'].includes(v) || 'must be a constitutional spell',
  make: (v) => ['bow', 'arrows'].includes(v) || 'must be bow or arrows',
  name: (v) => isValidName(v) || 'must be a constitutional name',
};
const INPUT_SCHEMAS = {
  spawn: {}, stop: {}, cancel_trade: {}, invoke: {},
  move: { dx: T.unit, dy: T.unit },
  gather: { nodeId: T.id }, harvest: { nodeId: T.id },
  attack: { mobId: T.id },
  attackp: { targetId: T.hex64 },
  recall: { to: T.id },
  // pre-freeze §1: BOTH demand fields, always, explicitly — the canonical
  // item trade carries wantGold: 0; the canonical gold trade carries
  // wantItem: null. Omission is not a representation.
  offer_trade: { to: T.hex64, giveSlots: T.slotList, wantItem: T.itemOrNull, wantGold: T.nonnegInt },
  accept_trade: { from: T.hex64 },
  smith: { recipe: T.recipe },
  wield: { slot: T.slot }, sell: { slot: T.slot }, plant: { slot: T.slot },
  light: { slot: T.slot }, bury: { slot: T.slot }, deposit: { slot: T.slot },
  drop: { slot: T.slot }, eat: { slot: T.slot }, cook: { slot: T.slot },
  unwield: { gear: T.gear },
  buy: { item: T.item }, withdraw: { item: T.item },
  cast: { spell: T.spell },
  fletch: { slot: T.slot, make: T.make },
  pickup: { groundId: T.id },
  claim_name: { name: T.name },
  survey: {}, read_chart: { slot: T.slot },
  build_brewpot: {}, brew: { nodeId: T.id, slot: T.slot }, collect: { nodeId: T.id }, dismantle: { nodeId: T.id },
  kindle: {}, stoke: { nodeId: T.id, slot: T.slot },
};
const INPUT_BASE = { worldId: T.hex64, playerId: T.hex64,
  tick: (v) => (Number.isSafeInteger(v) && v >= 0) || 'must be a nonnegative tick',
  sig: (v) => (typeof v === 'string' && /^[0-9a-f]{128}$/.test(v)) || 'must be a 128-hex signature',
};

function validateInputShape(input) {
  if (!input || typeof input !== 'object') return 'malformed input';
  const schema = INPUT_SCHEMAS[input.type];
  if (schema === undefined) return 'unknown input type';
  // pre-freeze §2: EVERY base field required, with its exact format
  for (const [k, check] of Object.entries(INPUT_BASE)) {
    if (!(k in input)) return `missing base field ${k}`;
    const r = check(input[k]);
    if (r !== true) return `base field ${k} ${r}`;
  }
  for (const k of Object.keys(input)) {
    if (k === 'type' || k in INPUT_BASE) continue;
    if (!(k in schema)) return `unknown field ${k} on ${input.type}`;
  }
  for (const [k, check] of Object.entries(schema)) {
    if (!(k in input)) return `missing field ${k} on ${input.type}`;
    const r = check(input[k]);
    if (r !== true) return `field ${k} on ${input.type} ${r}`;
  }
  // canonical demand convention (pre-freeze §1): exactly one of a
  // constitutional item XOR positive gold — structural, because it is
  // about REPRESENTATION, not about the world
  if (input.type === 'offer_trade'
    && (input.wantItem !== null) === (input.wantGold > 0)) return 'trade must want exactly one of item or gold';
  return null;
}

// One shared normalizer (pre-freeze §5): every client builds the object it
// signs THROUGH this, so equivalent user-facing requests always produce
// byte-identical canonical objects. Fills canonical null/zero values,
// normalizes numbers (-0 becomes 0), and refuses anything the schema
// refuses. `sig` is a shape-gate concern; normalization runs BEFORE signing.
function normalizeInput(fields) {
  if (!fields || typeof fields !== 'object') throw new Error('normalizeInput: malformed fields');
  const schema = INPUT_SCHEMAS[fields.type];
  if (schema === undefined) throw new Error('normalizeInput: unknown input type ' + JSON.stringify(fields.type));
  const out = { type: fields.type };
  for (const k of Object.keys(fields)) {
    if (k === 'type') continue;
    if (!(k in schema)) throw new Error(`normalizeInput: unknown field ${k} on ${fields.type}`);
  }
  for (const k of Object.keys(schema)) {
    let v = fields[k];
    if (v === undefined || v === null) { // canonical null/zero fills
      if (fields.type === 'offer_trade' && k === 'wantItem') v = null;
      else if (fields.type === 'offer_trade' && k === 'wantGold') v = 0;
      else if (v === undefined) throw new Error(`normalizeInput: missing field ${k} on ${fields.type}`);
    }
    if (typeof v === 'number' && Object.is(v, -0)) v = 0;
    const r = schema[k](v);
    if (r !== true) throw new Error(`normalizeInput: field ${k} on ${fields.type} ${r}`);
    out[k] = v;
  }
  if (fields.type === 'offer_trade' && (out.wantItem !== null) === (out.wantGold > 0))
    throw new Error('normalizeInput: trade must want exactly one of item or gold');
  return out;
}
const XP_SMITH_PER_ORE = 30;
const XP_FIREMAKING = 40;
const XP_BURY = 25;
const FIRE_TICKS = 100;
const SLEEP_AFTER = 500;
function isAwake(p, tick) {
  return p.action !== null || tick - (p.lastInput ?? 0) <= SLEEP_AFTER;
}

// ---- the terrain registry (v0.77): a generator TEACHES the engine to
// walk its country. The engine stays generator-agnostic (worldgen
// imports engine, never the reverse); loading a generator's module IS
// implementing its country, and registering its walkability is part of
// implementing it. Unregistered generators keep the old law (nothing
// but the hedge and the nodes bars the way) — which is what every
// world founded before this shipped replays under.
const TERRAINS = Object.create(null);
function registerTerrain(id, t) { TERRAINS[id] = t; }
function terrainBlocked(g, x, y) {
  const t = TERRAINS[g.worldGenerator];
  return t && t.blocked ? !!t.blocked(g, x, y) : false;
}
const spawnOf = (g) => (TERRAINS[g.worldGenerator] && TERRAINS[g.worldGenerator].spawn
  ? TERRAINS[g.worldGenerator].spawn(g)
  : { x: Math.floor(g.worldW / 2), y: Math.floor(g.worldH / 2) });

// ---------- XP table: spec constants (Appendix A). Index = level. ----------
const XP_TABLE = [0,0,83,174,276,388,512,650,801,969,1154,1358,1584,1833,2107,2411,2746,3115,3523,3973,4470,5018,5624,6291,7028,7842,8740,9730,10824,12031,13363,14833,16456,18247,20224,22406,24815,27473,30408,33648,37224,41171,45529,50339,55649,61512,67983,75127,83014,91721,101333,111945,123660,136594,150872,166636,184040,203254,224466,247886,273742,302288,333804,368599,407015,449428,496254,547953,605032,668051,737627,814445,899257,992895,1096278,1210421,1336443,1475581,1629200,1798808,1986068,2192818,2421087,2673114,2951373,3258594,3597792,3972294,4385776,4842295,5346332,5902831,6517253,7195629,7944614,8771558,9684577,10692629,11805606,13034431];

// 2^(r/7) scaled by 2^96, as exact integers. ECMA-262 does not require
// Math.pow to be correctly rounded, so the curve past mastery is computed from
// these rather than from a float power: two engines that disagreed in the last
// place would report different standings for the same citizen. (Verified: this
// reproduces every one of the 98 constitutional thresholds exactly, and V8's
// own Math.pow already differs from the true value at 15 levels past 267.)
const POW2_SEVENTHS = [
  79228162514264337593543950336n, 87474983419643881438334899625n,
  96580211902419410754522887331n, 106633199189855989094361944303n,
  117732597035010858756489598210n, 129987325803940059419872279709n,
  143517643330631577550838571505n];
function xpStepAt(lvl) { // floor(lvl + 300 * 2^(lvl/7)), exactly
  const q = BigInt(Math.floor(lvl / 7)), r = lvl % 7;
  return lvl + Number((300n * (1n << q) * POW2_SEVENTHS[r]) >> 96n);
}
function levelForXp(xp) {
  let lvl = 1;
  while (lvl < 99 && xp >= XP_TABLE[lvl + 1]) lvl++;
  if (lvl < 99 || xp < XP_TABLE[99]) return lvl;
  // beyond mastery (spec 4b): the same recurrence, continued without bound
  let points = XP_TABLE[99] * 4;
  while (true) {
    points += xpStepAt(lvl);
    if (xp < Math.floor(points / 4)) return lvl;
    lvl++;
  }
}
// mechanics read capped mastery (spec 4b)
const effLevel = (xp) => Math.min(levelForXp(xp), 99);

// ---------- who a citizen is (spec 10, v0.55) ----------
// Two windows once each invented their own idea of a citizen's "level" and
// disagreed about the same public state, which meant level was a property of
// the software rather than of the person. It is derived here instead, so every
// window agrees forever.
//
// STANDING is the sum of every skill's TRUE level — levelForXp, not effLevel,
// because mastery at 99 is a milestone and not a ceiling. A citizen who keeps
// going past mastery keeps rising, and standing has no maximum to hardcode.
function standingOf(p) {
  let n = 0;
  for (const sk of SKILLS) n += levelForXp(p?.skills?.[sk] ?? 0);
  return n;
}
// CALLING is the profession a citizen is best at, as a word. Hitpoints is
// excluded: it is a consequence of fighting rather than a trade, and it starts
// at 10, so without this every citizen would be born a fighter. Ties fall to
// the constitutional skill order, so the answer is the same on every node.
const CALLINGS = {
  woodcutting: 'forester', mining: 'miner', fishing: 'fisher', cooking: 'cook',
  smithing: 'smith', firemaking: 'firekeeper', prayer: 'mourner', ranged: 'archer',
  magic: 'sigilist', farming: 'farmer', fletching: 'fletcher', attack: 'fighter',
  defence: 'warden', exploration: 'cartographer', brewing: 'brewer',
};
// Chosen by EXPERIENCE, not by level. Levels are a step function of xp, so the
// skill with the most experience always holds the highest level too: comparing
// xp settles ties between equal levels the way a citizen expects, and gives the
// identical answer everywhere else. Ties in raw xp fall to the constitutional
// skill order, so every node still answers the same.
function callingOf(p) {
  let best = null, bestXp = -1;
  for (const sk of SKILLS) {
    if (sk === 'hitpoints') continue;
    const xp = p?.skills?.[sk] ?? 0;
    if (xp > bestXp) { bestXp = xp; best = sk; }
  }
  if (best === null || levelForXp(bestXp) <= 1) return 'newcomer';
  // all sixteen: the same condition the world announces as Master of Interval.
  // Written now, while nobody is near it, because every rule change is a fork
  // and the day someone approaches this is the worst possible day to need one.
  if (SKILLS.every(sk => (p?.skills?.[sk] ?? 0) >= XP_TABLE[99])) return 'Master of Interval';
  // Mastery is the one milestone this world already stops to announce, so the
  // calling says it. Note what needs no extra rule: since the calling is the
  // MOST-experienced trade, a citizen who has mastered anything has at least
  // that much experience in their calling, so the word turns to master exactly
  // when they have mastered something. Past mastery it does not change again;
  // standing carries the rest.
  return (bestXp >= XP_TABLE[99] ? 'master ' : '') + CALLINGS[best];
}

// ---------- canonical encoding & hashing ----------

// Canonical encoding (CONSENSUS.md §2): recursively key-sorted JSON over
// null, booleans, FINITE numbers, strings, arrays, and plain objects.
// Anything else is rejected loudly — a hash over silently-coerced data is
// a consensus bug waiting for its tick.
function canonical(obj) {
  if (obj === undefined) throw new Error('canonical: undefined is not encodable');
  if (obj === null) return 'null';
  const t = typeof obj;
  if (t === 'number') {
    if (!Number.isFinite(obj)) throw new Error('canonical: non-finite number (NaN/Infinity) is not encodable');
    return JSON.stringify(obj);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(obj);
  if (t !== 'object') throw new Error('canonical: unsupported type ' + t);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) throw new Error('canonical: unsupported object type');
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256(buf) {
  return Buffer.from(nobleSha256(buf));
}

// ---------- state-hash memoization (perf brief 1D) ----------
// nextState returns a fresh object and never mutates its caller's state,
// so a state object's canonical hash is stable for that object's lifetime.
// The same object is legitimately hashed several times per tick (prev-hash
// binding, resulting hash, attestation checks, checkpointing); memoize by
// OBJECT IDENTITY in a WeakMap. Never by tick number, never by a
// state-carried field, never across distinct objects. A WeakMap attaches no
// protocol-visible metadata, needs no invalidation, and retains nothing
// once a state is unreferenced.
//
// Discipline this relies on (enforced by test/perf.test.mjs): any code that
// mutates a state object in place — e.g. a tamper/rule-breaker hook — must
// do so BEFORE the object is first hashed. Every current call site
// replaces state objects rather than mutating them.
const _stateHashCache = new WeakMap();
function stateHash(state) {
  const memoizable = state !== null && typeof state === 'object';
  if (memoizable) {
    const cached = _stateHashCache.get(state);
    if (cached !== undefined) { _perf.stateHashHits++; return cached; }
  }
  _perf.stateHashMisses++;
  const h = sha256(Buffer.from(canonical(state))).toString('hex');
  if (memoizable) _stateHashCache.set(state, h);
  return h;
}

// ---------- identity: ed25519 keypairs (noble, universal) ----------
// playerId = hex of the raw 32-byte public key.
// privateKey = raw 32-byte secret (Uint8Array). Guard it: it IS the character.

function generateIdentity() {
  const privateKey = ed.utils.randomSecretKey();
  ensureEdHash(); return { playerId: hex(ed.getPublicKey(privateKey)), privateKey };
}

// ---------- signature domains (fix brief §2.3) ----------
// Every signature is bound to a purpose: a chat signature can never be
// replayed as a game input, and vice versa. The domain string prefixes
// the signed bytes; the payload itself carries the exact worldId.
const SIG_DOMAINS = {
  input: 'INTERVAL_INPUT_V1|',
  chat:  'INTERVAL_CHAT_V1|',
};

// The signed payload is the domain prefix + canonical input without its sig field.
function inputPayload(input, domain = SIG_DOMAINS.input) {
  const { sig, ...rest } = input;
  return Buffer.from(domain + canonical(rest));
}

function signInput(input, privateKey, domain = SIG_DOMAINS.input) {
  ensureEdHash(); return { ...input, sig: hex(ed.sign(inputPayload(input, domain), privateKey)) };
}

// ---------- ed25519 verification backend (perf brief 1B) ----------
// The protocol requires signature verification; it does not require a
// particular library. Node's OpenSSL-backed Ed25519 verifies ~20x faster
// than the pure-JS fallback. The accepted set must not change, so the
// backend is structured as native-accept fast path, fallback-authoritative:
//
//   OpenSSL enforces strict RFC 8032 (canonical encodings, S < L,
//   cofactorless equation). @noble's default acceptance is a mathematical
//   superset of that: its cofactored check with liberal point decoding
//   accepts every strictly-valid signature (R + hA = sB implies
//   8(R + hA - sB) = 0, and canonical encodings decode identically).
//   Therefore native-accept ⇒ noble-accept, and acceptance may be
//   fast-pathed. Any native REJECTION is re-judged by the fallback, which
//   remains the sole authority on the constitutional accepted set. A
//   crafted edge-case signature costs one extra cheap native call; an
//   honest valid signature costs ~0.1 ms instead of ~2.6 ms.
//
// Backend selection happens once (initCrypto or first verification) and
// runs a known-answer cross-check; a disagreement between backends on a
// strict vector is a startup failure, never a silent fallback.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PUBKEY_OBJECTS_MAX = 8192; // KeyObject construction cache (implementation constant)
let _edBackendName = null; // 'native+fallback' | 'fallback'
let _nativeCrypto = null;
const _pubKeyObjects = new Map(); // raw pubkey hex -> KeyObject (bounded LRU)

const _perf = {
  sigCacheHits: 0, sigCacheMisses: 0, sigCacheEvictions: 0,
  nativeCalls: 0, fallbackCalls: 0,
  stateHashHits: 0, stateHashMisses: 0,
};
// Non-consensus observability (perf brief 1C): logs/benchmarks only.
// These counters never influence engine behavior or enter canonical state.
function perfStats() { return { backend: _edBackendName ?? 'unselected', ..._perf }; }

function _fallbackVerify(pubBytes, payloadBuf, sigBytes) {
  try { ensureEdHash(); return ed.verify(sigBytes, payloadBuf, pubBytes); } catch { return false; }
}

function _nativeKeyObject(pubBytes) {
  const k = Buffer.from(pubBytes).toString('hex');
  const hit = _pubKeyObjects.get(k);
  if (hit !== undefined) { _pubKeyObjects.delete(k); _pubKeyObjects.set(k, hit); return hit; }
  const obj = _nativeCrypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pubBytes]), format: 'der', type: 'spki',
  });
  _pubKeyObjects.set(k, obj);
  if (_pubKeyObjects.size > PUBKEY_OBJECTS_MAX) _pubKeyObjects.delete(_pubKeyObjects.keys().next().value);
  return obj;
}

function _nativeVerify(pubBytes, payloadBuf, sigBytes) {
  // Lengths native would reject with a throw are rejected up front; both
  // implementations reject them, so this changes no answer.
  if (pubBytes.length !== 32 || sigBytes.length !== 64) return false;
  try { return _nativeCrypto.verify(null, payloadBuf, _nativeKeyObject(pubBytes), Buffer.from(sigBytes)); }
  catch { return false; }
}

function _selectEdBackend() {
  if (_edBackendName !== null) return;
  let nc = null;
  try {
    nc = require('crypto');
    if (!nc || typeof nc.verify !== 'function' || typeof nc.createPublicKey !== 'function') nc = null;
  } catch { nc = null; }
  if (nc) {
    // Probe for Ed25519 capability before trusting it.
    try { nc.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.alloc(32, 9)]), format: 'der', type: 'spki' }); }
    catch { nc = null; }
  }
  if (!nc) { _edBackendName = 'fallback'; return; } // capability absent: conservative fallback is acceptable
  _nativeCrypto = nc;
  // Known-answer cross-check: every vector is strict, so the backends must
  // agree exactly. Disagreement here means one implementation is broken,
  // and that is a startup failure — never a quiet fallback.
  ensureEdHash();
  const seed = new Uint8Array(32).fill(0x42);
  const katPub = ed.getPublicKey(seed);
  const katMsg = Buffer.from('INTERVAL_ED25519_BACKEND_KAT_V1');
  const katSig = ed.sign(katMsg, seed);
  const flipped = Buffer.from(katSig); flipped[0] ^= 0xff;
  const vectors = [
    [Buffer.from(katPub), katMsg, Buffer.from(katSig), true],                 // valid
    [Buffer.from(katPub), Buffer.concat([katMsg, Buffer.from('!')]), Buffer.from(katSig), false], // altered message
    [Buffer.from(katPub), katMsg, flipped, false],                            // altered signature
    [Buffer.from(katPub).subarray(1), katMsg, Buffer.from(katSig), false],    // malformed key (31 bytes)
    [Buffer.from(katPub), katMsg, Buffer.from(katSig).subarray(1), false],    // truncated signature
    [Buffer.from(katPub), katMsg, Buffer.concat([katSig, Buffer.from([0])]), false], // oversized signature
  ];
  for (const [p, m, s, expect] of vectors) {
    if (_fallbackVerify(p, m, s) !== expect)
      engineThrow(ENGINE_ERR.BACKEND_DISAGREEMENT, 'ed25519 fallback failed its own known-answer test');
    if (_nativeVerify(p, m, s) !== expect)
      engineThrow(ENGINE_ERR.BACKEND_DISAGREEMENT, 'native and fallback ed25519 disagree on a strict known-answer vector — refusing to start with an untrustworthy backend');
  }
  _edBackendName = 'native+fallback';
}

function _backendVerify(pubBytes, payloadBuf, sigBytes) {
  _selectEdBackend();
  if (_edBackendName === 'native+fallback') {
    _perf.nativeCalls++;
    if (_nativeVerify(pubBytes, payloadBuf, sigBytes)) return true; // native-accept ⇒ accept (see superset note)
  }
  _perf.fallbackCalls++;
  return _fallbackVerify(pubBytes, payloadBuf, sigBytes); // authoritative on every rejection
}

// ---------- signature-verification cache (perf brief 1C) ----------
// Verification is a pure function of (public key, signed payload,
// signature). For identical bytes the answer cannot change within a
// process lifetime, so repeated curve math is waste: the same input is
// legitimately verified at proposal admission, bundle validation, inside
// the state machine, and again during attestation and catch-up replay.
// The cache is process-local, bounded, disposable, never persisted, never
// transmitted, and never part of canonical state: a node restarting with
// an empty cache produces the same history.
let _sigCacheMax = 16384; // implementation constant; test hook may shrink it
const _sigCache = new Map(); // insertion-ordered => cheap LRU

function _sigCacheKey(pubBytes, payloadBuf, sigBytes) {
  // Commits to all three components, length-prefixed so variable-length
  // malformed material cannot collide across field boundaries. The payload
  // itself carries the domain prefix, so the domain is committed too.
  const lens = Buffer.from([
    pubBytes.length & 0xff, (pubBytes.length >> 8) & 0xff,
    sigBytes.length & 0xff, (sigBytes.length >> 8) & 0xff,
  ]);
  return sha256(Buffer.concat([lens, pubBytes, sigBytes, payloadBuf])).toString('latin1');
}

function verifyInputSig(input, domain = SIG_DOMAINS.input) {
  if (typeof input.sig !== 'string' || typeof input.playerId !== 'string') return false;
  let payloadBuf, pubBytes, sigBytes;
  try {
    payloadBuf = inputPayload(input, domain);
    pubBytes = Buffer.from(input.playerId, 'hex');
    sigBytes = Buffer.from(input.sig, 'hex');
  } catch {
    return false; // non-encodable input: identical to the pre-cache catch-all
  }
  const key = _sigCacheKey(pubBytes, payloadBuf, sigBytes);
  if (_sigCache.has(key)) { // has(): a cached `false` must not read as absent
    const v = _sigCache.get(key);
    _sigCache.delete(key); _sigCache.set(key, v); // LRU touch
    _perf.sigCacheHits++;
    return v;
  }
  _perf.sigCacheMisses++;
  const valid = _backendVerify(pubBytes, payloadBuf, sigBytes);
  _sigCache.set(key, valid); // negative results cached too: forged floods repeat
  if (_sigCache.size > _sigCacheMax) {
    _sigCache.delete(_sigCache.keys().next().value);
    _perf.sigCacheEvictions++;
  }
  return valid;
}

// Low-level signatures for the protocol layer (bundles, attestations):
// the engine is the single home of the ed25519 wiring, so higher layers
// never re-import or re-configure the curve.
function signPayload(payloadBuf, privateKey) {
  ensureEdHash(); return hex(ed.sign(payloadBuf, privateKey));
}
function verifyPayload(sigHex, payloadBuf, pubHex) {
  // Same accept-set-preserving backend as input signatures (perf brief 1B):
  // native fast path on acceptance, fallback authoritative on rejection.
  let pubBytes, sigBytes;
  try {
    pubBytes = Buffer.from(pubHex, 'hex');
    sigBytes = Buffer.from(sigHex, 'hex');
  } catch {
    return false;
  }
  return _backendVerify(pubBytes, payloadBuf, sigBytes);
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
  // PURE in (prevBeacon, digest): a bounded memo changes no output ever.
  // Every witness computes the SAME chain for the same proposed bundle —
  // once when attesting, again when replaying a finality record — and an
  // in-process multi-node simulation computes it once per node. Cache it.
  const key = prevBeacon.toString('hex') + '|' + digest.toString('hex');
  const hit = delayChain._memo.get(key);
  if (hit) return hit;
  let h = sha256(Buffer.concat([prevBeacon, digest]));
  for (let i = 1; i < LOTS_N; i++) h = sha256(h);
  if (delayChain._memo.size >= 128) delayChain._memo.delete(delayChain._memo.keys().next().value);
  delayChain._memo.set(key, h);
  return h;
}
delayChain._memo = new Map();

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
// The tally's denominator. It was 256, an eight-bit rate, whose rarest
// expressible drop was one in 256: too common for a best-in-world thing, and
// there was no way to say "one in a thousand" at all. Widened to 65536 (v0.64)
// so rarity has room. Rates given out of 256 are scaled by DROP_DEN/256.
const DROP_DEN = 65536;
function countedSuccess(n, q, den = 256) {
  return Math.floor((n * q) / den) > Math.floor(((n - 1) * q) / den);
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

// The canonical generator registry (rev7 §8): a founding record names its
// generator EXPLICITLY, so two deterministic generators can never be
// confused about which world a genesis founds.
const WORLD_GENERATORS = new Set(['interval-classic-v1', 'interval-expanse-v1']);

function makeGenesis(genesisSeed, rulesHash, anchorMs = 0, worldW = 320, worldH = 200,
                     worldGenerator = 'interval-classic-v1') {
  // the generator is a FOUNDING choice, not a fate: pass
  // 'interval-expanse-v1' here and the new world gets meandering
  // trails, seven settlements, and the great river. An existing world
  // cannot change — the genesis IS its identity — but the next one can.
  if (!WORLD_GENERATORS.has(worldGenerator))
    throw new Error('unknown worldGenerator: ' + worldGenerator)
  // rev7 §7: defaults are the CANONICAL world dimensions — the old 14x8
  // default predated the classic generator and misled (it is below the
  // generator's floor). Every field defaulted: a genesis with an
  // undefined member is not canonically encodable (see canonical()).
  return { specVersion: SPEC_VERSION, rulesHash, genesisSeed, anchorMs, worldW, worldH,
           worldGenerator,
           // exploration (v0.50): calibrated for THIS world's geometry by its own
           // survey-sim — NOT a universal curve. A larger world founds its own.
           survey: { k: 8, base: 40, perTile: 10, max: 1800 },
           // brewing (v0.51): a profession rate-limited by fermentation; constants
           // are THIS world's, in the founding record — a larger world tunes its own.
           brew: { ferment: 4500, potCap: 4, xpPerBatch: 13500, buildLogs: 4, buildOre: 2, decayTicks: 432000 },
           // watchfires (v0.53): high-tier Firemaking as public infrastructure.
           watch: { level: 60, kindleLogs: 10, perLog: 300, cap: 6000, xpPerLog: 200, burnXp: 1, maxOwned: 2, decayTicks: 432000 } };
}

// Fix brief §2.1: the world identifier is the hash of the COMPLETE
// canonical genesis — seed, anchor, dimensions, imports, everything
// consensus-relevant. A constitution prefix identifies rules; this
// identifies one exact founded world. Never truncated for protocol use;
// a short prefix is display-only.
function worldId(genesis) {
  return sha256(Buffer.from(canonical(genesis))).toString('hex');
}

// ---------- identity persistence: your key IS your character ----------

function exportIdentity(identity) {
  return { playerId: identity.playerId, privateKey: hex(identity.privateKey) };
}

function importIdentity(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not an identity object');
  if (typeof obj.playerId !== 'string' || !/^[0-9a-f]{64}$/.test(obj.playerId)) throw new Error('malformed playerId');
  if (typeof obj.privateKey !== 'string' || !/^[0-9a-f]+$/.test(obj.privateKey)) throw new Error('malformed privateKey');
  const privateKey = Buffer.from(obj.privateKey, 'hex');
  const id = { playerId: obj.playerId, privateKey };
  // a 32-byte secret must actually produce the claimed public key
  if (privateKey.length === 32 && (ensureEdHash(), hex(ed.getPublicKey(privateKey))) !== obj.playerId)
    throw new Error('private key does not match playerId');
  return id;
}

function loadOrCreateIdentity(fs, file) {
  // rev6 §8: three cases, never blurred. MISSING → create. A SUPPORTED
  // legacy format → migrate (preserved aside). CORRUPT → refuse startup:
  // silently regenerating a key silently loses the identity it named —
  // for a witness key, that is losing a founding role forever.
  if (fs.existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file)) } catch (e) {
      engineThrow(ENGINE_ERR.CORRUPT_IDENTITY, `identity file ${file} is corrupt (${e.message}) — refusing to regenerate over it; restore it from backup or remove it EXPLICITLY to mint a new identity`);
    }
    let id;
    try { id = importIdentity(parsed) } catch (e) {
      engineThrow(ENGINE_ERR.CORRUPT_IDENTITY, `identity file ${file} is not a usable identity (${e.message}) — refusing to regenerate over it; restore or remove it explicitly`);
    }
    if (id.privateKey.length === 32) return id; // raw ed25519 secret
    // pre-noble pkcs8 format: a SUPPORTED migration — preserve and re-mint
    fs.renameSync(file, file + '.old-format');
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
    markers: [],
  };
}

function sameWorld(a, b) {
  return canonical(a.genesis) === canonical(b.genesis);
}

// ---------- state validation (final-fixes brief, Priority 1/4) ----------
// A checkpoint is untrusted bytes until proven otherwise. Two layers:
// consensus-critical structures (coordinates, hp, skills, inventory, bank,
// equipment, ground, mobs, nodes, names, genesis) are validated strictly,
// field by field, against the shapes the engine actually writes; every
// remaining gameplay field passes a bounded-value walk (safe integers,
// short strings, shallow objects) so no field — present or future — can
// smuggle in NaN, giant blobs, or unencodable types. Returns error|null.
const MAX_ENTITIES = 100000;
const MAX_XP = 1e12;
const MAX_QTY = 1e12;
const MAX_TIME = 1e15;             // ticks/ms fields
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const CHART_PREFIX = 'chart:';
const isChart = (v) => typeof v === 'string' && /^chart:[a-z0-9_-]{1,64}$/i.test(v); // a portable waystone attunement
const isItemName = (v) => typeof v === 'string' && (ITEMS.has(v) || isChart(v)); // membership, not just shape (rev5 §4)
const isSlot = (s) => s === null || (s && typeof s === 'object'
  && isItemName(s.item) && isInt(s.qty, 1, MAX_QTY));

// generic sanity for gameplay fields not strictly enumerated:
// bounded numbers, bounded strings, shallow bounded containers
function boundedValue(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && Math.abs(v) <= MAX_TIME ? null : 'unbounded number';
  if (typeof v === 'string') return v.length <= 256 ? null : 'oversized string';
  if (depth >= 6) return 'over-deep value';
  if (Array.isArray(v)) {
    if (v.length > 4096) return 'oversized array';
    for (const x of v) { const e = boundedValue(x, depth + 1); if (e) return e; }
    return null;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length > 256) return 'oversized object';
    for (const k of keys) {
      if (k.length > 64) return 'oversized key';
      const e = boundedValue(v[k], depth + 1); if (e) return e;
    }
    return null;
  }
  return 'unsupported type';
}

// Genesis validated independently (brief §9): it is consensus identity.
const GENESIS_REQUIRED = ['specVersion', 'rulesHash', 'genesisSeed', 'anchorMs', 'worldGenerator', 'worldW', 'worldH'];
const GENESIS_OPTIONAL = new Set(['witnesses', 'quorum', 'byzantineTolerance', 'imported', 'importedFrom', 'survey', 'brew', 'watch', 'geo']);

// Does THIS implementation support the named generator? (pre-freeze §9:
// a separate question from structural validity — the seam matters once
// alternate deterministic generators exist.)
function supportsWorldGenerator(name) { return WORLD_GENERATORS.has(name); }

// The constitutional quorum mathematics (Byzantine Safety Upgrade), in one
// place. Given a witness count n and a Byzantine threshold f, the minimum
// safe quorum is 2f+1, and n must be at least 3f+1. `maxByzantine(n)` is the
// largest f a set of n witnesses can tolerate: floor((n-1)/3).
// The minimum Byzantine-safe quorum for n witnesses tolerating f faults.
// Two constraints bind: q >= 2f+1 (a quorum must outnumber the Byzantine
// witnesses it might contain by a majority), AND 2q-n > f, i.e.
// q > (n+f)/2 (any two quorums intersect in > f witnesses). The second
// dominates once n > 3f+1, so 2f+1 alone is unsafe for non-minimal witness
// sets — take the max of both floors.
function minQuorumFor(n, f) {
  return Math.max(2 * f + 1, Math.floor((n + f) / 2) + 1);
}
function maxByzantine(n) { return Math.floor((n - 1) / 3); }
function byzantineSafe(n, q, f) {
  return Number.isInteger(n) && Number.isInteger(q) && Number.isInteger(f)
    && f >= 0 && q >= 1 && q <= n && n >= 3 * f + 1 && q >= 2 * f + 1 && (2 * q - n) > f;
}

function validateGenesis(g) {
  if (!g || typeof g !== 'object') return 'genesis not an object';
  // pre-freeze §7: an EXACT schema — a key execution ignores still changes
  // the worldId, minting a distinct founding identity with identical
  // behavior. One founding record, one representation.
  for (const k of GENESIS_REQUIRED) if (!(k in g)) return `genesis missing ${k}`;
  for (const k of Object.keys(g)) if (!GENESIS_REQUIRED.includes(k) && !GENESIS_OPTIONAL.has(k)) return `unknown genesis field ${k}`;
  if (g.survey !== undefined) {
    const sv = g.survey;
    if (!sv || typeof sv !== 'object' || Object.keys(sv).sort().join(',') !== 'base,k,max,perTile') return 'non-constitutional genesis.survey';
    for (const sk of ['k', 'base', 'perTile', 'max']) if (!isInt(sv[sk], 0, 1e9)) return `genesis.survey.${sk} out of bounds`;
  }
  if (g.brew !== undefined) {
    const bw = g.brew;
    if (!bw || typeof bw !== 'object' || Object.keys(bw).sort().join(',') !== 'buildLogs,buildOre,decayTicks,ferment,potCap,xpPerBatch') return 'non-constitutional genesis.brew';
    for (const bk of ['ferment', 'potCap', 'xpPerBatch', 'buildLogs', 'buildOre', 'decayTicks']) if (!isInt(bw[bk], 0, 1e12)) return `genesis.brew.${bk} out of bounds`;
  }
  if (g.geo !== undefined) {
    const ge = g.geo;
    if (!ge || typeof ge !== 'object') return 'non-constitutional genesis.geo';
    for (const gk of Object.keys(ge)) if (!['city', 'wilds', 'norwick'].includes(gk)) return `unknown genesis.geo region ${gk}`;
    for (const gk of Object.keys(ge)) {
      const r = ge[gk];
      if (!r || typeof r !== 'object' || Object.keys(r).sort().join(',') !== 'x0,x1,y0,y1') return `non-constitutional genesis.geo.${gk}`;
      if (!isInt(r.x0, 0, g.worldW - 1) || !isInt(r.x1, 0, g.worldW - 1) || !isInt(r.y0, 0, g.worldH - 1) || !isInt(r.y1, 0, g.worldH - 1))
        return `genesis.geo.${gk} out of bounds`;
      if (r.x1 < r.x0 || r.y1 < r.y0) return `genesis.geo.${gk} is inside out`;
    }
  }
  if (g.watch !== undefined) {
    const wt = g.watch;
    if (!wt || typeof wt !== 'object' || Object.keys(wt).sort().join(',') !== 'burnXp,cap,decayTicks,kindleLogs,level,maxOwned,perLog,xpPerLog') return 'non-constitutional genesis.watch';
    for (const wk of ['level', 'kindleLogs', 'perLog', 'cap', 'xpPerLog', 'burnXp', 'maxOwned', 'decayTicks']) if (!isInt(wt[wk], 0, 1e12)) return `genesis.watch.${wk} out of bounds`;
  }
  // pre-freeze §8 + Byzantine upgrade: the witnessed-world triple —
  // witnesses, quorum, byzantineTolerance — comes together or not at all.
  const witnessedKeys = ['witnesses', 'quorum', 'byzantineTolerance'].filter(k => k in g);
  if (witnessedKeys.length !== 0 && witnessedKeys.length !== 3)
    return 'witnesses, quorum, and byzantineTolerance must be supplied together';
  if (typeof g.specVersion !== 'string' || g.specVersion.length > 16) return 'bad specVersion';
  if (typeof g.rulesHash !== 'string' || !HEX64.test(g.rulesHash)) return 'bad rulesHash';
  if (typeof g.genesisSeed !== 'string' || g.genesisSeed.length < 1 || g.genesisSeed.length > 128) return 'bad genesisSeed';
  if (!isInt(g.anchorMs, 0, MAX_TIME)) return 'bad anchorMs';
  if (typeof g.worldGenerator !== 'string' || g.worldGenerator.length > 64) return 'malformed world generator';
  if (!supportsWorldGenerator(g.worldGenerator)) return 'unknown world generator';
  if (!isInt(g.worldW, 1, 100000) || !isInt(g.worldH, 1, 100000)) return 'bad world dimensions';
  if (g.witnesses !== undefined) {
    if (!Array.isArray(g.witnesses) || g.witnesses.length < 1 || g.witnesses.length > 1024) return 'bad witness set';
    const seen = new Set();
    for (const w of g.witnesses) {
      if (typeof w !== 'string' || !HEX64.test(w)) return 'malformed witness key';
      if (seen.has(w)) return 'duplicate witness';
      seen.add(w);
    }
    const n = g.witnesses.length;
    const q = g.quorum;
    const f = g.byzantineTolerance;
    // Byzantine Safety Upgrade: 2q > n only guarantees quorums INTERSECT;
    // the intersection can be a single witness, and if that witness is
    // Byzantine and double-signs, conflicting certificates are possible.
    // The constitutional fault model fixes an explicit threshold f and
    // requires n >= 3f+1 AND q >= 2f+1. Then any two quorums intersect in
    //   |A| + |B| - n >= q + q - n = 2q - n >= (2(2f+1)) - (3f+1) ... 
    // more directly: 2q - n >= 2(2f+1) - n, and with n <= ... we require
    // 2q - n > f, so every intersection holds >= f+1 witnesses; since at
    // most f are Byzantine, at least one is honest. Combined with permanent
    // vote locks, conflicting certificates become impossible in-model.
    if (!Number.isInteger(f) || f < 0) return 'byzantineTolerance must be a nonnegative integer';
    if (!Number.isInteger(q) || q < 1 || q > n) return 'quorum out of range';
    if (n < 3 * f + 1) return `Byzantine-unsafe: need n >= 3f+1 (n=${n}, f=${f} requires n >= ${3 * f + 1})`;
    if (q < 2 * f + 1) return `Byzantine-unsafe: need q >= 2f+1 (q=${q}, f=${f} requires q >= ${2 * f + 1})`;
    if (2 * q - n <= f) return `Byzantine-unsafe: need 2q-n > f (2q-n=${2 * q - n}, f=${f})`;
  }
  if (g.importedFrom !== undefined) {
    // provenance for the import list: WHICH world, at WHICH attested
    // state, these citizens were carried from. The worldId commits to
    // it, so a founder cannot later claim a different source; anyone
    // holding the named world's certified state can recompute the
    // lived-citizen list and check it matches. An import WITHOUT this
    // field is unattested by construction — the founder's bare word —
    // and wears that openly.
    const f = g.importedFrom;
    if (!f || typeof f !== 'object' || Object.keys(f).sort().join(',') !== 'stateHash,tick,worldId')
      return 'non-constitutional genesis.importedFrom';
    if (!/^[0-9a-f]{64}$/.test(f.worldId) || !/^[0-9a-f]{64}$/.test(f.stateHash)) return 'malformed importedFrom hashes';
    if (!isInt(f.tick, 0, MAX_TIME)) return 'importedFrom tick out of bounds';
    if (g.imported === undefined) return 'importedFrom without imported';
  }
  if (g.imported !== undefined) {
    const e = validateImports(g.imported);
    if (e) return e;
  }
  return null;
}

// Imported citizens are FOUNDING data: they enter the world before any
// input is ever validated, so they get a dedicated, complete validator
// (rev6 §2) — IDs, names, skills, XP, HP, inventory, bank, equipment,
// quantities, item vocabulary, and cross-entry uniqueness.
const IMPORT_FIELDS = new Set(['pid', 'skills', 'name', 'hp', 'bank', 'inventory', 'weapon']);
function validateImports(imported) {
  if (!Array.isArray(imported) || imported.length > MAX_ENTITIES) return 'bad imports';
  const pids = new Set(), names = new Set();
  for (const imp of imported) {
    if (!imp || typeof imp !== 'object') return 'malformed import';
    for (const k of Object.keys(imp)) if (!IMPORT_FIELDS.has(k)) return `import carries unknown field ${k}`;
    if (typeof imp.pid !== 'string' || !HEX64.test(imp.pid)) return 'import carries a malformed player id';
    if (pids.has(imp.pid)) return 'duplicate imported player id';
    pids.add(imp.pid);
    if (imp.name != null) {
      if (!isValidName(imp.name)) return 'import carries a non-constitutional name';
      if (names.has(imp.name)) return 'duplicate imported name';
      names.add(imp.name);
    }
    if (imp.hp !== undefined && !isInt(imp.hp, 0, 100000)) return 'import hp out of bounds';
    if (imp.skills !== undefined) {
      if (!imp.skills || typeof imp.skills !== 'object') return 'malformed imported skills';
      for (const [sk, xp] of Object.entries(imp.skills)) {
        if (!SKILLS.includes(sk)) return 'import carries an unknown skill';
        if (!isInt(xp, 0, MAX_XP)) return 'import xp out of bounds';
      }
    }
    if (imp.inventory !== undefined) {
      if (!Array.isArray(imp.inventory) || imp.inventory.length > INV_SLOTS) return 'malformed imported inventory';
      for (const sl of imp.inventory) if (!isSlot(sl)) return 'malformed imported inventory slot';
    }
    if (imp.bank !== undefined) {
      if (!imp.bank || typeof imp.bank !== 'object') return 'malformed imported bank';
      if (Object.keys(imp.bank).length > 512) return 'imported bank exceeds bounds';
      for (const [it, q] of Object.entries(imp.bank)) {
        if (!ITEMS.has(it)) return 'import carries an unknown item';
        if (!isInt(q, 1, MAX_QTY)) return 'import quantity out of bounds'; // sparse banks (rev7 §5)
      }
    }
    if (imp.weapon !== undefined && imp.weapon !== null) {
      if (!isSlot(imp.weapon)) return 'malformed imported weapon';
      if (!EQUIPPABLE.has(imp.weapon.item)) return 'imported weapon is not equippable';
      if (slotOf(imp.weapon.item) !== 'weapon') return 'imported weapon belongs in a different slot';
    }
  }
  return null;
}

function validateState(state) {
  if (!state || typeof state !== 'object') return 'not an object';
  const gerr = validateGenesis(state.genesis);
  if (gerr) return gerr;
  const W = state.genesis.worldW, H = state.genesis.worldH;
  if (!isInt(state.tick, 0, Number.MAX_SAFE_INTEGER)) return 'bad tick';
  let totalEntities = 0;
  for (const key of ['players', 'nodes', 'mobs', 'ground', 'names']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) return `bad ${key} table`;
    const n = Object.keys(state[key]).length;
    if (n > MAX_ENTITIES) return `${key} count exceeds bounds`;
    totalEntities += n;
  }
  if (totalEntities > MAX_ENTITIES) return 'aggregate entity count exceeds bounds'; // rev5 §8

  // ---- constitutional tables (final brief §7): the validator accepts
  // exactly what THIS engine writes — nothing missing, nothing extra ----
  const SKILL_SET = SKILLS;                 // shared constitutional tables
  const NODE_TYPE_SET = new Set(NODE_TYPES); // (rev4 §11): defined ONCE, above
  const PLAYER_REQUIRED = ['x', 'y', 'skills', 'hp', 'equipment', 'bank', 'lastInput', 'gold', 'inventory', 'action', 'name', 'trade'];
  const PLAYER_OPTIONAL = new Set(['attuned', 'brandedUntil', 'cooksTried', 'deadUntil', 'lightsTried', 'rootedUntil', 'rootImmuneUntil', 'rootCdUntil', 'slain', 'lastSwing', 'lastAte']);
  const isId = (v) => typeof v === 'string' && /^[a-z0-9_-]{1,64}$/i.test(v);

  // Relational rule (rev5 §5), decided explicitly: NO stale references are
  // constitutionally permitted. Mobs and players are permanent entries and
  // gather targets/waystones never expire (only fires do, and nothing holds
  // a persistent reference to a fire), so every reference must resolve.
  const validAction = (a, s2) => {
    if (a === null) return null;
    if (!a || typeof a !== 'object') return 'malformed action';
    const keys = Object.keys(a).sort();
    if (a.type === 'gather') {
      if (keys.join(',') !== 'nodeId,type' || !isId(a.nodeId)) return 'malformed gather action';
      if (!s2.nodes[a.nodeId]) return 'gather action references a missing node';
    } else if (a.type === 'attack') {
      if (keys.join(',') !== 'mobId,since,type' || !isId(a.mobId) || !isInt(a.since, 0, MAX_TIME)) return 'malformed attack action';
      if (!s2.mobs[a.mobId]) return 'attack action references a missing mob';
    } else if (a.type === 'attackp') {
      if (keys.join(',') !== 'since,targetId,type' || !HEX64.test(a.targetId ?? '') || !isInt(a.since, 0, MAX_TIME)) return 'malformed attackp action';
      if (!s2.players[a.targetId]) return 'attackp action references a missing player';
    } else return 'unknown action type';
    return null;
  };

  const validTrade = (t, s2) => {
    if (t === null) return null;
    if (!t || typeof t !== 'object') return 'malformed trade';
    if (Object.keys(t).sort().join(',') !== 'giveSlots,to,wantGold,wantItem') return 'malformed trade shape';
    if (typeof t.to !== 'string' || !HEX64.test(t.to)) return 'malformed trade partner';
    if (!s2.players[t.to]) return 'trade references a missing partner';
    // v0.69: a stored offer names one or more slots, ascending and unique, so
    // the same offer is the same bytes on every node
    if (!Array.isArray(t.giveSlots) || t.giveSlots.length === 0 || t.giveSlots.length > INV_SLOTS)
      return 'malformed trade slots';
    for (let i = 0; i < t.giveSlots.length; i++) {
      if (!isInt(t.giveSlots[i], 0, INV_SLOTS - 1)) return 'malformed trade slot';
      if (i > 0 && t.giveSlots[i] <= t.giveSlots[i - 1]) return 'trade slots must be ascending and unique';
    }
    if (t.wantItem !== null && !isItemName(t.wantItem)) return 'malformed trade item';
    if (!isInt(t.wantGold, 0, MAX_QTY)) return 'malformed trade gold';
    // rev7 §1: the SAME XOR invariant as validInput — a persisted trade
    // wants exactly one of an item or positive gold
    if ((t.wantItem !== null) === (t.wantGold > 0)) return 'trade must want exactly one of item or gold';
    return null;
  };

  for (const [pid, p] of Object.entries(state.players)) {
    if (!HEX64.test(pid)) return 'malformed player id';
    if (!p || typeof p !== 'object') return 'malformed player';
    for (const req of PLAYER_REQUIRED) if (!(req in p)) return `player missing ${req}`;
    for (const k of Object.keys(p))
      if (!PLAYER_REQUIRED.includes(k) && !PLAYER_OPTIONAL.has(k)) return `unknown player field ${k}`;
    if (!isInt(p.x, 0, W - 1) || !isInt(p.y, 0, H - 1)) return 'player out of bounds';
    if (!isInt(p.hp, 0, 100000)) return 'player hp out of bounds';
    // skills: the COMPLETE constitutional set, exactly — a missing skill is
    // as hostile as an unknown one (both change transition behavior)
    if (!p.skills || typeof p.skills !== 'object') return 'player has no skills';
    const skeys = Object.keys(p.skills).sort();
    if (skeys.join(',') !== [...SKILL_SET].sort().join(','))
      return skeys.length < SKILL_SET.length ? 'missing skill' : 'unknown or duplicated skill';
    for (const sk of SKILL_SET) if (!isInt(p.skills[sk], 0, MAX_XP)) return 'xp out of bounds';
    // inventory: the exact constitutional slot count (28), always
    if (!Array.isArray(p.inventory) || p.inventory.length !== INV_SLOTS) return 'inventory length is not constitutional';
    for (const sl of p.inventory) if (!isSlot(sl)) return 'malformed inventory slot';
    if (!p.bank || typeof p.bank !== 'object') return 'malformed bank';
    if (Object.keys(p.bank).length > 512) return 'bank exceeds bounds';
    for (const [it, q] of Object.entries(p.bank)) {
      if (!isItemName(it)) return 'malformed bank item';
      if (!isInt(q, 1, MAX_QTY)) return 'bank quantity out of bounds'; // sparse: zero means the key is gone (rev7 §5)
    }
    // equipment: only the constitutional slots, all present
    if (!p.equipment || typeof p.equipment !== 'object') return 'malformed equipment';
    if (Object.keys(p.equipment).sort().join(',') !== [...EQUIP_SLOTS].sort().join(',')) return 'non-constitutional equipment slots';
    for (const eq of EQUIP_SLOTS) {
      const worn = p.equipment[eq];
      if (!isSlot(worn)) return 'malformed equipment slot';
      if (worn !== null) {
        // rev7 §2: the SHARED slotOf() decides where an item belongs —
        // a helm in the weapon slot is as malformed as an unknown item
        if (!EQUIPPABLE.has(worn.item)) return 'equipped item is not equippable';
        if (slotOf(worn.item) !== eq) return `equipped item in the wrong slot (${worn.item} belongs in ${slotOf(worn.item)})`;
      }
    }
    if (p.name !== null && !isValidName(p.name)) return 'non-constitutional player name';
    if (!isInt(p.gold, 0, MAX_QTY)) return 'gold out of bounds';
    if (!isInt(p.lastInput, 0, MAX_TIME)) return 'lastInput out of bounds';
    const aerr = validAction(p.action, state); if (aerr) return aerr;
    const terr = validTrade(p.trade, state); if (terr) return terr;
    if (p.attuned !== undefined) {
      if (!Array.isArray(p.attuned) || p.attuned.length > 64) return 'malformed attunements';
      for (const w of p.attuned) {
        if (!isId(w)) return 'malformed attunement';
        if (state.nodes[w]?.type !== 'waystone') return 'attunement references a missing waystone';
      }
    }
    for (const tk of ['brandedUntil', 'deadUntil', 'rootedUntil', 'rootImmuneUntil', 'rootCdUntil', 'lastSwing', 'lastAte']) if (p[tk] !== undefined && !isInt(p[tk], 0, MAX_TIME)) return `${tk} out of bounds`;
    for (const ck of ['cooksTried', 'lightsTried']) if (p[ck] !== undefined && !isInt(p[ck], 0, MAX_TIME)) return `${ck} out of bounds`;
    if (p.slain !== undefined) { // the loot tally: bounded by the roster, not by time
      if (typeof p.slain !== 'object' || p.slain === null || Array.isArray(p.slain)) return 'malformed slain tally';
      const keys = Object.keys(p.slain);
      if (keys.length > 64) return 'slain tally too large';
      for (const k of keys) if (!isInt(p.slain[k], 0, MAX_TIME)) return `slain.${k} out of bounds`;
    }
  }

  // mobs: constitutional type table, exact field set
  for (const [mid, m] of Object.entries(state.mobs)) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(mid)) return 'malformed mob id';
    if (!m || typeof m !== 'object') return 'malformed mob';
    if (typeof m.type !== 'string' || !(m.type in MOB_STATS)) return 'unknown mob type';
    for (const rk of ['hp', 'hx', 'hy', 'respawnAt', 'type', 'x', 'y']) if (!(rk in m)) return 'mob missing ' + rk;
    for (const mk of Object.keys(m)) if (!['hp', 'hx', 'hy', 'respawnAt', 'type', 'x', 'y', 'rootedUntil', 'rootImmuneUntil'].includes(mk)) return 'non-constitutional mob field ' + mk;
    for (const tk of ['rootedUntil', 'rootImmuneUntil']) if (m[tk] !== undefined && !isInt(m[tk], 0, MAX_TIME)) return 'mob ' + tk + ' out of bounds';
    if (!isInt(m.x, 0, W - 1) || !isInt(m.y, 0, H - 1)) return 'mob out of bounds';
    if (!isInt(m.hx, 0, W - 1) || !isInt(m.hy, 0, H - 1)) return 'mob home out of bounds';
    if (!Number.isSafeInteger(m.hp) || m.hp < -1000 || m.hp > 100000) return 'mob hp out of bounds';
    if (!isInt(m.respawnAt, 0, MAX_TIME)) return 'mob respawn out of bounds';
  }

  // markers: bounded to the world's survey.k, each a well-formed point (v0.50)
  if (state.markers !== undefined) {
    if (!Array.isArray(state.markers)) return 'malformed markers';
    if (state.markers.length > (state.genesis.survey?.k ?? 0) + 2) return 'too many markers';
    for (const m of state.markers) {
      if (!m || typeof m !== 'object') return 'malformed marker';
      if (!isInt(m.x, 0, W - 1) || !isInt(m.y, 0, H - 1)) return 'marker out of bounds';
      if (!MARKER_KINDS.has(m.kind)) return 'bad marker kind';
      if (m.bornAt !== undefined && !isInt(m.bornAt, 0, MAX_TIME)) return 'marker bornAt out of bounds';
      if (m.kind === 'ws' && (typeof m.ws !== 'string' || state.nodes[m.ws]?.type !== 'waystone')) return 'marker names no waystone';
      const allowed = m.kind === 'ws' ? 'bornAt,kind,ws,x,y' : 'bornAt,kind,x,y';
      if (Object.keys(m).sort().join(',') !== allowed) return 'non-constitutional marker fields';
    }
  }

  // nodes: constitutional type table, closed field set
  const NODE_FIELDS = new Set(['type', 'x', 'y', 'depletedUntil', 'expiresAt', 'plantedAt', 'by', 'text', 'readyAt', 'brewKind', 'lastUsed', 'fuelUntil', 'shelf']);
  for (const [nid, n] of Object.entries(state.nodes)) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(nid)) return 'malformed node id';
    if (!n || typeof n !== 'object') return 'malformed node';
    if (typeof n.type !== 'string' || !NODE_TYPE_SET.has(n.type)) return 'unknown node type';
    for (const k of Object.keys(n)) if (!NODE_FIELDS.has(k)) return `unknown node field ${k}`;
    if (n.shelf !== undefined) {
      if (n.type !== 'store') return 'only a store keeps a shelf';
      if (typeof n.shelf !== 'object' || n.shelf === null || Array.isArray(n.shelf)) return 'shelf malformed';
      for (const [it, q] of Object.entries(n.shelf)) {
        if (!ITEMS.has(it)) return `shelf holds a thing that is not an item: ${it}`;
        if (!isInt(q, 1, SHELF_CAP)) return `shelf count out of bounds for ${it}`;
      }
    }
    if (!isInt(n.x, 0, W - 1) || !isInt(n.y, 0, H - 1)) return 'node out of bounds';
    if (!isInt(n.depletedUntil ?? 0, 0, MAX_TIME)) return 'node depletion out of bounds';
    // type-specific rules (rev6 §6): each field belongs to exactly the
    // node kinds the engine gives it to — ownership metadata on a static
    // resource node is as malformed as a fire that never expires
    if (n.expiresAt !== undefined) {
      if (n.type !== 'fire') return 'only fires expire';
      if (!isInt(n.expiresAt, 0, MAX_TIME)) return 'node expiry out of bounds';
    }
    if (n.type === 'fire' && n.expiresAt === undefined) return 'fire without expiry';
    if (n.type === 'brewpot') { // a brewpot is owned; it may be idle or fermenting (v0.51)
      if (typeof n.by !== 'string' || !HEX64.test(n.by)) return 'brewpot without an owner';
      if (!state.players[n.by]) return 'brewpot owner does not exist';
      if ((n.readyAt !== undefined) !== (n.brewKind !== undefined)) return 'brewpot half-fermenting';
      if (n.readyAt !== undefined && !isInt(n.readyAt, 0, MAX_TIME)) return 'brewpot readyAt out of bounds';
      if (n.brewKind !== undefined && n.brewKind !== 'ale' && n.brewKind !== 'broth') return 'bad brewKind';
      if (n.lastUsed !== undefined && !isInt(n.lastUsed, 0, MAX_TIME)) return 'brewpot lastUsed out of bounds';
      if (n.plantedAt !== undefined) return 'brewpot carries plot metadata';
    } else if (n.type === 'watchfire') { // owned public light, fed by logs (v0.53)
      if (typeof n.by !== 'string' || !HEX64.test(n.by)) return 'watchfire without a keeper';
      if (!state.players[n.by]) return 'watchfire keeper does not exist';
      if (!isInt(n.fuelUntil ?? 0, 0, MAX_TIME)) return 'watchfire fuelUntil out of bounds';
      if (n.plantedAt !== undefined || n.readyAt !== undefined || n.brewKind !== undefined) return 'watchfire carries foreign metadata';
    } else if (n.fuelUntil !== undefined) {
      return 'fuel on a non-watchfire node';
    } else if (n.readyAt !== undefined || n.brewKind !== undefined) {
      return 'brew metadata on a non-brewpot node';
    } else if (n.plantedAt !== undefined || n.by !== undefined) {
      if (n.type !== 'plot') return 'ownership metadata on a non-plot node';
      if (n.plantedAt !== undefined && !isInt(n.plantedAt, 0, MAX_TIME)) return 'node planting out of bounds';
      if (n.plantedAt > 0) {
        if (typeof n.by !== 'string' || !HEX64.test(n.by)) return 'planted plot without an owner';
        if (!state.players[n.by]) return 'plot owner does not exist';
      } else if (n.by !== undefined) return 'unplanted plot carries an owner';
    }
    if (n.text !== undefined) {
      if (n.type !== 'signpost') return 'text on a non-signpost node';
      if (typeof n.text !== 'string' || n.text.length > 256) return 'malformed node text';
    }
  }

  // ground entries: OBJECTS with a closed field set — { item, qty?, x, y,
  // expiresAt }; qty is absent on mob drops
  for (const [gid, g] of Object.entries(state.ground)) {
    if (typeof gid !== 'string' || gid.length > 80) return 'malformed ground id';
    if (!g || typeof g !== 'object' || Array.isArray(g)) return 'malformed ground entry';
    for (const k of Object.keys(g)) if (!['item', 'qty', 'x', 'y', 'expiresAt'].includes(k)) return `unknown ground field ${k}`;
    if (!isItemName(g.item)) return 'malformed ground item';
    if (g.qty !== undefined && !isInt(g.qty, 1, MAX_QTY)) return 'ground quantity out of bounds';
    if (!isInt(g.x, 0, W - 1) || !isInt(g.y, 0, H - 1)) return 'ground item out of bounds';
    if (!isInt(g.expiresAt, 0, MAX_TIME)) return 'ground expiry out of bounds';
  }

  // names: validated in BOTH directions (brief §9) — every registry entry
  // points at a player wearing that exact name, and every named player is
  // registered under it
  for (const [name, pid] of Object.entries(state.names)) {
    if (!isValidName(name)) return 'non-constitutional registered name';
    if (typeof pid !== 'string' || !HEX64.test(pid)) return 'name registry points at malformed id';
    const p = state.players[pid];
    if (!p) return 'name registered to a player that does not exist';
    if (p.name !== name) return 'name registry disagrees with player';
  }
  for (const [pid, p] of Object.entries(state.players)) {
    if (p.name != null && state.names[p.name] !== pid) return 'named player missing from registry';
  }

  let enc;
  try { enc = canonical(state) } catch (e) { return 'not canonically encodable: ' + e.message }
  if (enc.length > MAX_STATE_BYTES) return 'serialized state exceeds bounds';
  return null;
}

function addPlayer(state, playerId, x, y) {
  state.players[playerId] = {
    x, y,
    skills: Object.fromEntries(SKILLS.map(sk => [sk, sk === 'hitpoints' ? HP_START_XP : 0])),
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

function addNode(state, nodeId, type, x, y, extra) {
  state.nodes[nodeId] = { type, x, y, depletedUntil: 0, ...(extra || {}) };
}

function firstFreeSlot(inv) {
  for (let i = 0; i < inv.length; i++) if (inv[i] === null) return i;
  return -1;
}

// ---------- shared inventory helpers (fix brief 7.5) ----------
// One vocabulary for every stack mutation. All deterministic; all mutate
// only through explicit calls. STACKABLE names the items that pool.
const STACKABLE = new Set(['arrows', 'grain', 'seeds', 'ale', 'broth']);

function countItem(inv, item) {
  let n = 0;
  for (const sl of inv) if (sl?.item === item) n += sl.qty ?? 1;
  return n;
}

// Can this trade land whole? Counts the room the ACCEPTOR will have at the
// moment of the swap: the slot their own payment leaves behind is free by
// then, and a stackable item needs no slot at all if they already hold some.
// A trade that cannot land whole must not begin (§5c).
function tradeFits(offerer, acceptor, trade) {
  const slots = Array.isArray(trade.giveSlots) ? trade.giveSlots : [];
  if (!slots.length) return false;
  const incoming = [];
  for (const sl of slots) {
    const it = offerer.inventory[sl];
    if (!it) return false;                 // the offer no longer holds
    incoming.push(it);
  }
  // a copy of what the acceptor's pack looks like once their payment leaves
  const inv = acceptor.inventory.slice();
  if (!trade.wantGold) {
    const j = inv.findIndex(sl => sl && sl.item === trade.wantItem);
    if (j === -1) return false;
    inv[j] = null;                          // their payment is on its way out
  }
  let free = 0;
  for (const sl of inv) if (!sl) free++;
  const held = new Set(inv.filter(Boolean).map(sl => sl.item));
  for (const it of incoming) {
    if (STACKABLE.has(it.item) && held.has(it.item)) continue; // pools, no slot
    if (free === 0) return false;
    free--;
    held.add(it.item);
  }
  return true;
}

function canAddItem(inv, item) {
  if (STACKABLE.has(item) && inv.some(sl => sl?.item === item)) return true;
  return firstFreeSlot(inv) !== -1;
}

// Adds qty of item, merging into an existing stack for stackables.
// Returns true if fully added, false if nothing was added (never partial).
function addItem(inv, item, qty = 1) {
  if (STACKABLE.has(item)) {
    const i = inv.findIndex(sl => sl?.item === item);
    if (i !== -1) { inv[i].qty = (inv[i].qty ?? 1) + qty; return true; }
  }
  const slot = firstFreeSlot(inv);
  if (slot === -1) return false;
  inv[slot] = { item, qty };
  return true;
}

// Removes qty units of `item` across slots (stackable or not). Returns true if it took all qty.
function consumeItem(inv, item, qty) {
  let left = qty;
  for (let i = 0; i < inv.length && left > 0; i++) {
    if (inv[i]?.item === item) { const take = Math.min(left, inv[i].qty ?? 1); removeItem(inv, i, take); left -= take; }
  }
  return left === 0;
}

// Removes qty units from a slot; clears the slot when it empties.
// Returns true if the slot held at least qty units.
function removeItem(inv, slot, qty = 1) {
  const sl = inv[slot];
  if (!sl || (sl.qty ?? 1) < qty) return false;
  if ((sl.qty ?? 1) > qty) sl.qty -= qty;
  else inv[slot] = null;
  return true;
}

const atOrBeside = (p, n) => (p.x === n.x && p.y === n.y) || (Math.abs(p.x - n.x) + Math.abs(p.y - n.y) === 1); // on it, or orthogonally beside
function adjacent(p, n) { // orthogonal (§5): you face what you work
  return Math.abs(p.x - n.x) + Math.abs(p.y - n.y) === 1;
}

// ---------- input validation (spec §5) ----------
// v0.2: the state machine itself verifies signatures. An input with a
// bad or missing signature is invalid regardless of content.

function validInput(state, input, ctx) {
  if (validateInputShape(input) !== null) return false; // one canonical form per action (rev7 §4)
  if (!input || typeof input !== 'object') return false;
  if (input.tick !== state.tick) return false;
  // fix brief §2.3: an input signed for World A is meaningless in World B.
  // The worldId is inside the signed payload, so this check is enforced
  // by the signature itself — forging it invalidates the sig.
  if (input.worldId !== worldId(state.genesis)) return false;
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
      // the water is law where the generator says so (terrain registry):
      // rivers and the sea bar the way, and their fords are law too
      if (terrainBlocked(state.genesis, nx, ny)) return false;
      // nodes are impassable (§5): you fish beside the water, not in it
      return !blockingNodeAt(state, ctx, nx, ny); // brewpots are walkable — no wall-ins (v0.52)
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
      return hasAdjacentNode(state, ctx, p, _FIRE_TYPES);
    }
    case 'stop':
      return true;
    case 'recall': {
      // spec 2k: recall to any waystone you have walked to. Never from the Wilds —
      // magic will not carry you out of danger you chose to enter.
      if (p.hp <= 0 || inWilds(state.genesis, p.x, p.y)) return false;
      const ws = state.nodes[input.to];
      if (!ws || ws.type !== 'waystone') return false;
      return (p.attuned ?? []).includes(input.to);
    }
    case 'claim_name': {
      // spec §5a: lowercase a-z0-9- (no leading/trailing -), 1-12 chars,
      // name unclaimed, claimant nameless, claimant has stood in the world
      const { name } = input;
      if (!isValidName(name)) return false; // ONE shared validator (rev5 §3)
      if (standingOf(p) < NAME_STANDING) return false; // v0.70: a name costs time
      return !(name in state.names) && p.name === null;
    }
    case 'offer_trade': {
      const t = state.players[input.to];
      if (!t || input.to === input.playerId) return false;
      // every named slot must actually hold something. An offer that promises
      // an empty slot is not a smaller offer, it is a malformed one.
      if (!Array.isArray(input.giveSlots) || input.giveSlots.length === 0) return false;
      for (const sl of input.giveSlots) if (!p.inventory[sl]) return false;
      // structural canonicality (both demand fields explicit, item XOR
      // positive gold) already passed the shape gate; this case is purely
      // state-dependent now (pre-freeze §4)
      return true;
    }
    case 'accept_trade': {
      const o = state.players[input.from];
      if (!o || !o.trade || o.trade.to !== input.playerId) return false;
      if (!adjacent(p, o)) return false;
      // a trade is whole or it does not happen (§5c), so the room must be
      // there BEFORE anything moves
      if (!tradeFits(o, p, o.trade)) return false;
      if (o.trade.wantGold) return (p.gold ?? 0) >= o.trade.wantGold;
      return p.inventory.some(s => s && s.item === o.trade.wantItem);
    }
    case 'cancel_trade':
      return p.trade !== null;
    case 'buy': {
      // v0.74: two things are for sale at a store. The keeper's own goods,
      // conjured from nothing (STORE_SELLS), and whatever citizens have sold
      // to THIS store and nobody has yet carried off.
      const st = findAdjacentNode(state, ctx, p, 'store');
      if (!st) return false;
      const onShelf = (st.shelf?.[input.item] ?? 0) > 0;
      if (!(input.item in STORE_SELLS) && !onShelf) return false;
      const price = onShelf && !(input.item in STORE_SELLS) ? storeAsk(input.item)
        : (input.item in STORE_SELLS) ? STORE_SELLS[input.item] : storeAsk(input.item);
      if ((p.gold ?? 0) < price) return false;
      if (!STACKABLE.has(input.item) && firstFreeSlot(p.inventory) === -1) return false;
      if (STACKABLE.has(input.item) && countItem(p.inventory, input.item) === 0
          && firstFreeSlot(p.inventory) === -1) return false;
      return true;
    }
    case 'attack': {
      const m = state.mobs[input.mobId];
      if (!m || m.hp <= 0) return false;
      if (inReach(p, m)) return true;
      // ranged (spec 6j): a drawn bow and a carried arrow reach further
      const cheb = Math.max(Math.abs(p.x - m.x), Math.abs(p.y - m.y));
      return cheb <= reachOf(p) && isRanged(p)
        && p.inventory.some(sl => sl?.item === 'arrows');
    }
    case 'attackp': {
      // 7.1: player state has no playerId field; compare against the input's
      // own id or self-attack slips through as (undefined === target) === false
      const q = state.players[input.targetId];
      if (!q || q.hp <= 0 || input.targetId === input.playerId) return false;
      if (!inWilds(state.genesis, p.x, p.y) || !inWilds(state.genesis, q.x, q.y)) return false;
      if (inReach(p, q)) return true;
      const cheb = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      return cheb <= reachOf(p) && isRanged(p)
        && p.inventory.some(sl => sl?.item === 'arrows');
    }
    case 'plant': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || sl?.item !== 'seeds') return false;
      return hasAdjacentNode(state, ctx, p, 'plot', n => !n.plantedAt);
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
      return hasAdjacentNode(state, ctx, p, 'store');
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
    case 'survey': { // stand on a marker to survey it (v0.50)
      if (p.hp <= 0) return false;
      return (state.markers ?? []).some(m => m.x === p.x && m.y === p.y);
    }
    case 'read_chart': {
      const sl = p.inventory[input.slot];
      return !!sl && isChart(sl.item);
    }
    case 'build_brewpot': {
      if (p.hp <= 0 || !state.genesis.brew) return false;
      const bc = state.genesis.brew;
      if (nodeExistsAt(state, ctx, p.x, p.y)) return false;
      if (!hasAdjacentNode(state, ctx, p, 'house')) return false;
      if (brewpotsOwnedBy(state, ctx, input.playerId) >= bc.potCap) return false;
      return countItem(p.inventory, 'logs') >= bc.buildLogs && countItem(p.inventory, 'ore') >= bc.buildOre;
    }
    case 'brew': {
      const bp = state.nodes[input.nodeId];
      if (!bp || bp.type !== 'brewpot' || bp.by !== input.playerId || bp.readyAt !== undefined || !atOrBeside(p, bp)) return false;
      const sl = p.inventory[input.slot];
      return !!sl && (sl.item === 'grain' || sl.item === 'raw-fish');
    }
    case 'collect': {
      const bp = state.nodes[input.nodeId];
      if (!bp || bp.type !== 'brewpot' || bp.by !== input.playerId || !atOrBeside(p, bp)) return false;
      return bp.readyAt !== undefined && state.tick >= bp.readyAt && canAddItem(p.inventory, bp.brewKind);
    }
    case 'dismantle': {
      const bp = state.nodes[input.nodeId];
      return !!bp && bp.type === 'brewpot' && bp.by === input.playerId && atOrBeside(p, bp);
    }
    case 'kindle': { // raise a great fire: high-tier Firemaking (v0.53)
      const wt = state.genesis.watch;
      if (!wt || p.hp <= 0) return false;
      if (effLevel(p.skills.firemaking) < wt.level) return false;
      if (countItem(p.inventory, 'logs') < wt.kindleLogs) return false;
      if (nodeExistsAt(state, ctx, p.x, p.y)) return false;
      return countOwnedNodes(state, ctx, 'watchfire', input.playerId) < wt.maxOwned;
    }
    case 'stoke': { // anyone may feed anyone's fire: the light is common
      const wf = state.nodes[input.nodeId];
      if (!wf || wf.type !== 'watchfire' || !atOrBeside(p, wf) || !state.genesis.watch) return false;
      const sl = p.inventory[input.slot];
      return !!sl && sl.item === 'logs' && (wf.fuelUntil ?? 0) < state.tick + state.genesis.watch.cap;
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
      if (!hasAdjacentNode(state, ctx, p, 'anvil')) return false;
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
      return !nodeExistsAt(state, ctx, p.x, p.y);
    }
    case 'bury': {
      const sl = p.inventory[input.slot];
      return Number.isInteger(input.slot) && !!sl && sl.item === 'bones';
    }
    case 'deposit': {
      if (!Number.isInteger(input.slot) || !p.inventory[input.slot]) return false;
      return hasAdjacentNode(state, ctx, p, 'bank');
    }
    case 'withdraw': {
      if (typeof input.item !== 'string' || !(p.bank[input.item] > 0)) return false;
      if (firstFreeSlot(p.inventory) === -1) return false;
      return hasAdjacentNode(state, ctx, p, 'bank');
    }
    case 'drop': {
      return Number.isInteger(input.slot) && !!p.inventory[input.slot];
    }
    case 'pickup': {
      const g2 = state.ground[input.groundId];
      if (!g2 || g2.x !== p.x || g2.y !== p.y) return false;
      // 7.4: execution merges arrows into an existing quiver, so validation
      // must accept that path too — a full pack still has room in the quiver
      if (g2.item === 'arrows' && p.inventory.some(sl => sl?.item === 'arrows')) return true;
      return firstFreeSlot(p.inventory) !== -1;
    }
    case 'eat': {
      const slot = p.inventory[input.slot];
      if (state.tick - (p.lastAte ?? -EAT_EVERY) < EAT_EVERY) return false; // §6m: the gullet has a rhythm
      return Number.isInteger(input.slot) && !!slot && ['cooked-fish', 'ale', 'broth'].includes(slot.item);
    }
    default:
      return false;
  }
}

// ---------- Phase 2: cheap deterministic clone + derived tick indexes ----------
// (perf brief, Phase 2B/2C). Everything in this block is an IMPLEMENTATION
// DETAIL: process-local, absent from canonical state, checkpoints, and
// hashes, and rebuilt from canonical state whenever needed. The unindexed
// scan remains the reference behavior (every helper below falls back to it
// when no context is supplied — the test-only reference mode).

// -- instrumentation (non-consensus; off unless a benchmark enables it) --
let _p2on = false;
const _p2c = { fullNodeScans: 0, fullPlayerScans: 0, fullMobScans: 0, fullGroundScans: 0,
  posLookups: 0, typeLookups: 0, adjLookups: 0, indexBuilds: 0, indexUpdates: 0 };
let _p2sections = {}; let _p2cur = null; let _p2t0 = 0n;
function _p2mark(name) {
  if (!_p2on) return;
  const now = process.hrtime.bigint();
  if (_p2cur) _p2sections[_p2cur] = (_p2sections[_p2cur] || 0) + Number(now - _p2t0) / 1e6;
  _p2cur = name; _p2t0 = now;
}

// -- Phase 2B: protocol-aware state clone --
// Domain: canonically encodable states (canonical() rejects undefined,
// NaN/Infinity, and non-plain objects, and validateState walks every field),
// so mirroring JSON.parse(JSON.stringify(...)) semantics exactly means:
// objects lose undefined-valued keys, arrays map undefined to null, and
// everything else copies structurally.
function _deepCloneJson(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = v.length, a = new Array(n);
    for (let i = 0; i < n; i++) { const e = v[i]; a[i] = e === undefined ? null : _deepCloneJson(e); }
    return a;
  }
  const o = {};
  for (const k of Object.keys(v)) { const e = v[k]; if (e === undefined) continue; o[k] = _deepCloneJson(e); }
  return o;
}
function _cloneFlat(rec) { // record whose values are scalars (nested handled generically)
  const o = {};
  for (const k of Object.keys(rec)) {
    const e = rec[k];
    if (e === undefined) continue;
    o[k] = (e !== null && typeof e === 'object') ? _deepCloneJson(e) : e;
  }
  return o;
}
function _cloneEntityMap(m) { // nodes / mobs / ground: id -> flat record
  const o = {};
  for (const k of Object.keys(m)) {
    const e = m[k];
    if (e === undefined) continue;
    o[k] = (e !== null && typeof e === 'object' && !Array.isArray(e)) ? _cloneFlat(e) : _deepCloneJson(e);
  }
  return o;
}
function _clonePlayer(p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return _deepCloneJson(p);
  const o = {};
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === undefined) continue;
    switch (k) {
      case 'skills': case 'bank': o[k] = _cloneFlat(v); break;
      case 'inventory': {
        const a = new Array(v.length);
        for (let i = 0; i < v.length; i++) { const sl = v[i]; a[i] = (sl === null || sl === undefined) ? null : _cloneFlat(sl); }
        o[k] = a; break;
      }
      case 'equipment': {
        const e = {};
        for (const g of Object.keys(v)) { const sl = v[g]; if (sl === undefined) continue; e[g] = sl === null ? null : _cloneFlat(sl); }
        o[k] = e; break;
      }
      case 'action': case 'trade': o[k] = v === null ? null : _cloneFlat(v); break;
      default: o[k] = (v !== null && typeof v === 'object') ? _deepCloneJson(v) : v;
    }
  }
  return o;
}
function cloneStateForTick(state) {
  const out = {};
  for (const k of Object.keys(state)) {
    const v = state[k];
    if (v === undefined) continue;
    switch (k) {
      case 'genesis':
        // immutable-and-safe-to-share: the founding record is never written
        // after construction (proven by the frozen-genesis campaign in
        // test/phase2.test.mjs; a mutation would throw there).
        out.genesis = v; break;
      case 'players': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) { out.players = _deepCloneJson(v); break; }
        const o = {};
        for (const id of Object.keys(v)) { const p = v[id]; if (p === undefined) continue; o[id] = _clonePlayer(p); }
        out.players = o; break;
      }
      case 'nodes': case 'mobs': case 'ground':
        out[k] = (v === null || typeof v !== 'object' || Array.isArray(v)) ? _deepCloneJson(v) : _cloneEntityMap(v);
        break;
      case 'names': case 'firsts':
        out[k] = (v === null || typeof v !== 'object' || Array.isArray(v)) ? _deepCloneJson(v) : _cloneFlat(v);
        break;
      default: // tick, beacon, markers, announce, spec fields, unknown fields
        out[k] = (v !== null && typeof v === 'object') ? _deepCloneJson(v) : v;
    }
  }
  return out;
}
let _cloneOverride = null;   // test hook; null = env/default
function _cloneModeName() { return _cloneOverride ?? process.env.INTERVAL_CLONE ?? 'fast'; }
function _cloneForTick(state) {
  const m = _cloneModeName();
  if (m === 'json') return JSON.parse(JSON.stringify(state));
  if (m === 'structured') return structuredClone(state);
  return cloneStateForTick(state);
}

// -- Phase 2C: minimal per-tick node indexes --
// One context per state object per tick. `seq` records the enumeration
// order of s.nodes (string keys: insertion order), so "first matching node
// in Object.values(...)" is reproducible as "matching node with least seq".
let _indexOverride = null;   // test hook; null = env/default
function _indexesOn() { return _indexOverride ?? (process.env.INTERVAL_INDEXES !== 'off'); }
const _tileKey = (x, y) => x + ',' + y;
function buildTickContext(state) {
  if (!_indexesOn()) return null;
  if (_p2on) _p2c.indexBuilds++;
  const byTile = new Map(), byType = new Map(), seq = new Map(), brewBy = new Map();
  let i = 0;
  for (const id of Object.keys(state.nodes)) {
    const n = state.nodes[id];
    seq.set(id, i++);
    const tk = _tileKey(n.x, n.y);
    let ta = byTile.get(tk); if (!ta) byTile.set(tk, ta = []); ta.push(id);
    let ty = byType.get(n.type); if (!ty) byType.set(n.type, ty = []); ty.push(id);
    if (n.type === 'brewpot') brewBy.set(n.by, (brewBy.get(n.by) || 0) + 1);
  }
  return { byTile, byType, seq, brewBy, nextSeq: i };
}
// centralized node mutation (Phase 2C): EVERY node created or deleted inside
// nextState goes through these, so s.nodes and the indexes cannot diverge.
function addIndexedNode(s, ctx, nodeId, node) {
  if (Object.prototype.hasOwnProperty.call(s.nodes, nodeId)) deleteIndexedNode(s, ctx, nodeId);
  s.nodes[nodeId] = node;
  if (!ctx) return;
  if (_p2on) _p2c.indexUpdates++;
  ctx.seq.set(nodeId, ctx.nextSeq++);
  const tk = _tileKey(node.x, node.y);
  let ta = ctx.byTile.get(tk); if (!ta) ctx.byTile.set(tk, ta = []); ta.push(nodeId);
  let ty = ctx.byType.get(node.type); if (!ty) ctx.byType.set(node.type, ty = []); ty.push(nodeId);
  if (node.type === 'brewpot') ctx.brewBy.set(node.by, (ctx.brewBy.get(node.by) || 0) + 1);
}
function deleteIndexedNode(s, ctx, nodeId) {
  const n = s.nodes[nodeId];
  if (n === undefined) return;
  delete s.nodes[nodeId];
  if (!ctx) return;
  if (_p2on) _p2c.indexUpdates++;
  ctx.seq.delete(nodeId);
  const ta = ctx.byTile.get(_tileKey(n.x, n.y));
  if (ta) { const i = ta.indexOf(nodeId); if (i !== -1) ta.splice(i, 1); if (!ta.length) ctx.byTile.delete(_tileKey(n.x, n.y)); }
  const ty = ctx.byType.get(n.type);
  if (ty) { const i = ty.indexOf(nodeId); if (i !== -1) ty.splice(i, 1); if (!ty.length) ctx.byType.delete(n.type); }
  if (n.type === 'brewpot') {
    const c = (ctx.brewBy.get(n.by) || 0) - 1;
    if (c > 0) ctx.brewBy.set(n.by, c); else ctx.brewBy.delete(n.by);
  }
}
// query helpers. Reference behavior (ctx === null) is the exact scan the
// engine ran before Phase 2; the indexed path must return identical answers
// (differentially tested in test/phase2.test.mjs).
function nodeExistsAt(state, ctx, x, y) { // any node occupies the tile
  if (!ctx) { if (_p2on) _p2c.fullNodeScans++; return Object.values(state.nodes).some(n => n.x === x && n.y === y); }
  if (_p2on) _p2c.posLookups++;
  const ta = ctx.byTile.get(_tileKey(x, y));
  return !!ta && ta.length > 0;
}
const _WALKABLE_BUILT = new Set(['brewpot', 'watchfire']); // what citizens build never blocks a door (v0.52, v0.53)
function countOwnedNodes(state, ctx, type, owner) { // how many of `type` this citizen keeps
  if (_p2on) _p2c.fullNodeScans++;
  let n = 0;
  for (const nd of Object.values(state.nodes)) if (nd.type === type && nd.by === owner) n++;
  return n;
}
function blockingNodeAt(state, ctx, x, y) { // movement rule: player-built nodes are walkable
  if (!ctx) { if (_p2on) _p2c.fullNodeScans++; return Object.values(state.nodes).some(n => n.x === x && n.y === y && !_WALKABLE_BUILT.has(n.type)); }
  if (_p2on) _p2c.posLookups++;
  const ta = ctx.byTile.get(_tileKey(x, y));
  if (!ta) return false;
  for (const id of ta) if (!_WALKABLE_BUILT.has(state.nodes[id].type)) return true;
  return false;
}
const _ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // adjacent(): Manhattan distance exactly 1
const _FIRE_TYPES = new Set(['campfire', 'fire']);
function hasAdjacentNode(state, ctx, p, typeOrSet, pred) {
  const match = typeof typeOrSet === 'string' ? (t) => t === typeOrSet : (t) => typeOrSet.has(t);
  if (!ctx) {
    if (_p2on) _p2c.fullNodeScans++;
    return Object.values(state.nodes).some(n => match(n.type) && (!pred || pred(n)) && adjacent(p, n));
  }
  if (_p2on) _p2c.adjLookups++;
  for (const [dx, dy] of _ORTH) {
    const ta = ctx.byTile.get(_tileKey(p.x + dx, p.y + dy));
    if (!ta) continue;
    for (const id of ta) { const n = state.nodes[id]; if (match(n.type) && (!pred || pred(n))) return true; }
  }
  return false;
}
function findAdjacentNode(state, ctx, p, type, pred) {
  // reference: FIRST match in Object.values enumeration order
  if (!ctx) {
    if (_p2on) _p2c.fullNodeScans++;
    return Object.values(state.nodes).find(n => n.type === type && (!pred || pred(n)) && adjacent(p, n));
  }
  if (_p2on) _p2c.adjLookups++;
  let best, bestSeq = Infinity;
  for (const [dx, dy] of _ORTH) {
    const ta = ctx.byTile.get(_tileKey(p.x + dx, p.y + dy));
    if (!ta) continue;
    for (const id of ta) {
      const n = state.nodes[id];
      if (n.type !== type || (pred && !pred(n))) continue;
      const sq = ctx.seq.get(id);
      if (sq < bestSeq) { bestSeq = sq; best = n; }
    }
  }
  return best;
}
function adjacentNodeIdsInOrder(state, ctx, p, type) {
  // reference: every matching node, in Object.entries enumeration order
  if (!ctx) {
    if (_p2on) _p2c.fullNodeScans++;
    const out = [];
    for (const [nid, n] of Object.entries(state.nodes))
      if (n.type === type && Math.abs(n.x - p.x) + Math.abs(n.y - p.y) === 1) out.push(nid);
    return out;
  }
  if (_p2on) _p2c.adjLookups++;
  const found = [];
  for (const [dx, dy] of _ORTH) {
    const ta = ctx.byTile.get(_tileKey(p.x + dx, p.y + dy));
    if (!ta) continue;
    for (const id of ta) if (state.nodes[id].type === type) found.push(id);
  }
  found.sort((a, b) => ctx.seq.get(a) - ctx.seq.get(b));
  return found;
}
function waystoneIdsSorted(state, ctx) {
  // reference: Object.keys(...).filter(waystone).sort() — sorted, so order-safe
  if (!ctx) { if (_p2on) _p2c.fullNodeScans++; return Object.keys(state.nodes).filter(id => state.nodes[id].type === 'waystone').sort(); }
  if (_p2on) _p2c.typeLookups++;
  return [...(ctx.byType.get('waystone') ?? [])].sort();
}
function brewpotsOwnedBy(state, ctx, pid) {
  if (!ctx) { if (_p2on) _p2c.fullNodeScans++; return Object.values(state.nodes).filter(n => n.type === 'brewpot' && n.by === pid).length; }
  if (_p2on) _p2c.typeLookups++;
  return ctx.brewBy.get(pid) || 0;
}

// ---------- the transition function ----------

// ---- exploration (v0.50): survey markers, placed by the beacon ----
const MARKER_LIFE = 3000; // an unclaimed marker relocates after this many ticks
// survey findings (v0.77): a minority of markers are the TRACES of
// those who came before — classed at birth from the same digest that
// placed them, weighted by the country they lie in (the generator
// registered what its countries are; an unregistered one keeps flat,
// modest odds). The class never changes and the finding is the class:
// no randomness survives to the claim.
const MARKER_FINDS = { burial: 'bones', working: 'ore', camp: 'logs', cache: 'seeds' };
const MARKER_KINDS = new Set(['ord', 'ws', 'burial', 'working', 'camp', 'cache']);
function classifyMarker(g, x, y, h) {
  const r = h.readUInt32BE(12) / 0xffffffff;
  const country = TERRAINS[g.worldGenerator]?.country?.(g, x, y) ?? null;
  const wts = country === 'wilds' ? [0.30, 0.08, 0.06, 0.06]        // the dead outnumber the living out west
    : country === 'crags' ? [0.06, 0.30, 0.04, 0.05]                 // old workings in the stone
    : country === 'greenwood' ? [0.06, 0.05, 0.30, 0.05]             // cold camps under the trees
    : country === 'fens' ? [0.18, 0.05, 0.10, 0.06]                  // the marsh keeps what it takes
    : country === 'heartlands' ? [0.05, 0.04, 0.05, 0.04]            // the settled middle is mostly just ground
    : [0.10, 0.08, 0.08, 0.05];
  let acc = 0;
  const kinds = ['burial', 'working', 'camp', 'cache'];
  for (let i = 0; i < 4; i++) { acc += wts[i]; if (r < acc) return kinds[i]; }
  return 'ord';
}
function surveyMarker(s, ctx, index, salt) {
  const g = s.genesis, anchor = spawnOf(g);
  const maxD = Math.max(anchor.x, g.worldW - anchor.x, anchor.y, g.worldH - anchor.y) || 1;
  const occupied = (x, y) => nodeExistsAt(s, ctx, x, y);
  const wsIds = waystoneIdsSorted(s, ctx);
  const rr = sha256(Buffer.from(s.beacon + '|rumor|' + s.tick + '|' + index + '|' + salt)).readUInt32BE(0) / 0xffffffff;
  if (wsIds.length && rr < 0.15) { // a rumor: sits beside a waystone, charts it when surveyed
    const wid = wsIds[Math.min(wsIds.length - 1, Math.floor((rr / 0.15) * wsIds.length))];
    const ws = s.nodes[wid];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = ws.x + dx, y = ws.y + dy;
      if (x >= 1 && y >= 1 && x < g.worldW - 1 && y < g.worldH - 1 && !occupied(x, y) && !inCity(g, x, y))
        return { x, y, kind: 'ws', ws: wid, bornAt: s.tick };
    }
  }
  for (let att = 0; att < 200; att++) { // ordinary: near-biased, avoid city and nodes
    const h = sha256(Buffer.from(s.beacon + '|survey|' + s.tick + '|' + index + '|' + salt + '|' + att));
    const x = 1 + (h.readUInt32BE(0) % (g.worldW - 2)), y = 1 + (h.readUInt32BE(4) % (g.worldH - 2));
    if (inCity(g, x, y) || occupied(x, y)) continue;
    const d = Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y));
    if ((h.readUInt32BE(8) / 0xffffffff) > 1 - 0.6 * (d / maxD)) continue;
    return { x, y, kind: classifyMarker(g, x, y, h), bornAt: s.tick };
  }
  return { x: Math.min(anchor.x + 5, g.worldW - 2), y: anchor.y, kind: 'ord', bornAt: s.tick };
}

// ---- world announcements (v0.48): milestones every citizen sees ----
const TICKS_PER_YEAR = Math.round(365.25 * 24 * 3600 * 1000 / TICK_MS); // world-age, in ticks
const ANNOUNCE_KEEP = 24; // the herald remembers only the last few cries
function announce(s, text) {
  if (!s.announce) s.announce = [];
  s.announce.push({ tick: s.tick, text });
  while (s.announce.length > ANNOUNCE_KEEP) s.announce.shift();
}
function claimFirst(s, key, pid) { // true the first time `key` is ever achieved; records it forever
  if (!s.firsts) s.firsts = {};
  if (s.firsts[key] === undefined) { s.firsts[key] = pid; return true; }
  return false;
}

function nextState(state, inputs, _legacyBeacon) {
  if (_p2on) { _p2sections = {}; _p2cur = null; }
  _p2mark('clone');
  const s = _cloneForTick(state); // pure: never mutate caller's state (Phase 2B)
  _p2mark('index_build');
  // derived, process-local, per-transition (Phase 2C): one context over the
  // pre-state (validInput reads state, which this tick never mutates) and
  // one over the working clone (maintained by the centralized helpers).
  const _ctxPre = buildTickContext(state);
  const _ctx = buildTickContext(s);
  _p2mark('pre_tick');
  s.tick = state.tick + 1;
  // the beacon rides IN the state now (v0.38). A pre-0.38 state migrates
  // itself: seeded once from the old formula, then history takes over.
  if (!s.beacon) s.beacon = beaconValue(state.genesis.genesisSeed, state.tick).toString('hex');
  const beacon = Buffer.from(s.beacon, 'hex');

  // snapshot who has already mastered what, so the end-of-tick pass can tell who
  // CROSSED a threshold this tick — regardless of which of the 18 XP sites paid it
  const _preMaster = {};
  for (const _pid in s.players) {
    const _done = new Set();
    for (const _sk of SKILLS) if (s.players[_pid].skills[_sk] >= XP_TABLE[99]) _done.add(_sk);
    _preMaster[_pid] = _done;
  }
  // the world marks its own years (deterministic: a pure function of the tick)
  if (s.tick > 0 && s.tick % TICKS_PER_YEAR === 0) {
    const _yr = s.tick / TICKS_PER_YEAR;
    announce(s, 'Interval is ' + _yr + ' year' + (_yr === 1 ? '' : 's') + ' old.');
  }
  // exploration: keep K survey markers alive; relocate any gone stale (v0.50)
  if (!s.markers) s.markers = [];
  const _K = s.genesis.survey?.k ?? 0;
  for (let _i = 0; _i < s.markers.length; _i++)
    if (s.tick - (s.markers[_i].bornAt ?? s.tick) > MARKER_LIFE) s.markers[_i] = surveyMarker(s, _ctx, _i, 'life');
  while (s.markers.length < _K) s.markers.push(surveyMarker(s, _ctx, s.markers.length, 'fill'));
  // brewpots abandoned past the decay window crumble, returning their tile to the
  // commons — the world stays open to newcomers; active pots reset the clock (v0.52)
  const _decay = s.genesis.brew?.decayTicks ?? 0;
  if (_decay > 0) for (const [_nid, _n] of Object.entries(s.nodes))
    if (_n.type === 'brewpot' && s.tick - (_n.lastUsed ?? 0) > _decay) deleteIndexedNode(s, _ctx, _nid);
  // watchfires (v0.53): while a fire burns it pays its keeper a slow trickle — the
  // light is public, the vigil is theirs. A fire long cold crumbles to ash.
  const _wt = s.genesis.watch;
  if (_wt) for (const [_nid, _n] of Object.entries(s.nodes)) {
    if (_n.type !== 'watchfire') continue;
    if (s.tick < (_n.fuelUntil ?? 0)) { const _k = s.players[_n.by]; if (_k && _k.hp > 0) _k.skills.firemaking += _wt.burnXp; }
    else if (s.tick - (_n.fuelUntil ?? 0) > _wt.decayTicks) deleteIndexedNode(s, _ctx, _nid);
  }

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
    if (m.hp <= 0 || pinned.has(mid) || (m.rootedUntil ?? 0) > s.tick) continue;
    if (roll(beacon, mid, 'wander') >= 48) continue;
    const [dx, dy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][roll(beacon, mid, 'dir') % 4];
    const nx = m.x + dx, ny = m.y + dy;
    if (nx < 1 || nx >= s.genesis.worldW - 1 || ny < 1 || ny >= s.genesis.worldH - 1) continue;
    if (inCity(s.genesis, nx, ny)) continue; // no mob enters Anchor (spec 2d)
    if (Math.max(Math.abs(nx - m.hx), Math.abs(ny - m.hy)) > 2) continue;
    if (nodeExistsAt(s, _ctx, nx, ny)) continue;
    m.x = nx; m.y = ny;
  }
  // v0.74: the shelves rot. Every SHELF_DECAY_EVERY intervals a sixteenth of
  // each stock is lost, rounded up so nothing lingers forever at a count of
  // one. Goods still on a shelf are goods nobody wanted at that price, and a
  // world where every log ever cut waits in a shop is a world whose economy
  // only ever grows. This is the item sink that selling used to be.
  if (s.tick % SHELF_DECAY_EVERY === 0) {
    for (const nid of Object.keys(s.nodes).sort()) {
      const n2 = s.nodes[nid];
      if (n2.type !== 'store' || !n2.shelf) continue;
      for (const item of Object.keys(n2.shelf).sort()) {
        const q = n2.shelf[item];
        const gone = Math.max(1, q >> SHELF_DECAY_SHIFT);
        if (q - gone <= 0) delete n2.shelf[item];
        else n2.shelf[item] = q - gone;
      }
      if (Object.keys(n2.shelf).length === 0) delete n2.shelf;
    }
  }

  // player-made fires burn out (spec §6f)
  for (const [nid, n2] of Object.entries(s.nodes)) {
    if (n2.expiresAt && n2.expiresAt <= s.tick) deleteIndexedNode(s, _ctx, nid);
  }
  // ground decay (spec §3.4): the ground forgets
  for (const [gid, g2] of Object.entries(s.ground)) {
    if (g2.expiresAt <= s.tick) delete s.ground[gid];
  }

  _p2mark('input_prep');
  // discard duplicate-input bundles (spec §5)
  const seen = new Map();
  for (const inp of inputs) {
    seen.set(inp.playerId, seen.has(inp.playerId) ? 'DUP' : inp);
  }

  // v0.70 (§5.4): a tick applies at most MAX_APPLIED_INPUTS inputs, and WHICH
  // ones is decided here rather than by whichever arrived first. Arrival order
  // differs between nodes, so a cap applied at the door meant two nodes could
  // hold different inputs for the same tick, compute different states, and
  // reach no quorum: a flood of worthless keys could stop the world outright.
  //
  // The rule is: citizens who already exist in this world are served before
  // unknown keys, and within each group the order is the canonical playerId
  // order used everywhere else. So an attacker minting identities can crowd
  // out other NEW arrivals, but can never displace a citizen already standing
  // in the world, and every node discards exactly the same inputs.
  let order = [...seen.keys()].sort();
  if (order.length > MAX_APPLIED_INPUTS) {
    const known = [], strangers = [];
    for (const pid of order) (s.players[pid] ? known : strangers).push(pid);
    // Strangers are guaranteed a share of the tick; known citizens take the
    // rest. Whichever group is short leaves its remainder to the other, so
    // nothing is wasted when nobody is knocking.
    const forStrangers = Math.min(strangers.length, STRANGER_SHARE);
    const forKnown = Math.min(known.length, MAX_APPLIED_INPUTS - forStrangers);
    order = known.slice(0, forKnown)
      .concat(strangers.slice(0, Math.min(strangers.length, MAX_APPLIED_INPUTS - forKnown)));
    order.sort(); // apply in canonical order, as always
  }
  _p2mark('input_apply');
  for (const pid of order) {
    const inp = seen.get(pid);
    if (inp === 'DUP' || !validInput(state, inp, _ctxPre)) continue;
    if (inp.type === 'spawn') { const sp = spawnOf(s.genesis); addPlayer(s, pid, sp.x, sp.y); continue; }
    const p = s.players[pid];
    if (p) p.lastInput = s.tick; // presence (spec 5e)
    if (p) { // spec 2k: attune to a waystone you stand beside — the road remembers who walked it
      for (const nid of adjacentNodeIdsInOrder(s, _ctx, p, 'waystone')) {
        if (!p.attuned) p.attuned = [];
        if (!p.attuned.includes(nid)) p.attuned.push(nid);
      }
    }
    if (inp.type === 'move') {
      if ((p.rootedUntil ?? 0) <= s.tick) { p.x += inp.dx; p.y += inp.dy; } // rooted: held in place by the star-dagger
      p.action = null;
    } else if (inp.type === 'recall') {
      // spec 2k: step out of the world beside one waystone and in beside another
      const ws = s.nodes[inp.to];
      if (ws && !inWilds(s.genesis, p.x, p.y) && (p.attuned ?? []).includes(inp.to)) {
        const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .map(([dx, dy]) => ({ x: ws.x + dx, y: ws.y + dy }))
          .find(t => t.x >= 1 && t.x < s.genesis.worldW - 1 && t.y >= 1 && t.y < s.genesis.worldH - 1
            && !nodeExistsAt(s, _ctx, t.x, t.y));
        if (spot) { p.x = spot.x; p.y = spot.y; }
        p.action = null; p.trade = null;
      }
    } else if (inp.type === 'gather') {
      p.action = { type: 'gather', nodeId: inp.nodeId };
    } else if (inp.type === 'stop') {
      p.action = null;
    } else if (inp.type === 'offer_trade') {
      // the shape gate guarantees both demand fields, canonically — the
      // persisted trade is the signed trade, verbatim (pre-freeze §12)
      p.trade = { to: inp.to, giveSlots: inp.giveSlots.slice(), wantItem: inp.wantItem, wantGold: inp.wantGold };
    } else if (inp.type === 'cancel_trade') {
      p.trade = null;
    } else if (inp.type === 'accept_trade') {
      // re-validate against the NEW state (§5c): all-or-nothing. Everything is
      // checked before anything moves, so a trade that cannot complete leaves
      // both packs exactly as they were.
      const o = s.players[inp.from];
      if (o && o.trade && o.trade.to === pid && adjacent(p, o) && tradeFits(o, p, o.trade)) {
        const slots = o.trade.giveSlots;
        const goods = slots.map(sl => o.inventory[sl]);
        if (o.trade.wantGold) { // v0.41: coin settles like any item
          if ((p.gold ?? 0) >= o.trade.wantGold) {
            p.gold -= o.trade.wantGold;
            o.gold = (o.gold ?? 0) + o.trade.wantGold;
            for (const sl of slots) o.inventory[sl] = null;
            for (const g of goods) addItem(p.inventory, g.item, g.qty ?? 1);
            o.trade = null;
          }
        } else {
          const j = p.inventory.findIndex(sl => sl && sl.item === o.trade.wantItem);
          if (j !== -1) {
            const payment = p.inventory[j];
            p.inventory[j] = null;
            for (const sl of slots) o.inventory[sl] = null;
            // the payment lands in the first slot the goods vacated, so a
            // trade never needs room the offerer did not just make
            o.inventory[slots[0]] = payment;
            for (const g of goods) addItem(p.inventory, g.item, g.qty ?? 1);
            o.trade = null;
          }
        }
      }
    } else if (inp.type === 'attack') {
      p.action = (p.action?.type === 'attack' && p.action.mobId === inp.mobId)
        ? p.action
        : { type: 'attack', mobId: inp.mobId, since: s.tick };
    } else if (inp.type === 'smith') {
      const r = RECIPES[inp.recipe];
      const nearAnvil = hasAdjacentNode(s, _ctx, p, 'anvil');
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
      // v0.74: the keeper's own goods are made from nothing and priced by the
      // constitution. Everything else on the shelf was put there by a citizen,
      // and costs the ask: what its seller was paid, plus the keeper's cut.
      const st = findAdjacentNode(s, _ctx, p, 'store');
      const own = inp.item in STORE_SELLS;
      const onShelf = (st?.shelf?.[inp.item] ?? 0) > 0;
      const price = own ? STORE_SELLS[inp.item] : onShelf ? storeAsk(inp.item) : 0;
      if (st && price && (own || onShelf) && (p.gold ?? 0) >= price) {
        if (addItem(p.inventory, inp.item, 1)) {
          p.gold -= price;
          // goods from the shelf LEAVE the shelf. The keeper's own do not:
          // seeds are made, not stocked.
          if (!own && st.shelf) {
            st.shelf[inp.item] -= 1;
            if (st.shelf[inp.item] <= 0) delete st.shelf[inp.item];
            if (Object.keys(st.shelf).length === 0) delete st.shelf;
          }
        }
      }
    } else if (inp.type === 'attackp') {
      const q = s.players[inp.targetId];
      if (q && q.hp > 0 && inWilds(s.genesis, p.x, p.y) && inWilds(s.genesis, q.x, q.y)) {
        // repeating an order you are already carrying out changes nothing:
        // the rhythm belongs to the fight, not to how often you ask for it
        p.action = (p.action?.type === 'attackp' && p.action.targetId === inp.targetId)
          ? p.action
          : { type: 'attackp', targetId: inp.targetId, since: s.tick };
        // the Brand (v0.41): striking one who was not striking you is
        // worn openly. Windows paint it as they wish; the state is law.
        const q3 = s.players[inp.targetId];
        if (q3 && !(q3.action?.type === 'attackp' && q3.action.targetId === pid))
          p.brandedUntil = s.tick + BRAND_TICKS;
      }
    } else if (inp.type === 'plant') {
      const sl = p.inventory[inp.slot];
      const plot = findAdjacentNode(s, _ctx, p, 'plot', n => !n.plantedAt);
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
      const nearStore = hasAdjacentNode(s, _ctx, p, 'store');
      if (sl && PRICES[sl.item] && nearStore) {
        p.gold = (p.gold ?? 0) + PRICES[sl.item] * (sl.qty ?? 1);
        // v0.74: onto THIS store's shelf, not into nothing. Beyond the cap the
        // keeper still pays but the goods are lost: a shelf is finite, and
        // consensus state is held by every node forever.
        const st = findAdjacentNode(s, _ctx, p, 'store');
        if (st) {
          if (!st.shelf) st.shelf = {};
          const have = st.shelf[sl.item] ?? 0;
          st.shelf[sl.item] = Math.min(SHELF_CAP, have + (sl.qty ?? 1));
        }
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
        if (claimFirst(s, 'sigil', pid)) announce(s, (p.name ?? pid.slice(0, 6)) + ' is the FIRST to press three stones into a sigil.');
      }
    } else if (inp.type === 'cast') {
      const si = p.inventory.findIndex(sl => sl?.item === 'sigil');
      if (inp.spell === 'mend' && si !== -1) {
        p.inventory[si] = null;
        p.hp = Math.min(effLevel(p.skills.hitpoints), p.hp + 20); // v0.41: a strong heal (+20), not a full reset — keeps mend premium without making sigil-stackers unkillable
        p.skills.magic += 40;
      } else if (inp.spell === 'anchor' && si !== -1) {
        p.inventory[si] = null;
        const cx2 = Math.floor(s.genesis.worldW / 2);
        p.x = cx2; p.y = 7; // the plaza beside the well: the fixed point
        p.action = null;
        p.trade = null;
        p.skills.magic += 30;
      }
    } else if (inp.type === 'survey') {
      const mi = (s.markers ?? []).findIndex(m => m.x === p.x && m.y === p.y);
      if (mi !== -1) {
        const m = s.markers[mi], anchor = spawnOf(s.genesis), sv = s.genesis.survey;
        const d = Math.max(Math.abs(m.x - anchor.x), Math.abs(m.y - anchor.y));
        p.skills.exploration += Math.min(sv.max, sv.base + sv.perTile * d); // paid in distance
        if (m.kind === 'ws' && m.ws && s.nodes[m.ws]?.type === 'waystone') { // a rumor: hand over the chart
          const chart = CHART_PREFIX + m.ws, free = p.inventory.findIndex(x => x === null);
          if (free !== -1 && !(p.attuned ?? []).includes(m.ws) && !p.inventory.some(x => x?.item === chart))
            p.inventory[free] = { item: chart, qty: 1 };
        }
        const find = MARKER_FINDS[m.kind]; // the traces of those who came before
        if (find) {
          const free2 = p.inventory.findIndex(x => x === null);
          if (free2 !== -1) p.inventory[free2] = { item: find, qty: 1 }; // a full pack forfeits; the claim stands
        }
        if (claimFirst(s, 'surveyor', pid)) announce(s, (p.name ?? pid.slice(0, 6)) + ' is the FIRST to survey the frontier.');
        s.markers[mi] = surveyMarker(s, _ctx, mi, 'claim:' + pid); // the point relocates
      }
    } else if (inp.type === 'read_chart') {
      const sl = p.inventory[inp.slot];
      if (sl && isChart(sl.item)) {
        const wid = sl.item.slice(CHART_PREFIX.length);
        if (s.nodes[wid]?.type === 'waystone') { // the chart's knowledge becomes YOUR attunement
          if (!p.attuned) p.attuned = [];
          if (!p.attuned.includes(wid)) p.attuned.push(wid);
        }
        p.inventory[inp.slot] = null; // spent
      }
    } else if (inp.type === 'build_brewpot') {
      const bc = s.genesis.brew;
      const free = !nodeExistsAt(s, _ctx, p.x, p.y);
      const nearHouse = hasAdjacentNode(s, _ctx, p, 'house');
      const owned = brewpotsOwnedBy(s, _ctx, pid);
      if (bc && free && nearHouse && owned < bc.potCap && countItem(p.inventory, 'logs') >= bc.buildLogs && countItem(p.inventory, 'ore') >= bc.buildOre) {
        consumeItem(p.inventory, 'logs', bc.buildLogs); consumeItem(p.inventory, 'ore', bc.buildOre);
        addIndexedNode(s, _ctx, 'brewpot-' + pid.slice(0, 8) + '-' + s.tick, { type: 'brewpot', x: p.x, y: p.y, by: pid, lastUsed: s.tick });
      }
    } else if (inp.type === 'brew') {
      const bp = s.nodes[inp.nodeId], sl = p.inventory[inp.slot];
      if (bp && bp.type === 'brewpot' && bp.by === pid && bp.readyAt === undefined && atOrBeside(p, bp) && sl && (sl.item === 'grain' || sl.item === 'raw-fish')) {
        removeItem(p.inventory, inp.slot, 1);
        bp.brewKind = sl.item === 'grain' ? 'ale' : 'broth';
        bp.readyAt = s.tick + s.genesis.brew.ferment; bp.lastUsed = s.tick; // the world does the waiting (spec 8)
      }
    } else if (inp.type === 'collect') {
      const bp = s.nodes[inp.nodeId];
      if (bp && bp.type === 'brewpot' && bp.by === pid && atOrBeside(p, bp) && bp.readyAt !== undefined && s.tick >= bp.readyAt && canAddItem(p.inventory, bp.brewKind)) {
        addItem(p.inventory, bp.brewKind, 1);
        p.skills.brewing += s.genesis.brew.xpPerBatch; // XP lands on the completed batch
        if (claimFirst(s, 'brewer', pid)) announce(s, (p.name ?? pid.slice(0, 6)) + ' is the FIRST to draw a finished brew.');
        delete bp.readyAt; delete bp.brewKind; bp.lastUsed = s.tick;
      }
    } else if (inp.type === 'dismantle') {
      const bp = s.nodes[inp.nodeId];
      if (bp && bp.type === 'brewpot' && bp.by === pid && atOrBeside(p, bp)) {
        const bc = s.genesis.brew; // half the build returned, if there is room; any brew within is lost
        for (let _r = 0; _r < Math.floor((bc?.buildLogs ?? 0) / 2); _r++) if (canAddItem(p.inventory, 'logs')) addItem(p.inventory, 'logs', 1);
        for (let _r = 0; _r < Math.floor((bc?.buildOre ?? 0) / 2); _r++) if (canAddItem(p.inventory, 'ore')) addItem(p.inventory, 'ore', 1);
        deleteIndexedNode(s, _ctx, inp.nodeId);
      }
    } else if (inp.type === 'kindle') {
      const wt = s.genesis.watch;
      if (wt && effLevel(p.skills.firemaking) >= wt.level && countItem(p.inventory, 'logs') >= wt.kindleLogs
          && !nodeExistsAt(s, _ctx, p.x, p.y) && countOwnedNodes(s, _ctx, 'watchfire', pid) < wt.maxOwned) {
        consumeItem(p.inventory, 'logs', wt.kindleLogs);
        p.skills.firemaking += wt.xpPerLog * wt.kindleLogs; // every log pays, here as at the hearth
        addIndexedNode(s, _ctx, 'wf' + s.tick + '-' + pid.slice(0, 8),
          { type: 'watchfire', x: p.x, y: p.y, by: pid, fuelUntil: s.tick + wt.perLog * wt.kindleLogs });
        if (claimFirst(s, 'watchfire', pid)) announce(s, (p.name ?? pid.slice(0, 6)) + ' is the FIRST to raise a watchfire.');
      }
    } else if (inp.type === 'stoke') {
      const wf = s.nodes[inp.nodeId], sl = p.inventory[inp.slot], wt = s.genesis.watch;
      if (wf && wf.type === 'watchfire' && atOrBeside(p, wf) && sl && sl.item === 'logs' && wt
          && (wf.fuelUntil ?? 0) < s.tick + wt.cap) {
        removeItem(p.inventory, inp.slot, 1);
        // fuel banks forward from whichever is later: now, or the fire's remaining burn
        wf.fuelUntil = Math.min(Math.max(wf.fuelUntil ?? 0, s.tick) + wt.perLog, s.tick + wt.cap);
        p.skills.firemaking += wt.xpPerLog; // the feeder earns, even at another's fire
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
      const clear = !nodeExistsAt(s, _ctx, p.x, p.y);
      if (sl && sl.item === 'logs' && clear) {
        const lvl = effLevel(p.skills.firemaking);
        p.lightsTried = (p.lightsTried ?? 0) + 1; // the tally, not the dice
        if (countedSuccess(p.lightsTried, Math.min(64 + 2 * lvl, 240))) {
          p.inventory[inp.slot] = null;
          p.skills.firemaking += XP_FIREMAKING;
          addIndexedNode(s, _ctx, 'f' + s.tick + '-' + pid.slice(0, 8),
            { type: 'fire', x: p.x, y: p.y, depletedUntil: 0, expiresAt: s.tick + FIRE_TICKS });
          // step aside (§6f): west, east, south, north: first free tile
          for (const [mx, my] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) {
            const nx = p.x + mx, ny = p.y + my;
            if (nx < 1 || nx >= s.genesis.worldW - 1 || ny < 1 || ny >= s.genesis.worldH - 1) continue;
    if (inCity(s.genesis, nx, ny)) continue; // no mob enters Anchor (spec 2d)
            if (nodeExistsAt(s, _ctx, nx, ny)) continue;
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
      const nearBank = hasAdjacentNode(s, _ctx, p, 'bank');
      if (sl && nearBank) {
        // 7.3: one item per interval (spec) means ONE unit leaves the slot;
        // the old path banked 1 and vaporized the rest of the stack
        p.bank[sl.item] = (p.bank[sl.item] ?? 0) + 1;
        if ((sl.qty ?? 1) > 1) sl.qty -= 1;
        else p.inventory[inp.slot] = null;
      }
    } else if (inp.type === 'withdraw') {
      const slot = firstFreeSlot(p.inventory);
      const nearBank = hasAdjacentNode(s, _ctx, p, 'bank');
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
        // 7.2: the whole slot falls, quantity intact — 17 arrows dropped
        // are 17 arrows on the ground, matching death drops and pickup
        s.ground[gid] = { item: it.item, qty: it.qty ?? 1, x: p.x, y: p.y, expiresAt: s.tick + 100 };
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
      const heal = !slot ? 0 : slot.item === 'cooked-fish' ? HEAL_FISH : slot.item === 'broth' ? HEAL_BROTH : slot.item === 'ale' ? HEAL_ALE : 0;
      if (heal > 0 && s.tick - (p.lastAte ?? -EAT_EVERY) >= EAT_EVERY) {
        p.lastAte = s.tick;
        removeItem(p.inventory, inp.slot, 1); // stackable brews draw from the stack; a fish clears its slot
        p.hp = Math.min(p.hp + heal, effLevel(p.skills.hitpoints));
        // v0.32 (spec 6m): eating does not lower your guard; the fight holds
      }
    } else if (inp.type === 'cook') {
      // re-check against new state; instant, same-tick resolution (§6a)
      const slot = p.inventory[inp.slot];
      const nearFire = hasAdjacentNode(s, _ctx, p, _FIRE_TYPES);
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

  _p2mark('actions');
  // resolve ongoing actions (spec §6, §6b), canonical order
  for (const pid of Object.keys(s.players).sort()) {
    const p = s.players[pid];
    if (!p.action) continue;

    if (p.action.type === 'attackp') {
      const q = s.players[p.action.targetId];
      const both = q && q.hp > 0 && inWilds(s.genesis, p.x, p.y) && inWilds(s.genesis, q.x, q.y);
      const near = both && (adjacent(p, q)
        || (Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= 4
            && p.equipment.weapon?.item === 'wooden-bow'
            && p.inventory.some(sl => sl?.item === 'arrows')));
      if (!near) { p.action = null; }
      else if (s.tick - (p.lastSwing ?? -64) < (weaponOf(p)?.every ?? 2)) {
        /* combat breathes (6m, 2b-iii): the arm has not recovered, and turning
           to a different foe does not give it back. The chain never rests (6r). */ }
      else {
        p.lastSwing = s.tick; // the arm is spent, whoever it was spent on
        const bowDrawn2 = drawnAt(p, q);
        let lvl2, tag2;
        if (bowDrawn2) {
          const aSlot = p.inventory.findIndex(sl => sl?.item === 'arrows');
          if (aSlot === -1) { p.action = null; continue; }
          p.inventory[aSlot].qty -= 1;
          if (p.inventory[aSlot].qty <= 0) p.inventory[aSlot] = null;
          lvl2 = effLevel(p.skills.ranged); tag2 = 'ranged';
        } else { lvl2 = effLevel(p.skills.attack); tag2 = 'attack'; }
        const defL = effLevel(q.skills.defence);
        const Tp = clamp(128 + 4 * (lvl2 - defL) + (weaponOf(p)?.acc ?? 0), 16, 240);
        if (roll(beacon, pid, 'atk') < Tp) {
          const maxHit = 1 + Math.floor(lvl2 / (bowDrawn2 ? 12 : 10))
            + (weaponOf(p)?.hit ?? 0);
          const soak = (q.equipment.head ? SOAK(q.equipment.head.item) : 0) + (q.equipment.body ? SOAK(q.equipment.body.item) : 0);
          const dmg = Math.max(0, 1 + (roll(beacon, pid, 'dmg') % maxHit) - soak);
          q.hp -= dmg;
          p.skills[tag2] += 4 * dmg;
          p.skills.hitpoints += dmg;
          if (q.hp > 0 && p.equipment.weapon?.item === 'star-dagger'
              && (p.rootCdUntil ?? 0) <= s.tick && (q.rootedUntil ?? 0) <= s.tick && (q.rootImmuneUntil ?? 0) <= s.tick) {
            q.rootedUntil = s.tick + ROOT_TICKS;                 // held fast
            q.rootImmuneUntil = s.tick + ROOT_TICKS + ROOT_IMMUNE; // then briefly unfreezable
            p.rootCdUntil = s.tick + ROOT_CD;                    // the dagger sleeps a long while
          }
          if (q.hp > 0 && q.action?.type !== 'attackp' && q.action?.type !== 'attack') {
            q.action = { type: 'attackp', targetId: pid, since: s.tick + 1 }; // struck: strikes back
          }
          if (q.hp <= 0) {
            q.hp = 0; // a killing blow that overshoots still leaves a body at nought (v0.53)
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
      const bowHeld = isRanged(p)
        && Math.max(Math.abs(p.x - m.x), Math.abs(p.y - m.y)) <= reachOf(p);
      if (!inReach(p, m) && !bowHeld) { p.action = null; continue; }
      // every weapon keeps its own rhythm (6m, 6r): a maul is slow, a chain
      // never rests, everything else breathes
      const every = weaponOf(p)?.every ?? 2;
      if (s.tick - (p.lastSwing ?? -64) < every) continue; // 2b-iii: one arm, one speed
      const mobTurn = (s.tick - (p.action.since ?? 0)) % 2 === 0; // the defender keeps the old rhythm
      p.lastSwing = s.tick; // the arm is spent, whoever it was spent on

      const bowDrawn = drawnAt(p, m);
      if (bowDrawn) { // ranged (spec 6j): every draw costs an arrow, hit or miss
        const aSlot = p.inventory.findIndex(sl => sl?.item === 'arrows');
        if (aSlot === -1) { p.action = null; continue; }
        p.inventory[aSlot].qty -= 1;
        if (p.inventory[aSlot].qty <= 0) p.inventory[aSlot] = null;
        const rLvl = effLevel(p.skills.ranged);
        const Tr = clamp(128 + 4 * (rLvl - stats.def) + (weaponOf(p)?.acc ?? 0), 16, 240);
        if (roll(beacon, pid, 'atk') < Tr) {
          const maxHit = 1 + Math.floor(rLvl / 12) + (weaponOf(p)?.hit ?? 0);
          const dmg = 1 + (roll(beacon, pid, 'dmg') % maxHit);
          m.hp -= dmg;
          p.skills.ranged += 4 * dmg;
          p.skills.hitpoints += dmg;
        }
      } else {
      const atkLvl = effLevel(p.skills.attack);
      const T = clamp(128 + 4 * (atkLvl - stats.def) + (weaponOf(p)?.acc ?? 0), 16, 240);
      if (roll(beacon, pid, 'atk') < T) {
        const maxHit = 1 + Math.floor(atkLvl / 10) + (weaponOf(p)?.hit ?? 0);
        const dmg = 1 + (roll(beacon, pid, 'dmg') % maxHit);
        m.hp -= dmg;
        p.skills.attack += 4 * dmg;
        p.skills.hitpoints += dmg;
        if (m.hp > 0 && p.equipment.weapon?.item === 'star-dagger'
            && (p.rootCdUntil ?? 0) <= s.tick && (m.rootedUntil ?? 0) <= s.tick && (m.rootImmuneUntil ?? 0) <= s.tick) {
          m.rootedUntil = s.tick + ROOT_TICKS;
          m.rootImmuneUntil = s.tick + ROOT_TICKS + ROOT_IMMUNE;
          p.rootCdUntil = s.tick + ROOT_CD;
        }
      }
      }

      if (m.hp <= 0) {
        if (m.type === 'skeleton-knight' && claimFirst(s, 'knightslayer', pid))
          announce(s, (p.name ?? pid.slice(0, 6)) + ' is the FIRST to fell a skeleton-knight.');
        // drops lie where they fall (spec §6e): loot belongs to whoever takes it
        // The Reading Rule (v0.39) reaches loot too (v0.64). A drop judged by
        // the tick's beacon could be TIMED: fight the beast to its last point
        // of life, read the public beacon, and withhold the killing blow until
        // a kind tick comes round. That turns a one-in-thirty-two drop into a
        // certainty for anyone willing to wait twenty seconds, which is not a
        // rare drop at all. Loot is therefore COUNTED, exactly as cooking and
        // firemaking are: the tally is per citizen and per drop, so the rate is
        // the promised rate and no timing can bend it.
        if (!p.slain) p.slain = {};
        for (let di = 0; di < stats.drops.length; di++) {
          const d = stats.drops[di];
          if (d.chance !== undefined) {
            const tally = m.type + ':' + di;
            p.slain[tally] = (p.slain[tally] ?? 0) + 1;
            if (!countedSuccess(p.slain[tally], d.chance, DROP_DEN)) continue;
          }
          const gid = 'g' + s.tick + '-' + p.action.mobId + '-' + di + '-' + d.item; // di keeps twin drops distinct
          s.ground[gid] = { item: d.item, x: m.x, y: m.y, expiresAt: s.tick + 100 };
        }
        m.respawnAt = s.tick + stats.respawn;
        p.action = null;
      } else {
        // retaliation (spec §6b.4)
        const defLvl = effLevel(p.skills.defence);
        const Tm = clamp(128 + 4 * (stats.atk - defLvl), 16, 240);
        // v0.71: defence is paid for in RISK, and only in risk. The beast has
        // to actually swing at you, and it has to be able to reach you. Both
        // conditions used to sit inside the same test as the hit roll, so the
        // else-branch caught three different things and paid for all of them:
        // a genuine miss, a beast resting between swings, and a beast four
        // tiles away that could never touch you. An archer therefore trained
        // ranged, hitpoints and defence at once in perfect safety, at the same
        // defence rate as someone standing in the beast's reach. Defence is
        // the one skill whose whole meaning is being hit at and surviving it.
        if (mobTurn && !bowDrawn) {
          if (roll(beacon, pid, 'mobatk') < Tm) {
            // armor soaks (spec 6i): each worn piece turns aside 1 damage
            const soak = (p.equipment.head ? SOAK(p.equipment.head.item) : 0) + (p.equipment.body ? SOAK(p.equipment.body.item) : 0);
            // v0.72: a blow that lands always costs something. Armour makes a
            // citizen harder to hurt, never impossible to hurt. Under the old
            // max(0, ...) a full suit of starmetal soaked 4, which is the
            // hardest hit any beast in this world can throw: a star-clad
            // citizen took zero from everything, skeleton-knights included,
            // and the Wilds held no danger for the best-equipped person in it.
            p.hp -= Math.max(1, 1 + (roll(beacon, pid, 'mobdmg') % stats.maxHit) - soak);
            if (p.hp <= 0) {
              p.hp = 0; // never below nought: nextState must not out-run validateState (v0.53)
              // death (spec §6c, v0.41): the body lies where it fell for
              // DEATH_TICKS: the world holds its breath, windows may grieve.
              p.inventory = Array(INV_SLOTS).fill(null);
              p.equipment = { weapon: null, head: null, body: null }; // the sink spares nothing (§5d)
              p.action = null;
              p.trade = null;
              p.deadUntil = s.tick + DEATH_TICKS;
            }
          } else {
            p.skills.defence += 4; // it swung, it could reach you, it missed
          }
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

  _p2mark('beacon');
  // tomorrow's lots, drawn from today's deeds (spec 7, v0.38)
  s.beacon = delayChain(beacon, inputsDigest(inputs)).toString('hex');
  _p2mark('mastery');
  // ---- mastery announcements (v0.48): who crossed 99 this tick ----
  const _M = XP_TABLE[99];
  for (const _pid in s.players) {
    const _p = s.players[_pid], _pre = _preMaster[_pid] ?? new Set();
    const _nm = _p.name ?? _pid.slice(0, 6);
    let _newMastery = false;
    for (const _sk of SKILLS) {
      if (_p.skills[_sk] >= _M && !_pre.has(_sk)) {
        _newMastery = true;
        if (claimFirst(s, 'master:' + _sk, _pid)) announce(s, _nm + ' is the FIRST citizen ever to master ' + _sk + '.');
        else announce(s, _nm + ' has mastered ' + _sk + '.');
      }
    }
    // total mastery: newly crossed the last of all 14 skills this tick
    if (_newMastery && _pre.size < SKILLS.length && SKILLS.every(_sk => _p.skills[_sk] >= _M)) {
      if (claimFirst(s, 'totalmaster', _pid)) announce(s, _nm + ' is the FIRST ever Master of Interval.');
      else announce(s, _nm + ' has become a Master of Interval.');
    }
    // firsts derivable from the state itself (v0.48)
    if (inWilds(s.genesis, _p.x, _p.y) && claimFirst(s, 'wilds', _pid))
      announce(s, _nm + ' is the FIRST to set foot in the Wilds.');
    const _isStar = (it) => it === 'star-sword' || it === 'star-helm' || it === 'star-plate' || it === 'star-dagger';
    const _star = _p.inventory.some(_sl => _sl && _isStar(_sl.item))
      || Object.values(_p.equipment ?? {}).some(_e => _e && _isStar(_e.item));
    if (_star && claimFirst(s, 'stargear', _pid))
      announce(s, _nm + ' is the FIRST to bear star-forged gear.');
  }
  _p2mark(null);

  return s;
}

module.exports = {
  registerTerrain, terrainBlocked,
  SPEC_VERSION, TICK_MS, INV_SLOTS,
  XP_TABLE, levelForXp,
  canonical, stateHash, sha256, beaconValue, roll,
  worldId, SIG_DOMAINS,
  countItem, canAddItem, addItem, removeItem,
  generateIdentity, signInput, verifyInputSig,
  perfStats, ENGINE_ERR,
  // test-only hook (non-API): lets the perf suite exercise cache eviction
  // without minting 16k signatures. Never used by protocol code.
  _perfTesting: {
    setSigCacheMax(n) { _sigCacheMax = n; },
    resetCounters() { for (const k of Object.keys(_perf)) _perf[k] = 0; },
    clearSigCache() { _sigCache.clear(); },
  },
  // Phase 2 benchmark instrumentation (non-consensus; off unless enabled)
  _phase2Perf: {
    enable() { _p2on = true; },
    disable() { _p2on = false; },
    reset() { for (const k of Object.keys(_p2c)) _p2c[k] = 0; _p2sections = {}; _p2cur = null; },
    tickStart() { _p2sections = {}; _p2cur = null; },
    tickSections() { return { ..._p2sections }; },
    counters() { return { ..._p2c }; },
    cloneMode() { return _cloneModeName(); },
    indexesEnabled() { return _indexesOn(); },
  },
  // Phase 2 test hooks (non-API): clone/index selection for differential
  // campaigns, plus direct access to the helpers under test.
  _phase2Testing: {
    setClone(m) { _cloneOverride = m; },
    setIndexes(b) { _indexOverride = b; },
    cloneStateForTick, buildTickContext,
    addIndexedNode, deleteIndexedNode,
    nodeExistsAt, blockingNodeAt, hasAdjacentNode, findAdjacentNode,
    adjacentNodeIdsInOrder, waystoneIdsSorted, brewpotsOwnedBy,
    validInput,
  },
  signPayload, verifyPayload,
  exportIdentity, importIdentity, loadOrCreateIdentity,
  SLEEP_AFTER, isAwake, effLevel, standingOf, callingOf, CALLINGS, countedSuccess, validateState, validateGenesis, validateImports, validateInputShape, normalizeInput, slotOf, supportsWorldGenerator, minQuorumFor, maxByzantine, byzantineSafe, initCrypto, SKILLS, EQUIP_SLOTS, NODE_TYPES, INV_SLOTS, ITEMS, isValidName, cityRectOf, norwickRectOf, wildsRectOf, inCity, PRICES, inWilds, spawnOf, makeGenesis, newWorld, sameWorld, addPlayer, addNode, addMob, nextState, MOB_STATS, RECIPES, EQUIPPABLE,
};
