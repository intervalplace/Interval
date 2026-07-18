// Interval serve v0.9 — the browser bridge.
// Runs a solo world node + a WebSocket bridge + serves the reference
// graphical window. The browser is a pure layer-3 window: it receives
// state each tick and sends intents; the bridge signs them with the
// local identity (browser-side keys arrive with the light-client
// milestone — for localhost this custody model is honest).
//   usage: node serve.mjs [name]   then open http://localhost:8787

import fs from 'fs'
import http from 'http'
import { WebSocketServer } from 'ws'
import E from './engine.js'
import { IntervalNode } from './node.mjs'
import { DEFAULT_STARTUP_VERIFY_RECENT_N } from './errors.mjs'
import { IntervalClient } from './sdk.mjs'
import { buildWorld } from './worldgen-any.mjs'

const SEED = 'solo-' + (process.env.INTERVAL_SEED || 'world')
const RULES_HASH = E.sha256(fs.readFileSync(new URL('./SPEC.md', import.meta.url))).toString('hex')
const WORLD_W = 320, WORLD_H = 200 // epic geography (spec 2b): calibrated travel + Norwick
const WORLD_FILE = 'checkpoints/world.json'   // the founding record
const CP_FILE = 'checkpoints/web.json'        // the living state

fs.mkdirSync('identities', { recursive: true })
fs.mkdirSync('checkpoints', { recursive: true })

const P2P_PORT = Number(process.env.INTERVAL_P2P_PORT || 4600)

// ---- persistence across restarts and updates ----
// Same rules → resume the same world from checkpoint.
// Changed rules → found a NEW world whose genesis imports the citizens.
const KNOWN_ITEMS = E.ITEMS // ONE constitutional item registry (rev5 §4) — engine, validator, and imports all share it
const announced = new Map() // peerId -> { addr, at }: the mesh directory
let GENESIS, migrated = 0
const saved = fs.existsSync(WORLD_FILE) ? JSON.parse(fs.readFileSync(WORLD_FILE)) : null
let savedCp = null
try { if (fs.existsSync(CP_FILE)) savedCp = JSON.parse(fs.readFileSync(CP_FILE)) } catch {}

// ---- the founding witness (fix brief Milestone 4, Phase 9) ----
// The pillar is a witness, not an authority: it proposes and attests to
// interval bundles like any other witness. Its witness key is a founding
// fact — listed in genesis, immutable for this world. Extra witnesses
// and the quorum can be set at founding via env:
//   INTERVAL_WITNESSES=pub1,pub2   INTERVAL_QUORUM=2
const WITNESS = E.loadOrCreateIdentity(fs, 'identities/witness-pillar.json')
const EXTRA_WITNESSES = (process.env.INTERVAL_WITNESSES || '').split(',').map(s => s.trim()).filter(s => /^[0-9a-f]{64}$/.test(s))

// ---- founding vs resuming (fix brief §2.4) ----
// Genesis is consensus identity and is IMMUTABLE after founding. We resume
// the same world only if the rules, the seed, and the clock all still fit.
// A long sleep no longer rebases anchorMs (that mutated the world's
// identity in place); it founds a NEW world — new anchor, new worldId —
// whose genesis imports the citizens.
const REFOUND_GAP = 3000 // ticks (~30 min): beyond this, empty-tick replay is not worth it
const cpTick = Number.isInteger(savedCp?.tick) ? savedCp.tick : 0
const cpValidFor = (g) => savedCp && savedCp.worldId === E.worldId(g)
  && E.canonical(savedCp.state?.genesis) === E.canonical(g)
  && E.stateHash(savedCp.state) === savedCp.stateHash
const gapOf = (g) => Math.floor((Date.now() - g.anchorMs) / E.TICK_MS) - cpTick

const canResume = saved
  && saved.genesis.rulesHash === RULES_HASH
  && saved.genesis.genesisSeed === SEED
  && Array.isArray(saved.genesis.witnesses)              // pre-witness worlds refound as witnessed ones
  && saved.genesis.witnesses.includes(WITNESS.playerId)  // our witness key must be a founding witness
  && (!savedCp || cpValidFor(saved.genesis))    // an alien/corrupt checkpoint is not this world
  && gapOf(saved.genesis) <= REFOUND_GAP

if (canResume) {
  GENESIS = saved.genesis
} else {
  GENESIS = E.makeGenesis(SEED, RULES_HASH, Date.now(), WORLD_W, WORLD_H)
  // the founding witness set (Milestone 4): immutable for this world; a
  // different witness configuration is a different world (Phase 9)
  GENESIS.witnesses = [WITNESS.playerId, ...EXTRA_WITNESSES.filter(w => w !== WITNESS.playerId)]
  const nWit = GENESIS.witnesses.length
  // Byzantine Safety Upgrade: the constitution fixes an explicit fault
  // threshold f. Default to the maximum this witness set can tolerate,
  // floor((n-1)/3); the quorum is then the safe minimum 2f+1 unless an
  // explicit (larger, still valid) quorum is requested.
  GENESIS.byzantineTolerance = Number.isInteger(Number(process.env.INTERVAL_FAULT_TOLERANCE))
    ? Number(process.env.INTERVAL_FAULT_TOLERANCE)
    : E.maxByzantine(nWit)
  const fWit = GENESIS.byzantineTolerance
  GENESIS.quorum = Math.max(E.minQuorumFor(nWit, fWit),
    Math.min(nWit, Number(process.env.INTERVAL_QUORUM) || 0))
  // The world is founded Byzantine-safe or not at all (n>=3f+1, q>=2f+1,
  // 2q-n>f): an unsafe configuration is refused at founding, not discovered
  // at forking.
  if (!E.byzantineSafe(nWit, GENESIS.quorum, fWit)) {
    console.error(`refusing to found a Byzantine-unsafe world: n=${nWit}, q=${GENESIS.quorum}, f=${fWit} — need n>=3f+1, q>=2f+1, 2q-n>f`)
    process.exit(1)
  }
  const old = savedCp?.state ?? (savedCp === null && saved && fs.existsSync(CP_FILE)
    ? (() => { try { return JSON.parse(fs.readFileSync(CP_FILE)).state } catch { return null } })() : null)
  if (old?.players) {
    // the founding carries everyone who LIVED: a name, any xp beyond
    // birth, anything owned. Pure ghosts (spawned once, did nothing,
    // never returned) rest in the old world's history.
    const lived = (p) => p.name
      || Object.entries(p.skills).some(([k, xp]) => k !== 'hitpoints' ? xp > 0 : xp > 1154)
      || (p.inventory ?? []).some(Boolean)
      || Object.keys(p.bank ?? {}).length > 0
      || p.equipment?.weapon
    // imports are FOUNDING data: they live inside the genesis, the worldId
    // commits to them, and worldgen applies them on every node identically
    GENESIS.imported = Object.entries(old.players).filter(([, p]) => lived(p)).map(([pid, p]) => ({
      pid, skills: p.skills, name: E.isValidName(p.name) ? p.name : null, // constitutional or nothing (rev5 §3) hp: p.hp,
      bank: Object.fromEntries(Object.entries(p.bank ?? {}).filter(([it]) => KNOWN_ITEMS.has(it))),
      inventory: (p.inventory ?? []).filter(sl => sl && KNOWN_ITEMS.has(sl.item)),
      weapon: p.equipment?.weapon && KNOWN_ITEMS.has(p.equipment.weapon.item) ? p.equipment.weapon : null,
    }))
    migrated = GENESIS.imported.length
  }
  fs.rmSync(CP_FILE, { force: true })
  fs.writeFileSync(WORLD_FILE, JSON.stringify({ genesis: GENESIS }))
}

let node
try {
  node = await new IntervalNode({ peerKeyFile: 'identities/peer-pillar.json',
    genesis: GENESIS, buildWorld, name: 'web', checkpointFile: CP_FILE,
    witnessKey: WITNESS,                      // the pillar proposes and attests
    safetyDir: 'witness-safety',              // world-namespaced vote lock + frontier (rev5 §1)
    finalityBackend: process.env.INTERVAL_FINALITY_BACKEND || 'sqlite', // SQLite is the production default (final review §3); set 'flatfile' for the dev/compat backend
    checkpointInterval: Number(process.env.INTERVAL_CHECKPOINT_INTERVAL) || 1000, // §1: checkpoints accelerate recovery; finality certs record every tick
    startupVerifyRecentN: process.env.INTERVAL_STARTUP_VERIFY_RECENT ? Number(process.env.INTERVAL_STARTUP_VERIFY_RECENT) : DEFAULT_STARTUP_VERIFY_RECENT_N, // §2: shared bounded default; env can override (Infinity = full audit)
    listen: `/ip4/0.0.0.0/tcp/${P2P_PORT}`,   // the pillar accepts peers
  }).start()
} catch (e) {
  if (e.code === 'ERR_WITNESS_LOCK_HELD') {
    console.error(`\n${e.message}\n\nAnother witness process is already operating this identity for this world. Stop it first, or run a different witness identity.`)
    process.exit(1)
  }
  throw e
}

console.log(`witnessed world ${node.worldId.slice(0, 12)}… · ${GENESIS.witnesses.length} witness(es), quorum ${GENESIS.quorum} · this witness ${WITNESS.playerId.slice(0, 12)}…`)
if (migrated) console.log(`world refounded (rules changed, clock lapsed, or checkpoint invalid): ${migrated} citizen(s) crossed into world ${node.worldId.slice(0, 12)}…`)
{
  const gap = node.scheduledTick - node.state.tick
  if (gap > 0) console.log(`catching up ${gap} ticks by certified proposal…`)
}
// every visitor is their own citizen: one identity per browser, keyed by a
// local ID the browser stores. The node custodies these keys (a friendly
// pillar); browser-held keys are the v1.0 light-client milestone.
function identityFor(uid) {
  const safe = String(uid).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)
  if (!safe) return null
  return E.loadOrCreateIdentity(fs, 'identities/web-' + safe + '.json')
}

// ---- the readable world: JSON API (hiscores sites are just windows) ----
const lvl = E.levelForXp
function hiscores() {
  return Object.entries(node.state.players).map(([pid, p]) => {
    const levels = Object.fromEntries(Object.entries(p.skills).map(([k, xp]) => [k, lvl(xp)]))
    return { playerId: pid, name: p.name ?? pid.slice(0, 8) + '…',
             levels, total: Object.values(levels).reduce((a, b) => a + b, 0),
             xp: Object.values(p.skills).reduce((a, b) => a + b, 0) }
  }).sort((a, b) => b.total - a.total || b.xp - a.xp)
}

const PAGES = { '/': 'index.html', '/quickstart': 'quickstart.html',
                '/manual': 'manual.html', '/hiscores': 'hiscores.html',
                '/play': 'windows.html', '/windows': 'windows.html' }
const MIME = { html: 'text/html', css: 'text/css', js: 'text/javascript' }

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
  try {
    if (path === '/api/genesis') return json({
      genesis: node.genesis, peerId: node.peerId(), p2pPort: P2P_PORT,
      note: 'run join.mjs against this URL to enter this world with your own node and keys',
    })
    if (path === '/api/world') return json({
      tick: node.state.tick, finalizedTick: node.finalizedTick, scheduledTick: node.scheduledTick,
      worldId: node.worldId, witnesses: GENESIS.witnesses.length, quorum: GENESIS.quorum,
      halted: node.agreement?.halted ?? false,
      awake: Object.values(node.state.players).filter(p => E.isAwake(p, node.state.tick)).length,
      players: Object.keys(node.state.players).length,
      mobs: Object.values(node.state.mobs).filter(m => m.hp > 0).length })
    if (path === '/api/announce' && req.method === 'POST') {
      // a peer announces its LISTENING port; we pair it with the address
      // we OBSERVED it calling from. Self-reported IPs lie; sockets do not.
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const { peerId, port } = JSON.parse(body)
          if (!/^12D3Koo[1-9A-HJ-NP-Za-km-z]+$/.test(peerId ?? '') || !Number.isInteger(port)) { res.writeHead(400); res.end(); return }
          // behind nginx the socket says 127.0.0.1 about everyone: honor the
          // forwarded header first, or the directory fills with loopback ghosts
          const fwd = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
          const ip = (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '')
          const fam = ip.includes(':') ? 'ip6' : 'ip4'
          announced.set(peerId, { addr: '/' + fam + '/' + ip + '/tcp/' + port + '/p2p/' + peerId, at: Date.now() })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, recorded: announced.get(peerId).addr }))
        } catch { res.writeHead(400); res.end() }
      })
      return
    }
    if (path === '/api/peers') {
      // the mesh directory (v2): ANNOUNCED addresses only. Connection
      // remoteAddrs were ephemeral outbound ports: dialing one is knocking
      // on the hole someone drilled outward. Announcements are doors.
      const fresh = Date.now() - 5 * 60 * 1000
      for (const [id2, e2] of announced) if (e2.at < fresh) announced.delete(id2)
      return json({ peers: [...announced.values()].map(e2 => e2.addr), count: announced.size })
    }
    if (path === '/api/hiscores') return json({ tick: node.state.tick, players: hiscores() })
    if (path.startsWith('/api/player/')) {
      const q = decodeURIComponent(path.slice(12)).toLowerCase()
      const hit = Object.entries(node.state.players).find(([pid, p]) => p.name === q || pid === q)
      if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"no such citizen"}') }
      return json({ playerId: hit[0], ...hit[1] })
    }
    const NC = { 'Cache-Control': 'no-cache' } // stale windows caused ghost bugs
    // /play is the doorway: a window is a choice, and the choice is shown.
    // The old paths keep working, since links live longer than layouts.
    if (path === '/play/flat' || path === '/window-web') { res.writeHead(200, { 'Content-Type': 'text/html', ...NC }); return res.end(fs.readFileSync(new URL('./window-web.html', import.meta.url))) }
    if (path === '/play/deep' || path === '/deluxe') { res.writeHead(200, { 'Content-Type': 'text/html', ...NC }); return res.end(fs.readFileSync(new URL('./window-3d.html', import.meta.url))) }
    if (path.startsWith('/site/')) {
      const f = path.slice(6).replace(/[^a-z0-9.-]/g, '')
      const ext = f.split('.').pop()
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain', ...NC })
      return res.end(fs.readFileSync(new URL('./site/' + f, import.meta.url)))
    }
    if (PAGES[path]) { res.writeHead(200, { 'Content-Type': 'text/html', ...NC }); return res.end(fs.readFileSync(new URL('./site/' + PAGES[path], import.meta.url))) }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('nothing here')
  } catch (e) { res.writeHead(500); res.end('error') }
})
const wss = new WebSocketServer({ server })
const sockets = new Map() // ws -> IntervalClient (per-visitor identity)

wss.on('connection', (ws) => {
  sockets.set(ws, null)
  ws.on('close', () => sockets.delete(ws))
  ws.on('message', (buf) => {
    try { handle(ws, buf) } catch (err) { console.error('ws action error:', err.message) }
  })
})

function handle(ws, buf) {
    let m; try { m = JSON.parse(buf) } catch { return }
    if (m.type === 'adopt') {
      // browser-held keys (v1.0): the pillar holds NOTHING for this citizen.
      // It merely relays inputs the browser signed; the engine judges them.
      if (!/^[0-9a-f]{64}$/.test(m.pub ?? '')) return
      sockets.set(ws, { external: true, playerId: m.pub })
      ws.send(JSON.stringify({ type: 'hello', playerId: m.pub, external: true }))
      return
    }
    if (m.type === 'rawsay') {
      const ext = sockets.get(ws)
      if (!ext?.external || m.msg?.playerId !== ext.playerId) return
      node.publishSignedChat(m.msg).catch(() => {})
      return
    }
    if (m.type === 'raw') {
      const ext = sockets.get(ws)
      if (!ext?.external) return
      const inp = m.input
      if (!inp || inp.playerId !== ext.playerId || typeof inp.sig !== 'string') return
      node.submitInput(inp).catch(() => {}) // the engine verifies; forgeries die in gossip
      return
    }
    if (m.type === 'auth') {
      const id = identityFor(m.uid)
      if (!id) return
      sockets.set(ws, new IntervalClient({ node, identity: id }))
      ws.send(JSON.stringify({ type: 'hello', playerId: id.playerId }))
      return
    }
    if (m.type !== 'act') return
    const client = sockets.get(ws)
    if (!client || client.external) return // externals speak only in signatures
    const a = m.action
    // one input per tick, exactly as the constitution demands
    if (a.do === 'spawn') client.spawn()
    else if (a.do === 'move') client.move(Math.sign(a.dx | 0), Math.sign(a.dy | 0))
    else if (a.do === 'gather') client.gather(String(a.nodeId))
    else if (a.do === 'attack') client.attack(String(a.mobId))
    else if (a.do === 'cook') client.cook(a.slot | 0)
    else if (a.do === 'eat') client.eat(a.slot | 0)
    else if (a.do === 'smith') client.smith(String(a.recipe))
    else if (a.do === 'wield') client.wield(a.slot | 0)
    else if (a.do === 'unwield') client.unequip(String(a.gear ?? 'weapon'))
    else if (a.do === 'buy') client.buy(String(a.item))
    else if (a.do === 'recall') client.recall(String(a.to))
    else if (a.do === 'drop') client.drop(a.slot | 0)
    else if (a.do === 'pickup') client.pickup(String(a.groundId))
    else if (a.do === 'light') client.light(a.slot | 0)
    else if (a.do === 'bury') client.bury(a.slot | 0)
    else if (a.do === 'plant') client.plant(a.slot | 0)
    else if (a.do === 'harvest') client.harvest(String(a.nodeId))
    else if (a.do === 'sell') client.sell(a.slot | 0)
    else if (a.do === 'invoke') client.invoke()
    else if (a.do === 'cast') client.cast('anchor')
    else if (a.do === 'fletch') client.fletch(a.slot | 0, a.make === 'arrows' ? 'arrows' : 'bow')
    else if (a.do === 'unequip') client.unequip(['weapon','head','body'].includes(a.gear) ? a.gear : 'weapon')
    else if (a.do === 'deposit') client.deposit(a.slot | 0)
    else if (a.do === 'withdraw') client.withdraw(String(a.item))
    else if (a.do === 'offer_trade') {
      // canonical demand: an item OR positive gold, never both (pre-freeze §1)
      if (a.wantGold != null && (a.wantItem == null || a.wantItem === '')) client.offerTradeForGold(String(a.to), a.giveSlot | 0, a.wantGold | 0)
      else client.offerTradeForItem(String(a.to), a.giveSlot | 0, String(a.wantItem))
    }
    else if (a.do === 'accept_trade') client.acceptTrade(String(a.from))
    else if (a.do === 'cancel_trade') client.cancelTrade()
    else if (a.do === 'chat') { if (client.chat) client.chat(String(a.text)) }
    else if (a.do === 'attackp') { if (client.attackp) client.attackp(String(a.targetId)) }
    else if (a.do === 'name') client.claimName(String(a.name))
    else if (a.do === 'stop') client.stop()
}

node.onChat = (msg) => {
  const name = node.state.players[msg.playerId]?.name ?? msg.playerId.slice(0, 6)
  const out = JSON.stringify({ type: 'chat', playerId: msg.playerId, name, text: msg.text })
  for (const ws of sockets.keys()) if (ws.readyState === 1) ws.send(out)
}

const worldId = node.worldId // the COMPLETE id: windows sign with it and display a prefix
let lastTickAt = 0
node.onTick = (state) => {
  const nowT = Date.now()
  if (lastTickAt && nowT - lastTickAt > 1500) {
    console.warn('[tick-gap] ' + (nowT - lastTickAt) + 'ms between broadcasts at tick ' + state.tick + ': the event loop or host stalled')
  }
  lastTickAt = nowT
  const msg = JSON.stringify({ type: 'state', state, worldId })
  for (const ws of sockets.keys()) if (ws.readyState === 1) ws.send(msg)
}

node.startTicking()
const HTTP_PORT = Number(process.env.INTERVAL_HTTP_PORT) || 8787
server.listen(HTTP_PORT, () => {
  console.log('Interval is live: http://localhost:' + HTTP_PORT + '  (site, game, hiscores, API)')
  console.log('peers may join via join.mjs — p2p port ' + P2P_PORT + ', peer ' + node.peerId())
})
