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
const PORT_ARG = process.argv.find(a => a.startsWith('--port='))
const P2P_PORT = PORT_ARG ? Number(PORT_ARG.split('=')[1]) : 0 // 0 = random; a FIXED port is easier to open in a firewall
if (!URL_) { console.log('usage: node join.mjs https://host [name] [--chop]'); process.exit(1) }

// 1. fetch the founding record: from the pillar if it lives, from our
// own cache if it does not. A node that needs the pillar to be BORN
// is sovereign only between restarts.
const host = new URL(URL_).hostname
// a loopback door is only real if the pillar itself is local (our tests);
// otherwise it is proxy poisoning, and dialing it calls our own empty room
const LOCAL_OK = ['localhost', '127.0.0.1', '::1'].includes(host)
const usableDoor = (a) => LOCAL_OK || !(/\/ip4\/127\./.test(a) || /\/ip6\/::1\//.test(a))

// a witness must not die of a wrong number: rude sockets are logged, not fatal
process.on('uncaughtException', (e) => console.log('[net] a connection died rudely (' + (e.code ?? e.message) + '); the interval continues'))
process.on('unhandledRejection', (e) => console.log('[net] a promise died rudely (' + (e?.code ?? e?.message ?? e) + '); the interval continues'))
fs.mkdirSync('identities', { recursive: true })
const G_CACHE = `identities/genesis-${host}.json`
const P_BOOK = `identities/peers-${host}.json`
let info
try {
  const res = await fetch(URL_.replace(/\/$/, '') + '/api/genesis')
  info = JSON.parse(await res.text()) // an HTML error page is not a founding
  fs.writeFileSync(G_CACHE, JSON.stringify(info))
} catch {
  try {
    info = JSON.parse(fs.readFileSync(G_CACHE, 'utf8'))
    console.log('[join] pillar unreachable: rising from the cached founding')
  } catch {
    console.log('pillar unreachable, and no cached founding for ' + host + '.')
    console.log('join once while it lives; after that, the cache and the peer book carry you.')
    process.exit(1)
  }
}
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
const me = E.loadOrCreateIdentity(fs, `identities/join-${NAME || 'wanderer'}.json`)
console.log(`your key: ${me.playerId.slice(0, 12)}… (identities/join-${NAME || 'wanderer'}.json: guard it)`)

// 4. own node: sync the world, then march in lockstep
const node = await new IntervalNode({ peerKeyFile: 'identities/peer-' + (NAME || 'wanderer') + '.json', genesis: info.genesis, buildWorld, name: 'join', listen: '/ip4/0.0.0.0/tcp/' + P2P_PORT }).start()
console.log('[join] listening for peers on tcp/' + node.listenPort() + (P2P_PORT ? '' : ' (random; use --port=4601 and open it in your firewall to be dialable)'))

// the peer book: every door we ever opened, remembered on disk
let book = []
try { book = JSON.parse(fs.readFileSync(P_BOOK, 'utf8')).filter(usableDoor) } catch {}
const remember = (a) => {
  if (!usableDoor(a)) return
  if (!book.includes(a)) { book.push(a); book = book.slice(-20); fs.writeFileSync(P_BOOK, JSON.stringify(book)) }
}
let pillarUp = true
try { await node.dial(pillarAddr) } catch {
  pillarUp = false
  console.log('[join] the pillar is not answering; the book remembers ' + book.length + ' door(s)')
}
for (const a of book) {
  try { await node.dial(multiaddr(a)); console.log('[mesh] reconnected from the book: ' + a) } catch {}
}

// ---- the mesh, not the star: dial every peer the pillar knows, and keep
// looking. If the pillar dies, the world keeps talking around the hole.
const dialedPeers = new Set([node.peerId()]) // never dial ourselves
async function meshUp() {
  try {
    // 1. announce our own door: our listening port, paired server-side
    //    with the address the pillar observes us calling from
    const port = node.listenPort()
    if (port) await fetch(URL_ + '/api/announce', {
      method: 'POST',
      body: JSON.stringify({ peerId: node.peerId(), port }),
    }).catch(() => {})
    // 2. dial every announced door we have not yet knocked on
    const r = await fetch(URL_ + '/api/peers').then(x => x.json())
    for (const a of r.peers ?? []) {
      const pid2 = /\/p2p\/(.+)$/.exec(a)?.[1]
      if (!pid2 || dialedPeers.has(pid2) || !usableDoor(a)) continue
      dialedPeers.add(pid2)
      try {
        await node.dial(multiaddr(a))
        console.log('[mesh] peer connected: ' + a)
        remember(a)
      } catch {
        dialedPeers.delete(pid2) // try again next sweep
        console.log('[mesh] could not reach ' + a + ' (firewall? their port must be open inbound)')
      }
    }
  } catch { /* pillar unreachable: the mesh we already have carries on */ }
}
await meshUp()
setInterval(meshUp, 60000)
// sync from whoever is actually alive: a dead pillar's address in the
// list must not crash the resurrection it exists to enable
const syncSources = (pillarUp ? [pillarAddr] : []).concat(book.map(a => multiaddr(a)))
await node.syncFromPeers(syncSources, { allowSingle: true })
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
