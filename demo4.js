// Interval v0.7 demo — the shared clock + persistent identity.
// No external tick driver anywhere: both nodes compute the schedule from
// genesis (anchorMs + N*600) and advance INDEPENDENTLY. Players act via
// onTick through the SDK, like a real interactive client would. If the
// arithmetic clock works, two self-driving nodes stay in perfect lockstep.
// Also: bob's identity is saved and reloaded — same key, same character.

import fs from 'fs'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { IntervalClient } from './sdk.mjs'

const SEED = 'interval-genesis-0001'
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex')
const anchorMs = Date.now() + 1500  // tick 0 begins shortly; both nodes derive everything from this
const GENESIS = E.makeGenesis(SEED, RULES_HASH, anchorMs)

// persistent identity: bob is loaded from disk if he exists
fs.mkdirSync('identities', { recursive: true })
const alice = E.generateIdentity()
const firstRun = !fs.existsSync('identities/bob.json')
const bob = E.loadOrCreateIdentity(fs, 'identities/bob.json')
console.log(`bob's identity: ${firstRun ? 'created' : 'LOADED FROM DISK'} (${bob.playerId.slice(0, 8)}…)`)

function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  E.addNode(w, 'tree-1', 'tree', 6, 4)
  E.addNode(w, 'rock-1', 'rock', 8, 4)
  return w
}

const A = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeA' }).start()
const B = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'nodeB' }).start()
await B.dial(A.addr())
const ready = () => [A, B].every(n => n.p2p.services.pubsub.getSubscribers(n.topics.inputs).length >= 1)
for (let i = 0; i < 100 && !ready(); i++) await new Promise(r => setTimeout(r, 100))

const pa = new IntervalClient({ node: A, identity: alice })
const pb = new IntervalClient({ node: B, identity: bob })

// interactive-style play: clients react on their own node's heartbeat
pa.onTick(() => {
  if (!pa.me) return pa.spawn()
  if (!pa.me.name) return pa.claimName('alice')
  if (!pa.me.action) return pa.gather('tree-1')
})
pb.onTick(() => {
  if (!pb.me) return pb.spawn()
  if (!pb.me.action) return pb.gather('rock-1')
})

// let go of the wheel: the clock is arithmetic now
A.startTicking()
B.startTicking()

const TICKS = 10
await new Promise(r => setTimeout(r, (anchorMs - Date.now()) + TICKS * E.TICK_MS + 400))
A.stopTicking(); B.stopTicking()
await new Promise(r => setTimeout(r, 700))

const t = Math.min(A.state.tick, B.state.tick)
const agree = A.myHashes.get(t) === B.myHashes.get(t)
console.log(`self-driving nodes reached tick ${A.state.tick}/${B.state.tick}, agree at tick ${t}: ${agree ? 'YES ✓' : 'NO ✗'}`)
const aP = A.state.players[alice.playerId], bP = A.state.players[bob.playerId]
console.log(`alice: named "${aP?.name}", ${aP?.inventory.filter(Boolean).length ?? 0} logs · bob: ${bP?.inventory.filter(Boolean).length ?? 0} ore`)
console.log(`run demo4 again: bob will return with the SAME playerId — same character, forever`)
await A.stop(); await B.stop()
process.exit(agree ? 0 : 1)
