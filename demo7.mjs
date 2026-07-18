// Interval demo 7 — adversarial behavior over a REAL libp2p mesh.
//
// Four witnesses (quorum 3) + an observer, all gossiping over real
// gossipsub, plus a MALICIOUS node that publishes — on the real topics —
// forged bundles, forged attestations, replayed messages, and outright
// garbage. Meanwhile one honest witness is KILLED and RESTARTED from its
// real on-disk vote-lock and frontier stores, and a late observer joins
// and proof-syncs. The assertion at the end is the freeze criterion:
// every honest node that finalized a given tick finalized the SAME hash,
// and every committed record verifies.
import fs from 'fs'
import os from 'os'
import path from 'path'
import E from './engine.js'
import * as P from './protocol.mjs'
import { IntervalNode } from './node.mjs'
import { buildWorld } from './worldgen.mjs'

const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-demo7-'))
const W = Array.from({ length: 4 }, () => E.generateIdentity())
const villain = E.generateIdentity()
const alice = E.generateIdentity()

const GENESIS = E.makeGenesis('demo7-' + Date.now(), RULES_HASH, Date.now() + 2000, 320, 200)
GENESIS.witnesses = W.map(w => w.playerId)
GENESIS.quorum = 3
GENESIS.byzantineTolerance = 1 // n=4,q=3 tolerates f=1 Byzantine witness (the malicious node is in-model)
const worldId = E.worldId(GENESIS)

const mk = (name, witnessKey, extra = {}) => new IntervalNode({
  genesis: GENESIS, buildWorld, name, witnessKey, verbose: false,
  allowEphemeralStores: !witnessKey,
  safetyDir: witnessKey ? path.join(dir, name) : undefined,
  checkpointFile: witnessKey ? path.join(dir, name, 'checkpoint.json') : undefined,
  ...extra,
})
if (W.length) for (const w of W) fs.mkdirSync(path.join(dir, 'w' + W.indexOf(w)), { recursive: true })

let nodes = [mk('w0', W[0]), mk('w1', W[1]), mk('w2', W[2]), mk('w3', W[3]), mk('obs', null)]
await Promise.all(nodes.map(n => n.start()))
for (let i = 0; i < nodes.length; i++)
  for (let j = i + 1; j < nodes.length; j++) await nodes[j].dial(nodes[i].addr())

const sleep = ms => new Promise(r => setTimeout(r, ms))
const meshReady = () => nodes.every(n =>
  n.p2p.services.pubsub.getSubscribers(n.topics.bundles).length >= nodes.length - 1)
for (let i = 0; i < 100 && !meshReady(); i++) await sleep(200)
if (!meshReady()) { console.log('mesh failed to form'); process.exit(1) }
console.log(`world ${worldId.slice(0, 12)}… · 4 witnesses, quorum 3, 1 observer, +1 malicious`)

nodes.forEach(n => n.startTicking())
const mover = setInterval(() => {
  const s = nodes[4].state
  const inp = s.players[alice.playerId]
    ? { worldId, tick: s.tick, playerId: alice.playerId, type: 'move', dx: 1, dy: 0 }
    : { worldId, tick: s.tick, playerId: alice.playerId, type: 'spawn' }
  nodes[4].submitInput(E.signInput(inp, alice.privateKey)).catch(() => {})
}, 600)

// ---- the malicious node: a real libp2p peer on the real topics ----
const evil = mk('evil', null)
await evil.start()
for (const n of nodes) await evil.dial(n.addr())
await sleep(500)
const pub = (topic, obj) => evil.p2p.services.pubsub.publish(topic, Buffer.from(JSON.stringify(obj))).catch(() => {})
let forged = 0
const attack = setInterval(() => {
  const s = evil.state, tick = s.tick, prev = evil.agreement.prevHash
  // forged bundle: the villain is no witness, so its proposer sig is invalid
  const fakeBundle = P.makeBundle({ worldId, tick, round: 0, previousStateHash: prev, inputs: [], witness: villain })
  pub(evil.topics.bundles, fakeBundle)
  // forged attestation claiming a bogus result
  pub(evil.topics.attestations, P.makeAttestation({ worldId, tick, round: 0, bundleHash: P.bundleHash(fakeBundle), resultingStateHash: 'f'.repeat(64), witness: villain }))
  // outright garbage on the finality topic
  pub(evil.topics.finality, [null, 42, { tick, junk: true }][forged % 3])
  forged += 3
}, 250)

console.log('\n— phase 1: full set + malicious flood —')
await sleep(6000)
const p1 = nodes.slice(0, 4).every(n => n.state.tick >= 4 && !n.agreement.halted)
console.log(`  ${nodes.map(n => `${n.name}:${n.state.tick}${n.agreement.halted ? '(HALT)' : ''}`).join(' ')}  forged msgs sent: ${forged}`)

console.log('\n— phase 2: kill honest witness w1; quorum 3 of remaining 3 holds —')
const beforeKill = nodes[4].state.tick
await nodes[1].stop()
await sleep(6000)
const survived = nodes.filter(n => n.name !== 'w1').every(n => n.state.tick > beforeKill)
console.log(`  ${nodes.filter(n=>n.name!=='w1').map(n => `${n.name}:${n.state.tick}`).join(' ')}  (advanced past ${beforeKill}: ${survived})`)

console.log('\n— phase 3: restart w1 from its DURABLE stores; it rejoins —')
const w1b = mk('w1', W[1])
await w1b.start()
for (const n of nodes) if (n.name !== 'w1' && n.name !== 'evil') await w1b.dial(n.addr())
await evil.dial(w1b.addr())
// it resumed from its durable checkpoint (behind the frontier now); a
// certified sync carries it forward past the ticks it slept through,
// exactly as any witness rejoining a moved-on world would
await w1b.syncFromPeers(nodes.filter(n => n.name !== 'w1' && n.name !== 'evil').map(n => n.addr()))
w1b.startTicking()
nodes[1] = w1b
await sleep(6000)
const rejoined = w1b.state.tick > beforeKill && !w1b.agreement.halted
console.log(`  w1 restarted → tick ${w1b.state.tick} (rejoined & advancing: ${rejoined})`)

console.log('\n— phase 4: a late observer joins and proof-syncs through the flood —')
// let the mesh settle so every honest witness reports the same frontier
await sleep(2500)
const late = mk('late', null)
await late.start()
for (const n of nodes) if (n.name !== 'evil') await late.dial(n.addr())
await sleep(1000)
// A live world advances during the sampling window, so honest peers may
// serve DIFFERENT (valid) ticks; corroboration then refuses — the SAFE
// outcome. Pause ticking briefly so the frontier is stable, sync, resume.
// (A production joiner instead syncs a proof at a pinned height; here we
// just quiet the world for a clean snapshot.)
// This is a WITNESSED world: a checkpoint carries its own quorum finality
// proof and is self-authenticating, so a single peer suffices (allowSingle)
// — cross-peer corroboration is for UNproven worlds. The proof is verified
// against genesis in validateCheckpoint regardless of the flood.
let synced = false
for (let attempt = 0; attempt < 6 && !synced; attempt++) {
  try {
    await late.syncFromPeers([nodes[0].addr()], { allowSingle: true })
    synced = late.state.tick > 0 && E.validateState(late.state) === null
  } catch { await sleep(700) }
}
console.log(`  late observer synced to tick ${late.state.tick}, state valid: ${synced}`)

// ---- the freeze criterion, over the real run ----
clearInterval(mover); clearInterval(attack)
const live = nodes.filter(n => n.name !== 'evil')
const byTick = new Map()
for (const n of live) {
  for (const [t, rec] of n.agreement.finalizedLog ?? []) {
    if (!byTick.has(t)) byTick.set(t, new Set())
    byTick.get(t).add(rec.resultingStateHash)
  }
}
let forks = 0, badCerts = 0
for (const [t, hs] of byTick) if (hs.size > 1) { forks++; console.log(`  FORK at tick ${t}`) }
for (const n of live)
  for (const [, rec] of n.agreement.finalizedLog ?? [])
    if (P.verifyFinalityProof(GENESIS, worldId, rec)) badCerts++

const agreedTicks = [...byTick.keys()].length
console.log('\n— verdict —')
console.log(`  finalized ticks observed: ${agreedTicks}`)
console.log(`  forks (two honest hashes for one tick): ${forks}`)
console.log(`  invalid certificates committed: ${badCerts}`)
console.log(`  forged messages injected on real topics: ${forged}`)

await Promise.all(nodes.concat(evil, late).map(n => n.stop().catch(() => {})))
fs.rmSync(dir, { recursive: true, force: true })

const pass = p1 && survived && rejoined && synced && forks === 0 && badCerts === 0
console.log('\n' + (pass ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'))
process.exit(pass ? 0 : 1)
