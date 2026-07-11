// Interval play v0.6 — the human window.
// Interactive terminal client: a solo world you actually play with keys.
//   usage: node play.mjs [name]
//   WASD / arrows: move   g: gather adjacent node   c: cancel/stop   q: quit
// One input per tick (600ms), exactly as the constitution demands — your
// keypress is queued and signed on the next interval. Networked
// interactive play needs the shared tick scheduler (roadmap: v0.7).

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'
import { renderFrame } from './window-term.mjs'

const NAME = (process.argv[2] || '').toLowerCase()
const SEED = 'solo-' + (process.env.INTERVAL_SEED || 'world')
const RULES_HASH = E.sha256(fs.readFileSync(new URL('./SPEC.md', import.meta.url))).toString('hex')
const GENESIS = E.makeGenesis(SEED, RULES_HASH, 0)

// your key is your character — persisted. Delete identities/solo.json
// to be reborn; guard it to stay yourself.
fs.mkdirSync('identities', { recursive: true })
const me = E.loadOrCreateIdentity(fs, 'identities/solo.json')

function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  E.addNode(w, 'tree-1', 'tree', 5, 3)
  E.addNode(w, 'tree-2', 'tree', 10, 5)
  E.addNode(w, 'tree-3', 'tree', 3, 6)
  E.addNode(w, 'rock-1', 'rock', 8, 2)
  E.addNode(w, 'rock-2', 'rock', 12, 6)
  E.addNode(w, 'fish-1', 'fishing-spot', 1, 2)
  E.addNode(w, 'fire-1', 'campfire', 7, 6)
  E.addMob(w, 'gob-1', 'goblin', 11, 3)
  return w
}

const node = await new IntervalNode({
  genesis: GENESIS, buildWorld, name: 'solo',
  checkpointFile: 'checkpoints/solo.json',
})
fs.mkdirSync('checkpoints', { recursive: true })
await node.start()
const client = new IntervalClient({ node, identity: me })

let queued = null
const DIRS = { w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], '\u001b[A': [0, -1], '\u001b[B': [0, 1], '\u001b[D': [-1, 0], '\u001b[C': [1, 0] }

function nearestAdjacentNode() {
  if (!client.me) return null
  return client.nodesAt().find(n =>
    Math.max(Math.abs(n.x - client.me.x), Math.abs(n.y - client.me.y)) <= 1
    && n.depletedUntil <= client.tick)
}

async function act() {
  if (!client.me) return client.spawn()
  if (NAME && !client.me.name && /^[a-z0-9-]{1,12}$/.test(NAME)) return client.claimName(NAME)
  if (!queued) return
  const key = queued; queued = null
  if (DIRS[key]) return client.move(...DIRS[key])
  if (key === 'g') { const n = nearestAdjacentNode(); if (n) return client.gather(n.id) }
  if (key === 'f') { const i = client.me.inventory.findIndex(s => s && s.item === 'raw-fish'); if (i !== -1) return client.cook(i) }
  if (key === 'x') { const m = Object.entries(client.world.mobs).find(([, mob]) => mob.hp > 0 && Math.max(Math.abs(mob.x - client.me.x), Math.abs(mob.y - client.me.y)) <= 1); if (m) return client.attack(m[0]) }
  if (key === 'e') { const i = client.me.inventory.findIndex(s => s && s.item === 'cooked-fish'); if (i !== -1) return client.eat(i) }
  if (key === 'c') return client.stop()
}

async function loop() {
  await act()
  await node.advanceTick()
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
  console.log(renderFrame(client))
  console.log('  wasd/arrows move · g gather · f cook · x attack · e eat · c stop · q quit')
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async (k) => {
    if (k === 'q' || k === '\u0003') { await node.stop(); process.exit(0) }
    queued = k
  })
  setInterval(loop, E.TICK_MS)
} else {
  // headless self-test: spawn, name, walk, gather — then exit
  const script = [null, null, 'd', 'd', 'd', 'g', null, null, null, null]
  for (const k of script) { queued = k; await loop() }
  const p = client.me
  const okay = p && p.name === (NAME || null) || (NAME === '' && p)
  console.log(`self-test: spawned ✓ named:${p?.name ?? '—'} inv:${client.inventoryCount()}`)
  await node.stop()
  process.exit(p ? 0 : 1)
}
