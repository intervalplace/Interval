// Interval join v0.17: the foreign node.
// Run this against any pillar's URL and you enter that world as a full
// peer: your OWN node computing every tick, your OWN keys signing every
// action, held locally. No custodian. The pillar can't lie to you,
// divergence detection judges its hashes like anyone else's.
//
//   usage: node join.mjs <world> [name] [--chop]
//   e.g.   node join.mjs interval.place zezima --chop
//
// By default your citizen simply exists: a full peer, verifying every
// tick. Add --chop for the example executor (trains woodcutting and
// banks the logs). A bot and a person enter this world the same way.

import fs from 'fs'
import { multiaddr } from '@multiformats/multiaddr'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { DEFAULT_STARTUP_VERIFY_RECENT_N } from './errors.mjs'
import { IntervalClient } from './sdk.mjs'
import { buildWorld } from './worldgen.mjs'

const ARG = process.argv[2]
const CHOP = process.argv.includes('--chop')
const PORT_ARG = process.argv.find(a => a.startsWith('--port='))
const P2P_PORT = PORT_ARG ? Number(PORT_ARG.split('=')[1]) : 0 // 0 = random; a FIXED port is easier to open in a firewall

const usage = () => {
  console.log('')
  console.log('  usage: node join.mjs [world] <name> [--chop] [--port=N]')
  console.log('')
  console.log('  With no world named, you join interval.place. Name one to go')
  console.log('  anywhere else: this tool has no home world, only a default.')
  console.log('')
  console.log('    node join.mjs zezima                          interval.place')
  console.log('    node join.mjs zezima --chop                   an example executor')
  console.log('    node join.mjs localhost:8787 zezima           a world on this machine')
  console.log('    node join.mjs some.other.place zezima         somebody else\'s world')
  console.log('')
  console.log('  INTERVAL_WORLD=host changes the default.')
  console.log('')
}
if (!ARG || ARG === '--help' || ARG === '-h') { usage(); process.exit(ARG ? 0 : 1) }

// "interval.place" and "localhost:8787" are what a person actually types. Only
// a machine writes the scheme out every time, so fill it in: https for the open
// internet, http for a world running on this machine.
function asWorldUrl(a) {
  let t = String(a).trim().replace(/\/+$/, '')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(t)
    if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(t)) return null
    t = (local ? 'http://' : 'https://') + t
  }
  try { new URL(t); return t } catch { return null }
}

// The world most people mean, so they need not say it. This is a convenience,
// not an authority: interval.place is one world among any number, and every
// other one is reachable by naming it. INTERVAL_WORLD overrides, which is what
// anyone running their own will want.
const DEFAULT_WORLD = process.env.INTERVAL_WORLD || 'interval.place'

let URL_ = asWorldUrl(ARG)
let NAME_ARG = process.argv[3]
if (!URL_) {
  // a bare word is a NAME, and the world is the one we default to
  if (/^[a-z0-9_-]{1,12}$/i.test(ARG)) {
    URL_ = asWorldUrl(DEFAULT_WORLD)
    NAME_ARG = ARG
    console.log('no world named, joining ' + DEFAULT_WORLD
      + ' (name another to go elsewhere)')
  } else {
    console.log('')
    console.log('  "' + ARG + '" is neither a world nor a usable name.')
    console.log('')
    console.log('  A name is up to twelve letters, digits, dashes or underscores.')
    usage()
    process.exit(1)
  }
}
const NAME = (NAME_ARG || '').toLowerCase().replace(/^--.*/, '')
// The name is what YOUR window calls you until the ledger agrees. Claiming a
// name in the world asks for a standing of 50 (SPEC 5a), so a citizen plays
// first and is named afterwards. Say so once, rather than letting someone
// wonder why the hiscores show a key where they typed a word.
if (NAME) console.log('called ' + NAME + ' in this window. A name in the ledger'
  + ' is claimed once and held forever, and asks for a standing of 50: play a'
  + ' while, then claim it.')

// 1. fetch the founding record: from the pillar if it lives, from our
// own cache if it does not. A node that needs the pillar to be BORN
// is sovereign only between restarts.
const host = new URL(URL_).hostname
// a loopback door is only real if the pillar itself is local (our tests);
// otherwise it is proxy poisoning, and dialing it calls our own empty room
const LOCAL_OK = ['localhost', '127.0.0.1', '::1'].includes(host)
const usableDoor = (a) => LOCAL_OK || !(/\/ip4\/127\./.test(a) || /\/ip6\/::1\//.test(a))

// a witness must not die of a wrong number: rude sockets are logged, not fatal
// Most nodes sit behind a router and advertise an address nobody outside can
// dial. Failing to reach one is the ordinary weather of a peer-to-peer world,
// not a fault, and it should not read like one.
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET'])
process.on('uncaughtException', (e) => {
  const code = e?.code ?? e?.message
  if (UNREACHABLE.has(code)) {
    console.log('[net] a peer address would not answer (' + code
      + '). Most nodes are behind a router; the interval continues')
  } else {
    console.log('[net] a connection died rudely (' + code + '); the interval continues')
  }
})
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
// the world is the COMPLETE genesis hash (fix brief §2.1): the rules hash
// only names the constitution; this names the exact founded world we join
const WORLD_ID = E.worldId(info.genesis)
console.log(`world ${WORLD_ID.slice(0, 12)}… (constitution ${info.genesis.rulesHash.slice(0, 12)}…) · joining as a full peer`)

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

// 3b. witness or observer (Milestone 4): pass --witness=identities/w.json
// to attest, IF that key is in the founding witness set. Everyone else is
// an observer: verifying every certified bundle, attesting to none.
const W_ARG = process.argv.find(a => a.startsWith('--witness='))
let witnessKey = null
if (W_ARG) {
  const wk = E.loadOrCreateIdentity(fs, W_ARG.split('=')[1])
  if ((info.genesis.witnesses ?? []).includes(wk.playerId)) {
    witnessKey = wk
    console.log(`witness key accepted: ${wk.playerId.slice(0, 12)}… (in the founding set)`)
  } else console.log(`witness key ${wk.playerId.slice(0, 12)}… is NOT in this world's founding set — joining as observer`)
}

// 4. own node: sync the world, then march in lockstep
let node
try {
  node = await new IntervalNode({ peerKeyFile: 'identities/peer-' + (NAME || 'wanderer') + '.json', genesis: info.genesis, buildWorld, name: 'join', witnessKey,
    safetyDir: witnessKey ? 'witness-safety' : null, // world-namespaced vote lock + frontier (rev5 §1)
    finalityBackend: process.env.INTERVAL_FINALITY_BACKEND || 'sqlite', // SQLite production default (final review §3)
    startupVerifyRecentN: process.env.INTERVAL_STARTUP_VERIFY_RECENT ? Number(process.env.INTERVAL_STARTUP_VERIFY_RECENT) : DEFAULT_STARTUP_VERIFY_RECENT_N, // §2 shared bounded default; env can override
    listen: '/ip4/0.0.0.0/tcp/' + P2P_PORT }).start()
} catch (e) {
  if (e.code === 'ERR_WITNESS_LOCK_HELD') {
    console.error(`\n${e.message}\n\nAnother witness process is already operating this identity. Stop it first.`)
    process.exit(1)
  }
  throw e
}
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
// A mesh that fails silently looks exactly like a mesh with nobody in it. Both
// of these once swallowed their errors, so a pillar too old to know about
// /api/announce produced a node with one peer and no explanation. Say it once,
// then stop saying it: a sweep runs every few seconds and nobody needs that in
// their log forever.
const meshSaid = new Set()
const sayOnce = (k, msg) => { if (!meshSaid.has(k)) { meshSaid.add(k); console.log(msg) } }

async function meshUp() {
  const port = node.listenPort()
  if (!port) return
  // 1. announce our own door: our listening port, paired server-side with the
  //    address the pillar observes us calling from
  try {
    const r = await fetch(URL_ + '/api/announce', {
      method: 'POST', body: JSON.stringify({ peerId: node.peerId(), port }),
    })
    if (r.status === 404) {
      sayOnce('ann404', '[mesh] this pillar does not keep a peer directory (no /api/announce).'
        + ' It is running an older node, so nobody here can find anybody else.'
        + ' Everything still works: gossip relays through the pillar itself.')
      return
    }
    if (!r.ok) sayOnce('annbad', '[mesh] the pillar would not take our announcement (' + r.status + ')')
    else sayOnce('annok', '[mesh] announced our door on tcp/' + port
      + (PORT_ARG ? '' : ' (random: use --port=N and open it inbound to be dialable)'))
  } catch (e) {
    sayOnce('annerr', '[mesh] could not reach the pillar to announce (' + (e.code ?? e.message) + ')')
    return
  }

  // 2. dial every announced door we have not yet knocked on
  let peers = []
  try {
    const res = await fetch(URL_ + '/api/peers')
    if (res.status === 404) {
      sayOnce('px404', '[mesh] this pillar publishes no peer list (no /api/peers)')
      return
    }
    peers = (await res.json()).peers ?? []
  } catch (e) {
    sayOnce('pxerr', '[mesh] could not read the peer list (' + (e.code ?? e.message) + ')')
    return
  }

  const fresh = peers.filter(a => {
    const pid2 = /\/p2p\/(.+)$/.exec(a)?.[1]
    return pid2 && !dialedPeers.has(pid2) && usableDoor(a)
  })
  if (!peers.length) sayOnce('alone', '[mesh] the pillar knows of no other doors yet. '
    + 'You may be the first one here.')

  for (const a of fresh) {
    const pid2 = /\/p2p\/(.+)$/.exec(a)[1]
    dialedPeers.add(pid2)
    try {
      await node.dial(multiaddr(a))
      console.log('[mesh] peer connected: ' + a)
      remember(a)
    } catch (e) {
      dialedPeers.delete(pid2) // try again next sweep
      sayOnce('dial:' + pid2, '[mesh] could not reach ' + a + ' (' + (e.code ?? 'no answer')
        + '). Their port must be open inbound; most nodes are behind a router.')
    }
  }
}
await meshUp()
setInterval(meshUp, 60000)
// sync from whoever is actually alive: a dead pillar's address in the
// list must not crash the resurrection it exists to enable
const syncSources = (pillarUp ? [pillarAddr] : []).concat(book.map(a => multiaddr(a)))
await node.syncFromPeers(syncSources, { allowSingle: true })
console.log(node.log[node.log.length - 1])
node.startTicking()

// Milestone 5: if we drift behind the finalized frontier (stall, missed
// proposals), recover by CERTIFIED replay — every fetched record carries
// its own quorum proof and is recomputed locally before adoption.
if (node.agreement) setInterval(async () => {
  const behind = node.scheduledTick - node.state.tick
  if (behind <= 10 || node.agreement.halted || node._catchingUp) return
  node._catchingUp = true
  try { await node.catchUpFrom(pillarAddr, node.scheduledTick - 1) }
  catch (e) { console.log('[sync] certified catch-up: ' + e.message) }
  node._catchingUp = false
}, 5000)

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
