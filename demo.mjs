// Interval v0.3 network demo.
// Four REAL libp2p nodes on localhost: three honest, one running
// modified rules (double XP cheat). They gossip signed inputs, advance
// the world in lockstep on the 600ms schedule, exchange state hashes,
// and the honest majority flags the cheater automatically.

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'

const TICKS = 12
const SEED = 'interval-genesis-0001'
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const GENESIS = E.makeGenesis(SEED, RULES_HASH, 0)
const WID = E.worldId(GENESIS)

// identities: alice plays via node A, bob plays via node B
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

// the cheater's "modified client": +1000 woodcutting xp to everyone, every tick
const doubleXpCheat = (state) => {
  for (const pid of Object.keys(state.players)) {
    state.players[pid].skills.woodcutting += 1000
  }
  return state
}

const nodes = [
  new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeA' }),
  new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeB' }),
  new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeC' }),
  new IntervalNode({ genesis: GENESIS, buildWorld, name: 'cheat', tamper: doubleXpCheat }),
]

await Promise.all(nodes.map(n => n.start()))
const [A, B, C, X] = nodes

// mesh: everyone dials A, plus B<->C for redundancy
// fully-connected mesh (fine at this scale; gossipsub handles sparse
// meshes at larger scale, but subscription visibility needs direct links)
for (let i = 0; i < nodes.length; i++)
  for (let j = i + 1; j < nodes.length; j++)
    await nodes[j].dial(nodes[i].addr())

// wait until every node actually sees all other peers subscribed to the
// input topic — publishing before the mesh forms silently drops messages
const meshReady = () => nodes.every(n =>
  n.p2p.services.pubsub.getSubscribers(n.topics.inputs).length >= nodes.length - 1)
for (let i = 0; i < 100 && !meshReady(); i++) await new Promise(r => setTimeout(r, 200))
if (!meshReady()) { console.log('mesh failed to form'); process.exit(1) }

console.log(`Interval v0.3 — ${nodes.length} libp2p nodes, world ${RULES_HASH.slice(0, 12)}…`)
console.log(`peers: ${nodes.map(n => `${n.name}=${n.peerId().slice(0, 8)}…`).join(' ')}`)
console.log('')

const sleep = ms => new Promise(r => setTimeout(r, ms))

for (let t = 0; t < TICKS; t++) {
  // players author inputs at their home nodes at the start of the tick
  const tick = A.state.tick
  const aState = A.state.players[alice.playerId]
  const bState = B.state.players[bob.playerId]
  if (!aState.action) {
    await A.submitInput(E.signInput(
      { worldId: WID, tick, playerId: alice.playerId, type: 'gather', nodeId: 'tree-1' }, alice.privateKey))
  }
  if (!bState.action) {
    await B.submitInput(E.signInput(
      { worldId: WID, tick, playerId: bob.playerId, type: 'gather', nodeId: 'rock-1' }, bob.privateKey))
  }

  await sleep(E.TICK_MS) // the interval: inputs propagate during the tick window
  const hashes = await Promise.all(nodes.map(n => n.advanceTick()))
  await sleep(50) // let hash gossip land

  const [hA, hB, hC, hX] = hashes.map(h => h.slice(0, 8))
  console.log(`tick ${String(tick + 1).padStart(2)}  A:${hA} B:${hB} C:${hC} cheat:${hX}  ${hA === hB && hB === hC ? '✓' : '✗ HONEST SPLIT'}${hX !== hA ? '  (cheater diverged)' : ''}`)
}

console.log('')
const honestAgree = A.myHashes.get(TICKS) === B.myHashes.get(TICKS)
  && B.myHashes.get(TICKS) === C.myHashes.get(TICKS)
console.log(`Honest nodes agree after ${TICKS} ticks: ${honestAgree ? 'YES ✓' : 'NO ✗'}`)
console.log(`Cheater flagged by honest nodes:`)
for (const n of [A, B, C]) {
  const flaggedTick = n.divergent.get(X.peerId())
  console.log(`  ${n.name}: ${flaggedTick !== undefined ? `yes, at tick ${flaggedTick} ✓` : 'NO ✗'}`)
}

const a = A.state.players[alice.playerId]
const b = A.state.players[bob.playerId]
const count = inv => inv.filter(Boolean).length
console.log('')
console.log(`world state (honest): alice wc lvl ${E.levelForXp(a.skills.woodcutting)} (${count(a.inventory)} logs), bob mining lvl ${E.levelForXp(b.skills.mining)} (${count(b.inventory)} ore)`)

for (const n of nodes) for (const line of n.log) console.log(line)
await Promise.all(nodes.map(n => n.stop()))

const flaggedByAll = [A, B, C].every(n => n.divergent.has(X.peerId()))
process.exit(honestAgree && flaggedByAll ? 0 : 1)
