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
import { IntervalClient } from './sdk.mjs'
import { buildWorld } from './worldgen.mjs'

const SEED = 'solo-' + (process.env.INTERVAL_SEED || 'world')
const RULES_HASH = E.sha256(fs.readFileSync(new URL('./SPEC.md', import.meta.url))).toString('hex')
const WORLD_W = 72, WORLD_H = 36
const WORLD_FILE = 'checkpoints/world.json'   // the founding record
const CP_FILE = 'checkpoints/web.json'        // the living state

fs.mkdirSync('identities', { recursive: true })
fs.mkdirSync('checkpoints', { recursive: true })

const P2P_PORT = Number(process.env.INTERVAL_P2P_PORT || 4600)

// ---- persistence across restarts and updates ----
// Same rules → resume the same world from checkpoint.
// Changed rules → found a NEW world whose genesis imports the citizens.
const KNOWN_ITEMS = new Set(['logs', 'ore', 'raw-fish', 'cooked-fish', 'burnt-fish', 'bones',
  ...Object.keys(E.RECIPES), 'wooden-bow', 'arrows', 'bronze-helm', 'bronze-plate', 'magic-stone', 'sigil'])
let GENESIS, migrated = 0
const saved = fs.existsSync(WORLD_FILE) ? JSON.parse(fs.readFileSync(WORLD_FILE)) : null

if (saved && saved.genesis.rulesHash === RULES_HASH && saved.genesis.genesisSeed === SEED) {
  GENESIS = saved.genesis
} else {
  GENESIS = E.makeGenesis(SEED, RULES_HASH, Date.now(), WORLD_W, WORLD_H)
  if (saved && fs.existsSync(CP_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(CP_FILE)).state
      // the founding carries everyone who LIVED: a name, any xp beyond
      // birth, anything owned. Pure ghosts (spawned once, did nothing,
      // never returned) rest in the old world's history.
      const lived = (p) => p.name
        || Object.entries(p.skills).some(([k, xp]) => k !== 'hitpoints' ? xp > 0 : xp > 1154)
        || (p.inventory ?? []).some(Boolean)
        || Object.keys(p.bank ?? {}).length > 0
        || p.equipment?.weapon
      GENESIS._imported = Object.entries(old.players).filter(([, p]) => lived(p)).map(([pid, p]) => ({
        pid, skills: p.skills, name: p.name, hp: p.hp, bank: p.bank ?? {},
        inventory: (p.inventory ?? []).filter(sl => sl && KNOWN_ITEMS.has(sl.item)),
        weapon: p.equipment?.weapon && KNOWN_ITEMS.has(p.equipment.weapon.item) ? p.equipment.weapon : null,
      }))
    } catch { /* unreadable old world: found fresh */ }
    fs.rmSync(CP_FILE, { force: true })
  }
  fs.writeFileSync(WORLD_FILE, JSON.stringify({ genesis: GENESIS }))
}

const node = await new IntervalNode({
  genesis: GENESIS, buildWorld, name: 'web', checkpointFile: CP_FILE,
  listen: `/ip4/0.0.0.0/tcp/${P2P_PORT}`,   // the pillar accepts peers
}).start()

// apply the crossing (only on a fresh founding with imports)
if (GENESIS._imported && node.state.tick === 0) {
  const sp = { x: Math.floor(WORLD_W / 2), y: Math.floor(WORLD_H / 2) }
  for (const c of GENESIS._imported) {
    E.addPlayer(node.state, c.pid, sp.x, sp.y)
    const p = node.state.players[c.pid]
    for (const k of Object.keys(p.skills)) if (c.skills?.[k] !== undefined) p.skills[k] = c.skills[k]
    p.hp = Math.min(c.hp ?? p.hp, E.levelForXp(p.skills.hitpoints))
    c.inventory.forEach((sl, i) => { if (i < p.inventory.length) p.inventory[i] = sl })
    p.equipment.weapon = c.weapon
    for (const [it, q] of Object.entries(c.bank ?? {})) if (KNOWN_ITEMS.has(it)) p.bank[it] = q
    if (c.name && !(c.name in node.state.names)) { node.state.names[c.name] = c.pid; p.name = c.name }
    migrated++
  }
  delete GENESIS._imported
  fs.writeFileSync(WORLD_FILE, JSON.stringify({ genesis: GENESIS }))
  console.log(`constitution changed: ${migrated} citizen(s) crossed into the new world`)
}

// if the pillar slept a long time, rebase the clock rather than replaying
// days of empty ticks. (A solo pillar may do this; a multi-node world must
// fast-forward or re-corroborate — rebasing is a whole-world decision.)
{
  const expected = Math.floor((Date.now() - GENESIS.anchorMs) / E.TICK_MS)
  const gap = expected - node.state.tick
  if (gap > 3000) {
    GENESIS.anchorMs = Date.now() - node.state.tick * E.TICK_MS
    node.genesis.anchorMs = GENESIS.anchorMs
    node.state.genesis.anchorMs = GENESIS.anchorMs
    fs.writeFileSync(WORLD_FILE, JSON.stringify({ genesis: GENESIS }))
    console.log(`the world slept ${Math.round(gap * E.TICK_MS / 60000)} minutes — clock rebased at tick ${node.state.tick}`)
  } else if (gap > 0) {
    console.log(`catching up ${gap} ticks…`)
  }
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
                '/manual': 'manual.html', '/hiscores': 'hiscores.html' }
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
      tick: node.state.tick, worldId: RULES_HASH.slice(0, 12),
      awake: Object.values(node.state.players).filter(p => E.isAwake(p, node.state.tick)).length,
      awake: Object.values(node.state.players).filter(p => E.isAwake(p, node.state.tick)).length,
      players: Object.keys(node.state.players).length,
      mobs: Object.values(node.state.mobs).filter(m => m.hp > 0).length })
    if (path === '/api/hiscores') return json({ tick: node.state.tick, players: hiscores() })
    if (path.startsWith('/api/player/')) {
      const q = decodeURIComponent(path.slice(12)).toLowerCase()
      const hit = Object.entries(node.state.players).find(([pid, p]) => p.name === q || pid === q)
      if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"no such citizen"}') }
      return json({ playerId: hit[0], ...hit[1] })
    }
    const NC = { 'Cache-Control': 'no-cache' } // stale windows caused ghost bugs
    if (path === '/play') { res.writeHead(200, { 'Content-Type': 'text/html', ...NC }); return res.end(fs.readFileSync(new URL('./window-web.html', import.meta.url))) }
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
    if (m.type === 'auth') {
      const id = identityFor(m.uid)
      if (!id) return
      sockets.set(ws, new IntervalClient({ node, identity: id }))
      ws.send(JSON.stringify({ type: 'hello', playerId: id.playerId }))
      return
    }
    if (m.type !== 'act') return
    const client = sockets.get(ws)
    if (!client) return
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
    else if (a.do === 'unwield') client.unwield()
    else if (a.do === 'drop') client.drop(a.slot | 0)
    else if (a.do === 'pickup') client.pickup(String(a.groundId))
    else if (a.do === 'light') client.light(a.slot | 0)
    else if (a.do === 'bury') client.bury(a.slot | 0)
    else if (a.do === 'invoke') client.invoke()
    else if (a.do === 'cast') client.cast('anchor')
    else if (a.do === 'fletch') client.fletch(a.slot | 0, a.make === 'arrows' ? 'arrows' : 'bow')
    else if (a.do === 'unequip') client.unequip(['weapon','head','body'].includes(a.gear) ? a.gear : 'weapon')
    else if (a.do === 'deposit') client.deposit(a.slot | 0)
    else if (a.do === 'withdraw') client.withdraw(String(a.item))
    else if (a.do === 'offer_trade') client.offerTrade(String(a.to), a.giveSlot | 0, String(a.wantItem))
    else if (a.do === 'accept_trade') client.acceptTrade(String(a.from))
    else if (a.do === 'cancel_trade') client.cancelTrade()
    else if (a.do === 'chat') client.chat(String(a.text))
    else if (a.do === 'name') client.claimName(String(a.name))
    else if (a.do === 'stop') client.stop()
}

node.onChat = (msg) => {
  const name = node.state.players[msg.playerId]?.name ?? msg.playerId.slice(0, 6)
  const out = JSON.stringify({ type: 'chat', playerId: msg.playerId, name, text: msg.text })
  for (const ws of sockets.keys()) if (ws.readyState === 1) ws.send(out)
}

const worldId = RULES_HASH.slice(0, 12)
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
server.listen(8787, () => {
  console.log('Interval is live: http://localhost:8787  (site, game, hiscores, API)')
  console.log('peers may join via join.mjs — p2p port ' + P2P_PORT + ', peer ' + node.peerId())
})
