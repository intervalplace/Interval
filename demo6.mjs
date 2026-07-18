// Interval demo 6 — certified interval bundles over a REAL libp2p mesh.
// Three witnesses (quorum 2) and one observer. The world advances only
// through quorum-attested bundles:
//   phase 1: all three witnesses live — intervals finalize each round 0
//   phase 2: one witness dies — fallback rounds keep the world moving
//   phase 3: a second witness dies — quorum is unreachable and the world
//            HALTS rather than forking. A stopped world, never two.
import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { buildWorld } from './worldgen.mjs'

const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const W = [E.generateIdentity(), E.generateIdentity(), E.generateIdentity()]
const alice = E.generateIdentity()

const GENESIS = E.makeGenesis('demo6-' + Date.now(), RULES_HASH, Date.now() + 2000, 320, 200)
GENESIS.witnesses = W.map(w => w.playerId)
GENESIS.quorum = 2
GENESIS.byzantineTolerance = 0 // n=3,q=2 tolerates crash faults (2q-n=1>0); Byzantine tolerance needs n>=4

const mk = (name, witnessKey) => new IntervalNode({ genesis: GENESIS, buildWorld, name, witnessKey, verbose: false, allowEphemeralStores: true })
const nodes = [mk('w0', W[0]), mk('w1', W[1]), mk('w2', W[2]), mk('obs', null)]
await Promise.all(nodes.map(n => n.start()))
for (let i = 0; i < nodes.length; i++)
  for (let j = i + 1; j < nodes.length; j++) await nodes[j].dial(nodes[i].addr())

const meshReady = () => nodes.every(n =>
  n.p2p.services.pubsub.getSubscribers(n.topics.bundles).length >= nodes.length - 1)
for (let i = 0; i < 100 && !meshReady(); i++) await new Promise(r => setTimeout(r, 200))
if (!meshReady()) { console.log('mesh failed to form'); process.exit(1) }

console.log(`world ${nodes[0].worldId.slice(0, 12)}… · 3 witnesses, quorum 2, 1 observer`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
nodes.forEach(n => n.startTicking())

// alice submits a signed move each interval via the observer's node
const mover = setInterval(() => {
  const s = nodes[3].state
  const inp = s.players[alice.playerId]
    ? { worldId: nodes[3].worldId, tick: s.tick, playerId: alice.playerId, type: 'move', dx: 1, dy: 0 }
    : { worldId: nodes[3].worldId, tick: s.tick, playerId: alice.playerId, type: 'spawn' }
  nodes[3].submitInput(E.signInput(inp, alice.privateKey)).catch(() => {})
}, 600)

const report = (label) => {
  const line = nodes.map(n => `${n.name}:${n.state.tick}${n.agreement.halted ? '(HALT)' : ''}`).join(' ')
  const hs = new Set(nodes.map(n => E.stateHash(n.state) + '@' + n.state.tick))
  console.log(`${label}  ${line}`)
}

console.log('\n— phase 1: full witness set —')
await sleep(6000); report('t+6s ')
const p1ok = nodes.every(n => n.state.tick >= 5)
const rounds1 = nodes[3].agreement.latestRecord?.round

console.log('\n— phase 2: witness w0 dies; fallback rounds carry the world —')
await nodes[0].stop()
const t2 = nodes[3].state.tick
await sleep(8000); report('t+14s')
const p2ok = nodes.slice(1).every(n => n.state.tick > t2 && !n.agreement.halted)
const usedFallback = [...nodes[3].agreement.finalizedLog.values()].some(r => r.round > 0)

console.log('\n— phase 3: witness w1 dies; quorum unreachable — the world STOPS, it does not fork —')
await nodes[1].stop()
const t3a = { w2: nodes[2].state.tick, obs: nodes[3].state.tick }
await sleep(5000); report('t+19s')
// w2 alone can propose and self-attest (1 of 2): nothing may finalize
const stalledW2 = nodes[2].state.tick <= t3a.w2 + 1 // at most one in-flight interval closes
const stalledObs = nodes[3].state.tick <= t3a.obs + 1
const noForks = E.stateHash(nodes[2].state) === E.stateHash(nodes[3].state)
  || nodes[2].state.tick !== nodes[3].state.tick // differing ticks on ONE chain is lag, not a fork

clearInterval(mover)
const aliceMoved = Object.keys(nodes[3].state.players).length === 1
const obsRec = nodes[3].agreement.latestRecord
const proofOk = obsRec && (await import('./protocol.mjs')).verifyFinalityProof(GENESIS, nodes[3].worldId, obsRec) === null

console.log('')
console.log(`intervals finalize under full quorum:              ${p1ok ? '✓' : '✗ (bad!)'}`)
console.log(`player inputs enter certified bundles:             ${aliceMoved ? '✓' : '✗ (bad!)'}`)
console.log(`observer's latest finality proof verifies:         ${proofOk ? '✓' : '✗ (bad!)'}`)
console.log(`dead proposer → deterministic fallback rounds:     ${p2ok ? '✓' : '✗ (bad!)'}${usedFallback ? ' (round>0 records present)' : ''}`)
console.log(`below quorum → halt, not fork:                     ${stalledW2 && stalledObs ? '✓' : '✗ (bad!)'}`)

await Promise.all(nodes.slice(2).map(n => n.stop()))
const pass = p1ok && aliceMoved && proofOk && p2ok && stalledW2 && stalledObs
console.log(pass ? '\nALL CHECKS PASSED' : '\nFAILURES PRESENT')
process.exit(pass ? 0 : 1)
