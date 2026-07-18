// Interval join v0.17: the foreign node — combat variant.
// Same peer model as join.mjs (own node, own keys, no custodian), but the
// example executor here trains combat instead of woodcutting: hunt the
// best available mob, walk over and collect what it drops (SPEC §6e:
// drops are ground items now, not auto-inventory), wear any armor/sword
// picked up, bury bones for prayer XP, repeat. Still no fleeing, no
// banking of anything else, no eating: with nothing valuable staying in
// the inventory beyond what's worn, death (§6c) only costs a walk back
// from spawn, so it's cheaper to keep swinging than to build out
// avoidance logic.
//
//   usage: node fight.mjs https://host [name] [--fight]
//
// By default your citizen simply exists: a full peer, verifying every
// tick. Add --fight for the combat executor.

import fs from 'fs'
import { multiaddr } from '@multiformats/multiaddr'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'
import { buildWorld } from './worldgen.mjs'

const URL_ = process.argv[2]
const NAME = (process.argv[3] || '').toLowerCase().replace(/^--.*/, '')
const FIGHT = process.argv.includes('--fight')
if (!URL_) { console.log('usage: node fight.mjs https://host [name] [--fight]'); process.exit(1) }

// 1. fetch the founding record
const info = await (await fetch(URL_.replace(/\/$/, '') + '/api/genesis')).json()
const host = new URL(URL_).hostname
const proto = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'ip4' : 'dns4' // names resolve via dns4
const pillarAddr = multiaddr(`/${proto}/${host}/tcp/${info.p2pPort}/p2p/${info.peerId}`)
console.log(`world ${E.worldId(info.genesis).slice(0, 12)}… · joining as a full peer`)

// 2. verify we run the same constitution before anything else
const myRulesHash = E.sha256(fs.readFileSync(new URL('./SPEC.md', import.meta.url))).toString('hex')
if (myRulesHash !== info.genesis.rulesHash) {
  console.log('constitution mismatch: their world runs different rules than your SPEC.md')
  console.log(`  theirs: ${info.genesis.rulesHash.slice(0, 16)}…  yours: ${myRulesHash.slice(0, 16)}…`)
  console.log('pull the matching version, or found your own world.')
  process.exit(1)
}

// 3. your key IS your character: generated and held HERE, never sent
fs.mkdirSync('identities', { recursive: true })
const me = E.loadOrCreateIdentity(fs, `identities/fight-${NAME || 'wanderer'}.json`)
console.log(`your key: ${me.playerId.slice(0, 12)}… (identities/fight-${NAME || 'wanderer'}.json: guard it)`)

// 4. own node: sync the world, then march in lockstep
const node = await new IntervalNode({ genesis: info.genesis, buildWorld, name: 'fight' }).start()
await node.dial(pillarAddr)
await node.syncFromPeers([pillarAddr], { allowSingle: true })
console.log(node.log[node.log.length - 1])
node.startTicking()

const client = new IntervalClient({ node, identity: me })

// 5. the example executor: spawn, claim name, hunt the best live mob
// forever. Real pathfinding: breadth-first over the grid, exactly like
// the web window does it (and identical to join.mjs's --chop walker).
const step = (me2, goal, reach = true) => {
  const W = info.genesis.worldW, H = info.genesis.worldH
  const s = node.state
  const blocked = new Set(Object.values(s.nodes).map(n => n.x + ',' + n.y))
  const goals = new Set()
  if (reach) {
    for (const [mx, my] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const gx = goal.x + mx, gy = goal.y + my
      if (gx >= 0 && gx < W && gy >= 0 && gy < H && !blocked.has(gx + ',' + gy)) goals.add(gx + ',' + gy)
    }
  } else goals.add(goal.x + ',' + goal.y)
  if (goals.has(me2.x + ',' + me2.y)) return
  const from = new Map([[me2.x + ',' + me2.y, null]])
  const q = [[me2.x, me2.y]]
  let found = null
  while (q.length && !found) {
    const [cx2, cy2] = q.shift()
    for (const [mx, my] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx2 + mx, ny = cy2 + my, k = nx + ',' + ny
      if (nx < 0 || nx >= W || ny < 0 || ny >= H || blocked.has(k) || from.has(k)) continue
      from.set(k, cx2 + ',' + cy2)
      if (goals.has(k)) { found = k; break }
      q.push([nx, ny])
    }
  }
  if (!found) return // enclosed for now; mobs wander and paths reopen
  let cur = found, prev = from.get(cur)
  while (prev !== me2.x + ',' + me2.y && prev !== null) { cur = prev; prev = from.get(cur) }
  const [tx, ty] = cur.split(',').map(Number)
  return client.move(Math.sign(tx - me2.x), Math.sign(ty - me2.y))
}

// at higher attack/defence, hit-chance vs weaker mobs is already capped and
// their retaliation is already floored (SPEC §6b's clamp(128±4*delta,16,240)
// saturates fast), so there's no real safety reason left to fight goblins
// over trolls/bears — only a strictly worse XP/kill and worse drop table.
// Rank by mob "value" first, distance second, instead of pure nearest.
const MOB_PRIORITY = { troll: 4, bear: 3, wolf: 2, goblin: 1 }

const nearestMob = (s, p) => Object.entries(s.mobs)
  .filter(([, m]) => m.hp > 0)
  .sort(([, a], [, b]) => {
    const byValue = MOB_PRIORITY[b.type] - MOB_PRIORITY[a.type]
    if (byValue !== 0) return byValue
    return (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y))
  })[0]

// SPEC §6e: kills leave ground items on the mob's tile instead of landing
// in the killer's inventory, and they expire (100 ticks, ~60s) if nobody
// walks over and picks them up. Look only nearby — our own kill's loot is
// always within a step or two — so we don't send the bot on cross-map
// scavenger hunts for other players' drops.
const PICKUP_RADIUS = 4
const nearestGround = (s, p) => Object.entries(s.ground)
  .sort(([, a], [, b]) =>
    (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y)))
  .find(([, g]) => Math.abs(g.x - p.x) + Math.abs(g.y - p.y) <= PICKUP_RADIUS)

// wield gear as soon as we're carrying it, but only where it's an
// unambiguous upgrade: helm/plate just fill an empty slot (pure armor
// soak, §6i), while sword is the only weapon-slot item worth auto-wearing
// — hatchet/pickaxe map to the same weapon slot and would silently cost
// us the sword's +2 max hit for a gathering bonus this bot never uses.
const wieldUpgrade = (p) => {
  if (!p.equipment.head) {
    const s = p.inventory.findIndex(sl => sl?.item === 'bronze-helm')
    if (s !== -1) return s
  }
  if (!p.equipment.body) {
    const s = p.inventory.findIndex(sl => sl?.item === 'bronze-plate')
    if (s !== -1) return s
  }
  if (p.equipment.weapon?.item !== 'bronze-sword') {
    const s = p.inventory.findIndex(sl => sl?.item === 'bronze-sword')
    if (s !== -1) return s
  }
  return -1
}

let said = false

client.onTick((s) => {
  const p = client.me
  if (!p) return client.spawn()
  if (NAME && !p.name) return client.claimName(NAME)
  if (!said) { said = true; return client.chat('the interval provides') }
  if (p.action) return

  if (!FIGHT) return  // an idle citizen: present, verifying, sovereign

  // 1. wear any armor/sword we're holding but not already wearing
  const wSlot = wieldUpgrade(p)
  if (wSlot !== -1) return client.wield(wSlot)

  // 2. bury bones the instant we're carrying them: nothing worth banking,
  // and an inventory with nothing but worn gear means a death, if it
  // comes, costs nothing but the walk back from spawn (§6c)
  const bonesSlot = p.inventory.findIndex(sl => sl?.item === 'bones')
  if (bonesSlot !== -1) return client.bury(bonesSlot)

  // 3. collect anything our (or a nearby) kill left on the ground before
  // it expires — walk onto the tile (pickup requires standing on it, not
  // just being adjacent) and take it
  if (firstFreeSlot(p.inventory) !== -1) {
    const ground = nearestGround(s, p)
    if (ground) {
      const [gid, g] = ground
      if (p.x === g.x && p.y === g.y) return client.pickup(gid)
      return step(p, g, false)
    }
  }

  // 4. otherwise hunt the best available mob
  const mob = nearestMob(s, p)
  if (!mob) return
  const [id, m] = mob
  if (Math.abs(p.x - m.x) + Math.abs(p.y - m.y) === 1) return client.attack(id)
  step(p, m)
})

function firstFreeSlot(inv) {
  return inv.findIndex(sl => sl === null)
}

setInterval(() => {
  const p = client.me
  if (!p) return
  const maxHp = E.effLevel(p.skills.hitpoints)
  console.log(`tick ${node.state.tick} · (${p.x},${p.y}) · hp ${p.hp}/${maxHp} · atk ${client.level('attack')} · def ${client.level('defence')} · prayer ${client.level('prayer')} · gear ${p.equipment.weapon?.item ?? '-'}/${p.equipment.head?.item ?? '-'}/${p.equipment.body?.item ?? '-'} · peers ${client.peers} · flags ${node.divergent.size}`)
}, 6000)
