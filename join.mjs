// Interval join v0.17: the foreign node.
// Run this against any pillar's URL and you enter that world as a full
// peer: your OWN node computing every tick, your OWN keys signing every
// action, held locally. No custodian. The pillar can't lie to you,
// divergence detection judges its hashes like anyone else's.
//
//   usage: node join.mjs https://host [name] [--chop]
//
// By default your citizen simply exists: a full peer, verifying every
// tick. Add --chop for the example executor (trains woodcutting and
// banks the logs). A bot and a person enter this world the same way.

import fs from 'fs'
import { multiaddr } from '@multiformats/multiaddr'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'
import { buildWorld } from './worldgen.mjs'

const URL_ = process.argv[2]
const NAME = (process.argv[3] || '').toLowerCase().replace(/^--.*/, '')
const CHOP = process.argv.includes('--chop')
if (!URL_) { console.log('usage: node join.mjs https://host [name] [--chop]'); process.exit(1) }

// 1. fetch the founding record
const info = await (await fetch(URL_.replace(/\/$/, '') + '/api/genesis')).json()
const host = new URL(URL_).hostname
const proto = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? 'ip4' : 'dns4' // names resolve via dns4
const pillarAddr = multiaddr(`/${proto}/${host}/tcp/${info.p2pPort}/p2p/${info.peerId}`)
console.log(`world ${info.genesis.rulesHash.slice(0, 12)}… · joining as a full peer`)

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
const me = E.loadOrCreateIdentity(fs, `identities/join-${NAME || 'wanderer'}.json`)
console.log(`your key: ${me.playerId.slice(0, 12)}… (identities/join-${NAME || 'wanderer'}.json: guard it)`)

// 4. own node: sync the world, then march in lockstep
const node = await new IntervalNode({ genesis: info.genesis, buildWorld, name: 'join' }).start()
await node.dial(pillarAddr)
await node.syncFromPeers([pillarAddr], { allowSingle: true })
console.log(node.log[node.log.length - 1])
node.startTicking()

const client = new IntervalClient({ node, identity: me })

// 5. the example executor: spawn, claim name, chop the nearest tree forever
// real pathfinding: breadth-first over the grid, exactly like the web
// window does it. Greedy stepping oscillates around obstacles; BFS does not.
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
  if (!found) return // enclosed for now; trees fall and fires die, paths reopen
  let cur = found, prev = from.get(cur)
  while (prev !== me2.x + ',' + me2.y && prev !== null) { cur = prev; prev = from.get(cur) }
  const [tx, ty] = cur.split(',').map(Number)
  return client.move(Math.sign(tx - me2.x), Math.sign(ty - me2.y))
}
let said = false, burning = false, litAnything = false
const nearest = (s, p, type) => Object.entries(s.nodes)
  .filter(([, n]) => n.type === type && n.depletedUntil <= s.tick)
  .sort(([, a], [, b]) => (Math.abs(a.x - p.x) + Math.abs(a.y - p.y)) - (Math.abs(b.x - p.x) + Math.abs(b.y - p.y)))[0]

client.onTick((s) => {
  const p = client.me
  if (!p) return client.spawn()
  if (NAME && !p.name) return client.claimName(NAME)
  if (!said) { said = true; return client.chat('the interval provides') }
  if (p.action) return

  if (!CHOP) return  // an idle citizen: present, verifying, sovereign

  // chop five, then burn them where you stand: the constitution steps
  // you aside after each fire, so the bot leaves a trail of light
  const logs = p.inventory.map((sl, i) => sl?.item === 'logs' ? i : -1).filter(i => i !== -1)
  if (!burning && logs.length >= 5) {
    burning = true
    if (!litAnything) { litAnything = true; client.chat('let there be light') }
  }
  if (burning) {
    if (!logs.length) { burning = false } // ashes behind us: back to the trees
    else {
      const blockedHere = Object.values(s.nodes).some(n => n.x === p.x && n.y === p.y)
      if (blockedHere) return step(p, { x: p.x + 1, y: p.y + 1 }) // find open ground
      return client.light(logs[0])
    }
  }

  const tree = nearest(s, p, 'tree')
  if (!tree) return
  const [id, t] = tree
  if (Math.abs(p.x - t.x) + Math.abs(p.y - t.y) === 1) return client.gather(id)
  step(p, t)
})

setInterval(() => {
  const p = client.me
  if (!p) return
  const logs = p.inventory.filter(sl => sl?.item === 'logs').length
  console.log(`tick ${node.state.tick} · (${p.x},${p.y}) · wc ${client.level('woodcutting')} · fm ${client.level('firemaking')} · ${logs} logs · peers ${client.peers} · flags ${node.divergent.size}`)
}, 6000)
