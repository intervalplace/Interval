// Interval v0.4 demo — names, persistence, late join.
// Three nodes run the world. Alice claims the name "alice"; Bob tries to
// steal it and is refused by the constitution. Checkpoints persist to
// disk every tick. At tick 6 a brand-new node joins mid-world: it fetches
// checkpoints from two peers, corroborates them, adopts the state, and
// from then on computes hashes identical to everyone else's.

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'

const SEED = 'interval-genesis-0001'
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const GENESIS = E.makeGenesis(SEED, RULES_HASH, 0)

const alice = E.generateIdentity()
const bob = E.generateIdentity()

function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  E.addPlayer(w, alice.playerId, 5, 5)
  E.addPlayer(w, bob.playerId, 8, 5)
  E.addNode(w, 'tree-1', 'tree', 6, 5)
  E.addNode(w, 'rock-1', 'rock', 8, 6)
  return w
}

fs.mkdirSync('checkpoints', { recursive: true })
const mk = (name) => new IntervalNode({
  genesis: GENESIS, buildWorld, name,
  checkpointFile: `checkpoints/${name}.json`,
})

// clean slate for the demo
for (const f of fs.readdirSync('checkpoints')) fs.unlinkSync(`checkpoints/${f}`)

const A = await mk('nodeA').start()
const B = await mk('nodeB').start()
const C = await mk('nodeC').start()
let nodes = [A, B, C]

for (let i = 0; i < nodes.length; i++)
  for (let j = i + 1; j < nodes.length; j++)
    await nodes[j].dial(nodes[i].addr())

const meshReady = (ns) => ns.every(n =>
  n.p2p.services.pubsub.getSubscribers(n.topics.inputs).length >= ns.length - 1)
for (let i = 0; i < 100 && !meshReady(nodes); i++) await new Promise(r => setTimeout(r, 200))
if (!meshReady(nodes)) { console.log('mesh failed'); process.exit(1) }

console.log(`Interval v0.4 — world ${RULES_HASH.slice(0, 12)}… (new constitution, new world)`)
console.log('')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function runTick() {
  const tick = A.state.tick
  // scripted play: gathering as usual + name events at specific ticks
  const aP = A.state.players[alice.playerId]
  const bP = B.state.players[bob.playerId]
  if (tick === 1) {
    await A.submitInput(E.signInput({ tick, playerId: alice.playerId, type: 'claim_name', name: 'alice' }, alice.privateKey))
  } else if (!aP.action) {
    await A.submitInput(E.signInput({ tick, playerId: alice.playerId, type: 'gather', nodeId: 'tree-1' }, alice.privateKey))
  }
  if (tick === 3) {
    // bob tries to take alice's name — the constitution says no
    await B.submitInput(E.signInput({ tick, playerId: bob.playerId, type: 'claim_name', name: 'alice' }, bob.privateKey))
  } else if (!bP.action) {
    await B.submitInput(E.signInput({ tick, playerId: bob.playerId, type: 'gather', nodeId: 'rock-1' }, bob.privateKey))
  }
  await sleep(E.TICK_MS)
  const hashes = await Promise.all(nodes.map(n => n.advanceTick()))
  await sleep(50)
  const short = hashes.map(h => h.slice(0, 8))
  const agree = new Set(hashes).size === 1
  console.log(`tick ${String(tick + 1).padStart(2)}  ${nodes.map((n, i) => `${n.name}:${short[i]}`).join(' ')}  ${agree ? '✓' : '✗ SPLIT'}`)
}

for (let t = 0; t < 6; t++) await runTick()

console.log('')
console.log(`names after tick 6: ${JSON.stringify(A.state.names)}`)
console.log(`  → "alice" owned by ${A.state.names['alice'] === alice.playerId ? 'alice ✓' : 'WRONG PLAYER ✗'}, bob's steal attempt refused: ${A.state.players[bob.playerId].name === null ? '✓' : '✗'}`)
console.log(`disk checkpoint exists: ${fs.existsSync('checkpoints/nodeA.json') ? '✓' : '✗'} (tick ${JSON.parse(fs.readFileSync('checkpoints/nodeA.json')).tick})`)
console.log('')

// ---- LATE JOIN: node D was never here. It syncs mid-world. ----
console.log('nodeD joining mid-world…')
const D = await mk('nodeD').start()
await D.dial(A.addr()); await D.dial(B.addr()); await D.dial(C.addr())
const joinTick = await D.syncFromPeers([A.addr(), B.addr()])
console.log(D.log[D.log.length - 1])
nodes = [A, B, C, D]
for (let i = 0; i < 100 && !meshReady(nodes); i++) await new Promise(r => setTimeout(r, 200))

for (let t = 0; t < 6; t++) await runTick()

console.log('')
const finalTick = A.state.tick
const allAgree = nodes.every(n => n.myHashes.get(finalTick) === A.myHashes.get(finalTick))
const dSeesNames = D.state.names['alice'] === alice.playerId
console.log(`all 4 nodes agree at tick ${finalTick} (incl. late joiner): ${allAgree ? 'YES ✓' : 'NO ✗'}`)
console.log(`nodeD inherited full history it never witnessed (names intact): ${dSeesNames ? '✓' : '✗'}`)
const a = A.state.players[alice.playerId]
console.log(`alice ("${a.name}"): wc lvl ${E.levelForXp(a.skills.woodcutting)}, ${a.inventory.filter(Boolean).length} logs`)

await Promise.all(nodes.map(n => n.stop()))
process.exit(allAgree && dSeesNames ? 0 : 1)
