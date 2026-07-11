// Interval reference engine v0.2
// Pure deterministic state machine: nextState(state, inputs, beacon)
// No I/O, no Date, no Math.random, no floats in game logic.
// v0.2: ed25519-signed inputs verified in the state machine,
//       hardcoded XP table (spec constants), genesis object with rules hash.
// v0.4: names as in-world objects (claim_name, spec §5a).
// v0.6: spawning (§5b) and adjacent atomic trade (§5c).

'use strict';
// Universal crypto: @noble libraries are pure, audited, deterministic JS —
// the same engine bytes run in Node, browsers, and anywhere else.
const { sha256: nobleSha256, sha512 } = require('@noble/hashes/sha2.js');
const ed = require('@noble/ed25519');
ed.hashes.sha512 = sha512;
const hex = (u8) => Buffer.from(u8).toString('hex');

const SPEC_VERSION = '0.19';
const TICK_MS = 600;
const INV_SLOTS = 28;
const DEPLETE_TICKS = 8;
const NODE_YIELD = {
  'tree':         { item: 'logs',     skill: 'woodcutting', xp: 25 },
  'rock':         { item: 'ore',      skill: 'mining',      xp: 35 },
  'fishing-spot': { item: 'raw-fish', skill: 'fishing',     xp: 30 },
};
const XP_COOK = 30;
const HEAL_FISH = 3;
const HP_START_XP = 1154; // hitpoints level 10
const MOB_STATS = {
  goblin: { maxHp: 5, atk: 1, def: 1, maxHit: 1, respawn: 16,
            drops: [{ item: 'bones' }, { item: 'ore', chance: 64 }] },
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const RECIPES = {
  'bronze-sword':   { ore: 2, logs: 1 },
  'bronze-hatchet': { ore: 1, logs: 1 },
  'bronze-pickaxe': { ore: 1, logs: 1 },
};
const EQUIPPABLE = new Set(Object.keys(RECIPES));
const TOOL_FOR = { tree: 'bronze-hatchet', rock: 'bronze-pickaxe' };
const XP_SMITH_PER_ORE = 30;
const XP_FIREMAKING = 40;
const FIRE_TICKS = 100;
const spawnOf = (g) => ({ x: Math.floor(g.worldW / 2), y: Math.floor(g.worldH / 2) });

// ---------- XP table: spec constants (Appendix A). Index = level. ----------
const XP_TABLE = [0,0,83,174,276,388,512,650,801,969,1154,1358,1584,1833,2107,2411,2746,3115,3523,3973,4470,5018,5624,6291,7028,7842,8740,9730,10824,12031,13363,14833,16456,18247,20224,22406,24815,27473,30408,33648,37224,41171,45529,50339,55649,61512,67983,75127,83014,91721,101333,111945,123660,136594,150872,166636,184040,203254,224466,247886,273742,302288,333804,368599,407015,449428,496254,547953,605032,668051,737627,814445,899257,992895,1096278,1210421,1336443,1475581,1629200,1798808,1986068,2192818,2421087,2673114,2951373,3258594,3597792,3972294,4385776,4842295,5346332,5902831,6517253,7195629,7944614,8771558,9684577,10692629,11805606,13034431];

function levelForXp(xp) {
  let lvl = 1;
  while (lvl < 99 && xp >= XP_TABLE[lvl + 1]) lvl++;
  return lvl;
}

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
      // pre-noble key format (pkcs8): unusable — preserve and regenerate
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
              firemaking: 0, attack: 0, defence: 0, hitpoints: HP_START_XP },
    hp: 10,
    equipment: { weapon: null },
    bank: {},
    inventory: Array(INV_SLOTS).fill(null),
    action: null,
    name: null,
    trade: null,
  };
}

function addMob(state, mobId, type, x, y) {
  state.mobs[mobId] = { type, x, y, hp: MOB_STATS[type].maxHp, respawnAt: 0 };
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
  switch (input.type) {
    case 'move': {
      const { dx, dy } = input;
      if (![ -1, 0, 1 ].includes(dx) || ![ -1, 0, 1 ].includes(dy)) return false;
      const nx = p.x + dx, ny = p.y + dy;
      if (nx < 0 || nx >= state.genesis.worldW || ny < 0 || ny >= state.genesis.worldH) return false;
      // nodes are impassable (§5): you fish beside the water, not in it
      return !Object.values(state.nodes).some(n => n.x === nx && n.y === ny);
    }
    case 'gather': {
      const n = state.nodes[input.nodeId];
      return !!n && (n.type in NODE_YIELD) && n.depletedUntil <= state.tick && adjacent(p, n);
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
      return typeof input.wantItem === 'string';
    }
    case 'accept_trade': {
      const o = state.players[input.from];
      if (!o || !o.trade || o.trade.to !== input.playerId) return false;
      if (!adjacent(p, o)) return false;
      return p.inventory.some(s => s && s.item === o.trade.wantItem);
    }
    case 'cancel_trade':
      return p.trade !== null;
    case 'attack': {
      const m = state.mobs[input.mobId];
      return !!m && m.hp > 0 && adjacent(p, m);
    }
    case 'smith': {
      const r = RECIPES[input.recipe];
      if (!r) return false;
      if (!Object.values(state.nodes).some(n => n.type === 'anvil' && adjacent(p, n))) return false;
      const have = (item) => p.inventory.filter(sl => sl && sl.item === item).length;
      return Object.entries(r).every(([item, qty]) => have(item) >= qty);
    }
    case 'wield': {
      const sl = p.inventory[input.slot];
      return Number.isInteger(input.slot) && !!sl && EQUIPPABLE.has(sl.item);
    }
    case 'unwield':
      return p.equipment.weapon !== null && firstFreeSlot(p.inventory) !== -1;
    case 'light': {
      const sl = p.inventory[input.slot];
      if (!Number.isInteger(input.slot) || !sl || sl.item !== 'logs') return false;
      return !Object.values(state.nodes).some(n => n.x === p.x && n.y === p.y);
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

function nextState(state, inputs, beacon) {
  const s = JSON.parse(JSON.stringify(state)); // pure: never mutate caller's state
  s.tick = state.tick + 1;

  // mob respawns (spec §3.3): processed at tick start
  for (const m of Object.values(s.mobs)) {
    if (m.hp <= 0 && m.respawnAt <= s.tick) m.hp = MOB_STATS[m.type].maxHp;
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
    if (inp.type === 'move') {
      p.x += inp.dx;
      p.y += inp.dy;
      p.action = null;
    } else if (inp.type === 'gather') {
      p.action = { type: 'gather', nodeId: inp.nodeId };
    } else if (inp.type === 'stop') {
      p.action = null;
    } else if (inp.type === 'offer_trade') {
      p.trade = { to: inp.to, giveSlot: inp.giveSlot, wantItem: inp.wantItem };
    } else if (inp.type === 'cancel_trade') {
      p.trade = null;
    } else if (inp.type === 'accept_trade') {
      // re-validate against the NEW state (§5c): all-or-nothing
      const o = s.players[inp.from];
      if (o && o.trade && o.trade.to === pid && adjacent(p, o)) {
        const giveItem = o.inventory[o.trade.giveSlot];
        const j = p.inventory.findIndex(sl => sl && sl.item === o.trade.wantItem);
        if (giveItem && j !== -1) {
          const wantSlotItem = p.inventory[j];
          o.inventory[o.trade.giveSlot] = wantSlotItem;
          p.inventory[j] = giveItem;
          o.trade = null;
        }
      }
    } else if (inp.type === 'attack') {
      p.action = { type: 'attack', mobId: inp.mobId };
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
        const cur = p.equipment.weapon;
        p.equipment.weapon = sl;
        p.inventory[inp.slot] = cur;
      }
    } else if (inp.type === 'unwield') {
      const slot = firstFreeSlot(p.inventory);
      if (p.equipment.weapon && slot !== -1) {
        p.inventory[slot] = p.equipment.weapon;
        p.equipment.weapon = null;
      }
    } else if (inp.type === 'light') {
      const sl = p.inventory[inp.slot];
      const clear = !Object.values(s.nodes).some(n => n.x === p.x && n.y === p.y);
      if (sl && sl.item === 'logs' && clear) {
        const lvl = levelForXp(p.skills.firemaking);
        if (roll(beacon, pid, 'light') < Math.min(64 + 2 * lvl, 240)) {
          p.inventory[inp.slot] = null;
          p.skills.firemaking += XP_FIREMAKING;
          s.nodes['f' + s.tick + '-' + pid.slice(0, 8)] =
            { type: 'fire', x: p.x, y: p.y, depletedUntil: 0, expiresAt: s.tick + FIRE_TICKS };
          // step aside (§6f): west, east, south, north — first free tile
          for (const [mx, my] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) {
            const nx = p.x + mx, ny = p.y + my;
            if (nx < 0 || nx >= s.genesis.worldW || ny < 0 || ny >= s.genesis.worldH) continue;
            if (Object.values(s.nodes).some(n => n.x === nx && n.y === ny)) continue;
            p.x = nx; p.y = ny;
            break;
          }
        }
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
      const slot = firstFreeSlot(p.inventory);
      if (g2 && g2.x === p.x && g2.y === p.y && slot !== -1) {
        p.inventory[slot] = { item: g2.item, qty: 1 };
        delete s.ground[inp.groundId];
      }
    } else if (inp.type === 'eat') {
      const slot = p.inventory[inp.slot];
      if (slot && slot.item === 'cooked-fish') {
        p.inventory[inp.slot] = null;
        p.hp = Math.min(p.hp + HEAL_FISH, levelForXp(p.skills.hitpoints));
        p.action = null; // §5: you stop what you're doing to eat
      }
    } else if (inp.type === 'cook') {
      // re-check against new state; instant, same-tick resolution (§6a)
      const slot = p.inventory[inp.slot];
      const nearFire = Object.values(s.nodes).some(n => (n.type === 'campfire' || n.type === 'fire') && adjacent(p, n));
      if (slot && slot.item === 'raw-fish' && nearFire) {
        const lvl = levelForXp(p.skills.cooking);
        const threshold = Math.min(64 + 2 * lvl, 240);
        const r = roll(beacon, pid, 'cook');
        if (r < threshold) {
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

    if (p.action.type === 'attack') {
      const m = s.mobs[p.action.mobId];
      const stats = m && MOB_STATS[m.type];
      if (!m || m.hp <= 0 || !adjacent(p, m)) { p.action = null; continue; }

      const atkLvl = levelForXp(p.skills.attack);
      const T = clamp(128 + 4 * (atkLvl - stats.def), 16, 240);
      if (roll(beacon, pid, 'atk') < T) {
        const maxHit = 1 + Math.floor(atkLvl / 10)
          + (p.equipment.weapon?.item === 'bronze-sword' ? 2 : 0);
        const dmg = 1 + (roll(beacon, pid, 'dmg') % maxHit);
        m.hp -= dmg;
        p.skills.attack += 4 * dmg;
        p.skills.hitpoints += dmg;
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
        const defLvl = levelForXp(p.skills.defence);
        const Tm = clamp(128 + 4 * (stats.atk - defLvl), 16, 240);
        if (roll(beacon, pid, 'mobatk') < Tm) {
          p.hp -= 1 + (roll(beacon, pid, 'mobdmg') % stats.maxHit);
          if (p.hp <= 0) {
            // death (spec §6c): respawn, full hp, inventory destroyed
            const sp = spawnOf(s.genesis);
            p.x = sp.x; p.y = sp.y;
            p.hp = levelForXp(p.skills.hitpoints);
            p.inventory = Array(INV_SLOTS).fill(null);
            p.equipment = { weapon: null }; // the sink spares nothing (§5d)
            p.action = null;
            p.trade = null;
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
    const lvl = levelForXp(p.skills[y.skill]);
    const toolBonus = p.equipment.weapon?.item === TOOL_FOR[n.type] ? 24 : 0;
    const threshold = Math.min(64 + 2 * lvl + toolBonus, 240);
    const r = roll(beacon, pid, 'gather');

    if (r < threshold) {
      p.inventory[slot] = { item: y.item, qty: 1 };
      p.skills[y.skill] += y.xp;
      n.depletedUntil = s.tick + DEPLETE_TICKS;
    }
  }

  return s;
}

module.exports = {
  SPEC_VERSION, TICK_MS, INV_SLOTS,
  XP_TABLE, levelForXp,
  canonical, stateHash, sha256, beaconValue, roll,
  generateIdentity, signInput, verifyInputSig,
  exportIdentity, importIdentity, loadOrCreateIdentity,
  spawnOf, makeGenesis, newWorld, sameWorld, addPlayer, addNode, addMob, nextState, MOB_STATS, RECIPES, EQUIPPABLE,
};
