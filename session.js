// Interval v0.5 session — a played world, seen through a window.
// Alice "plays" through the SDK on node A: claims her name, walks to a
// tree, chops it. Bob runs a scripted gatherer on node B (a bot — same
// SDK, same rights). The terminal window renders A's view at key ticks.
// Layer check: this file touches the SDK and window only for play and
// rendering; the engine appears solely to set up genesis.

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'
import { renderFrame } from './window-term.mjs'

const SEED = 'interval-genesis-0001'
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const GENESIS = E.makeGenesis(SEED, RULES_HASH, 0)

const alice = E.generateIdentity()
const bob = E.generateIdentity()

function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  E.addPlayer(w, alice.playerId, 2, 4)
  E.addPlayer(w, bob.playerId, 9, 5)
  E.addNode(w, 'tree-1', 'tree', 5, 4)
  E.addNode(w, 'tree-2', 'tree', 11, 2)
  E.addNode(w, 'rock-1', 'rock', 9, 6)
  return w
}

const A = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeA' }).start()
const B = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeB' }).start()
await B.dial(A.addr())
const ready = () => [A, B].every(n =>
  n.p2p.services.pubsub.getSubscribers(n.topics.inputs).length >= 1)
for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 200))

// Layer 2: two clients, two nodes. One is a person, one is a bot.
// The protocol cannot tell and does not care.
const player = new IntervalClient({ node: A, identity: alice })
const bot = new IntervalClient({ node: B, identity: bob })

// alice's "hands": a scripted session standing in for clicks
const session = {
  1: () => player.claimName('alice'),
  2: () => player.move(1, 0),
  3: () => player.move(1, 0),
  4: () => player.gather('tree-1'),   // adjacent now: (4,4) → tree at (5,4)
}

// bob's bot: gather forever, the honest way — through the same SDK
bot.onTick(() => { if (bot.me && !bot.me.action) bot.gather('rock-1') })
if (!bot.me.action) await bot.gather('rock-1')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SHOW = new Set([1, 4, 10, 16])
const TICKS = 16

for (let t = 0; t < TICKS; t++) {
  const tick = A.state.tick
  if (session[tick]) await session[tick]()
  else if (player.me && !player.me.action && tick > 4) await player.gather('tree-1')
  await sleep(E.TICK_MS)
  await Promise.all([A.advanceTick(), B.advanceTick()])
  await sleep(40)
  if (SHOW.has(A.state.tick)) {
    console.log('')
    console.log(renderFrame(player))
  }
}

console.log('')
const agree = A.myHashes.get(TICKS) === B.myHashes.get(TICKS)
console.log(`nodes agree at tick ${TICKS}: ${agree ? 'YES ✓' : 'NO ✗'}`)
console.log(`alice named: ${A.state.players[alice.playerId].name === 'alice' ? '✓' : '✗'}  bob (bot) mined: ${A.state.players[bob.playerId].inventory.filter(Boolean).length} ore through the same SDK`)

await A.stop(); await B.stop()
process.exit(agree ? 0 : 1)
