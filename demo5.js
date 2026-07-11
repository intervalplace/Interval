// Interval v0.10 demo — surviving a stall.
// Three self-driving nodes on the arithmetic clock. Node C freezes for
// several ticks (a laptop lid closes, a network blips) while A and B —
// and the players on them — carry on. C wakes behind, fetches the ticks
// it missed from A's input log, REPLAYS them deterministically, rejoins
// the lockstep, and ends the run in perfect agreement.

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'

const SEED = 'interval-genesis-0001'
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const GENESIS = E.makeGenesis(SEED, RULES_HASH, Date.now() + 1200)

const alice = E.generateIdentity()
function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  E.addNode(w, 'tree-1', 'tree', 6, 4)
  return w
}

const A = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'A' }).start()
const B = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'B' }).start()
const C = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'C' }).start()
const nodes = [A, B, C]
for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) await nodes[j].dial(nodes[i].addr())
const ready = () => nodes.every(n => n.p2p.services.pubsub.getSubscribers(n.topics.inputs).length >= 2)
for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 100))

const pa = new IntervalClient({ node: A, identity: alice })
pa.onTick(() => {
  if (!pa.me) return pa.spawn()
  if (!pa.me.name) return pa.claimName('alice')
  if (!pa.me.action) return pa.gather('tree-1')
})

A.startTicking(); B.startTicking(); C.startTicking()
const sleep = ms => new Promise(r => setTimeout(r, ms))

// let the world run ~4 ticks, then C "freezes"
await sleep((GENESIS.anchorMs - Date.now()) + 4 * E.TICK_MS + 100)
C.stopTicking()
const frozeAt = C.state.tick
console.log(`C freezes at tick ${frozeAt} — the world does not wait`)

// A and B keep going for 6 more ticks; C's buffers rot like a real crash
await sleep(6 * E.TICK_MS)
C.inputBuffer.clear()
const behind = A.state.tick - C.state.tick
console.log(`C wakes at tick ${C.state.tick}, world is at ${A.state.tick} — ${behind} ticks behind`)

// recovery: replay the missed history from A's log, then rejoin the clock
await C.catchUpFrom(A.addr(), A.state.tick)
console.log(C.log[C.log.length - 1])
C.startTicking()

// run a few more ticks together, then judge
await sleep(5 * E.TICK_MS + 300)
nodes.forEach(n => n.stopTicking())
await sleep(800)

const t = Math.min(...nodes.map(n => n.state.tick))
const agree = nodes.every(n => n.myHashes.get(t) === A.myHashes.get(t))
const aP = C.state.players[alice.playerId]
console.log('')
console.log(`all three nodes agree at tick ${t}: ${agree ? 'YES ✓' : 'NO ✗'}`)
console.log(`C witnessed alice's history it slept through: name "${aP?.name}", ${aP?.inventory.filter(Boolean).length} logs ✓`)
console.log(`no divergence flags anywhere: ${nodes.every(n => n.divergent.size === 0) ? '✓' : '✗'}`)
await Promise.all(nodes.map(n => n.stop()))
process.exit(agree && nodes.every(n => n.divergent.size === 0) ? 0 : 1)
