// Interval v0.6 demo — the full new-player journey + the first trade.
// Alice and Bob exist in genesis with items. Charlie does NOT exist
// anywhere: his node late-joins the running world (corroborated
// checkpoints), then he SPAWNS via a constitutional input, walks, and
// gathers — a complete stranger becoming a citizen of a world already
// in motion. Meanwhile alice and bob execute the first atomic trade.

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'

const SEED = 'interval-genesis-0001'
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const GENESIS = E.makeGenesis(SEED, RULES_HASH, 0)

const alice = E.generateIdentity()
const bob = E.generateIdentity()
const charlie = E.generateIdentity()

function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  E.addPlayer(w, alice.playerId, 5, 4)
  E.addPlayer(w, bob.playerId, 6, 4)
  w.players[alice.playerId].inventory[0] = { item: 'logs', qty: 1 }
  w.players[bob.playerId].inventory[0] = { item: 'ore', qty: 1 }
  E.addNode(w, 'tree-1', 'tree', 8, 4)
  return w
}

const A = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeA' }).start()
const B = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeB' }).start()
await B.dial(A.addr())
const ready = ns => ns.every(n => n.p2p.services.pubsub.getSubscribers(n.topics.inputs).length >= ns.length - 1)
for (let i = 0; i < 100 && !ready([A, B]); i++) await new Promise(r => setTimeout(r, 200))

const pa = new IntervalClient({ node: A, identity: alice })
const pb = new IntervalClient({ node: B, identity: bob })
let nodes = [A, B]
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function tick(actions = async () => {}) {
  await actions()
  await sleep(E.TICK_MS)
  const hashes = await Promise.all(nodes.map(n => n.advanceTick()))
  await sleep(40)
  return new Set(hashes).size === 1
}

console.log(`Interval v0.6 — world ${RULES_HASH.slice(0, 12)}… (third constitution, third world)`)
let ok = true

// ticks 1-2: the first trade
ok &= await tick(() => pa.offerTrade(bob.playerId, 0, 'ore'))
console.log(`tick 1: alice offers her logs for ore (adjacent, so it can settle)`)
ok &= await tick(() => pb.acceptTrade(alice.playerId))
const traded = A.state.players[alice.playerId].inventory[0].item === 'ore'
  && B.state.players[bob.playerId].inventory[0].item === 'logs'
console.log(`tick 2: bob accepts → atomic swap on all nodes: ${traded ? '✓' : '✗'}`)

// tick 3: run one more tick, then charlie's node arrives
ok &= await tick()

console.log('')
console.log(`charlie's node joins the running world…`)
const Cnode = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeC' }).start()
await Cnode.dial(A.addr()); await Cnode.dial(B.addr())
await Cnode.syncFromPeers([A.addr(), B.addr()])
console.log(Cnode.log[Cnode.log.length - 1])
nodes = [A, B, Cnode]
for (let i = 0; i < 100 && !ready(nodes); i++) await sleep(200)

const pc = new IntervalClient({ node: Cnode, identity: charlie })
console.log(`charlie exists in world before spawning: ${pc.me ? 'yes ✗' : 'no ✓'}`)

// tick 4: charlie spawns — a signed constitutional input like any other
ok &= await tick(() => pc.spawn())
console.log(`tick 4: charlie spawns at (${pc.me?.x},${pc.me?.y}) — visible on nodeA too: ${A.state.players[charlie.playerId] ? '✓' : '✗'}`)

// tick 5: names his fresh identity, walks toward the tree
ok &= await tick(() => pc.claimName('charlie'))
console.log(`tick 5: claims name "${A.state.players[charlie.playerId]?.name}" ✓`)
ok &= await tick(() => pc.gather('tree-1'))
for (let t = 0; t < 4; t++) ok &= await tick()
const chLogs = A.state.players[charlie.playerId].inventory.filter(Boolean).length
console.log(`ticks 6-10: charlie chops the tree → ${chLogs} logs (witnessed identically by all ${nodes.length} nodes)`)

console.log('')
const finalTick = A.state.tick
const agree = nodes.every(n => n.myHashes.get(finalTick) === A.myHashes.get(finalTick))
console.log(`all nodes agree at tick ${finalTick}: ${agree && ok ? 'YES ✓' : 'NO ✗'}`)
await Promise.all(nodes.map(n => n.stop()))
process.exit(agree && ok ? 0 : 1)
