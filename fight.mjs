// Interval join v0.17: the foreign node — combat variant.
// Same peer model as join.mjs (own node, own keys, no custodian), but the
// example executor here trains combat instead of woodcutting: attack the
// nearest mob, bury the bones it drops, repeat. No fleeing, no banking,
// no eating: with nothing but bones in the inventory, death (SPEC §6c)
// only costs a walk back from spawn, so it's cheaper to just keep
// swinging than to build out food/banking logic to avoid it.
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

// 5. the example executor: spawn, claim name, hunt the nearest live mob
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

const nearestMob = (s, p) => Object.entries(s.mobs)
  .filter(([, m]) => m.hp > 0)
  .sort(([, a], [, b]) => (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y)))[0]

let said = false

client.onTick((s) => {
  const p = client.me
  if (!p) return client.spawn()
  if (NAME && !p.name) return client.claimName(NAME)
  if (!said) { said = true; return client.chat('the interval provides') }
  if (p.action) return

  if (!FIGHT) return  // an idle citizen: present, verifying, sovereign

  // bury bones the instant we're free to act: nothing worth banking, and
  // an empty inventory means a death, if it comes, costs nothing but the
  // walk back from spawn (SPEC §6c)
  const bonesSlot = p.inventory.findIndex(sl => sl?.item === 'bones')
  if (bonesSlot !== -1) return client.bury(bonesSlot)

  const mob = nearestMob(s, p)
  if (!mob) return
  const [id, m] = mob
  if (Math.abs(p.x - m.x) + Math.abs(p.y - m.y) === 1) return client.attack(id)
  step(p, m)
})

setInterval(() => {
  const p = client.me
  if (!p) return
  const maxHp = E.effLevel(p.skills.hitpoints)
  console.log(`tick ${node.state.tick} · (${p.x},${p.y}) · hp ${p.hp}/${maxHp} · atk ${client.level('attack')} · def ${client.level('defence')} · hp-xp lvl ${client.level('hitpoints')} · peers ${client.peers} · flags ${node.divergent.size}`)
}, 6000)
