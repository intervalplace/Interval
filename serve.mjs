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

const NAME = (process.argv[2] || '').toLowerCase()
const SEED = 'solo-' + (process.env.INTERVAL_SEED || 'world')
const RULES_HASH = E.sha256(fs.readFileSync(new URL('./SPEC.md', import.meta.url))).toString('hex')
const WORLD_W = 36, WORLD_H = 20
const GENESIS = E.makeGenesis(SEED, RULES_HASH, Date.now(), WORLD_W, WORLD_H)

fs.mkdirSync('identities', { recursive: true })
fs.mkdirSync('checkpoints', { recursive: true })
const me = E.loadOrCreateIdentity(fs, 'identities/web.json')

// The terrain grows deterministically from the genesis seed: every node
// that builds this world computes the identical landscape.
function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  const W2 = genesis.worldW, H2 = genesis.worldH
  const spawn = { x: Math.floor(W2 / 2), y: Math.floor(H2 / 2) }
  const taken = new Set()
  const clear = (x, y) => { // keep spawn area open
    return Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) <= 1 }
  const place = (kind, count, addFn) => {
    let placed = 0, i = 0
    while (placed < count && i < count * 40) {
      const h = E.sha256(Buffer.from(genesis.genesisSeed + ':' + kind + ':' + i))
      const x = h[0] % W2, y = h[1] % H2, k = x + ',' + y
      i++
      if (taken.has(k) || clear(x, y)) continue
      taken.add(k); addFn(kind + '-' + placed, x, y); placed++
    }
  }
  place('tree', 26, (id, x, y) => E.addNode(w, id, 'tree', x, y))
  place('rock', 12, (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('fish', 8,  (id, x, y) => E.addNode(w, id, 'fishing-spot', x, y))
  place('fire', 4,  (id, x, y) => E.addNode(w, id, 'campfire', x, y))
  place('anvil', 2, (id, x, y) => E.addNode(w, id, 'anvil', x, y))
  place('gob', 10,  (id, x, y) => E.addMob(w, id, 'goblin', x, y))
  return w
}

const node = await new IntervalNode({ genesis: GENESIS, buildWorld, name: 'web' }).start()
const client = new IntervalClient({ node, identity: me })

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
    if (path === '/api/world') return json({
      tick: node.state.tick, worldId: client.worldId,
      players: Object.keys(node.state.players).length,
      mobs: Object.values(node.state.mobs).filter(m => m.hp > 0).length })
    if (path === '/api/hiscores') return json({ tick: node.state.tick, players: hiscores() })
    if (path.startsWith('/api/player/')) {
      const q = decodeURIComponent(path.slice(12)).toLowerCase()
      const hit = Object.entries(node.state.players).find(([pid, p]) => p.name === q || pid === q)
      if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"no such citizen"}') }
      return json({ playerId: hit[0], ...hit[1] })
    }
    if (path === '/play') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(new URL('./window-web.html', import.meta.url))) }
    if (path.startsWith('/site/')) {
      const f = path.slice(6).replace(/[^a-z0-9.-]/g, '')
      const ext = f.split('.').pop()
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' })
      return res.end(fs.readFileSync(new URL('./site/' + f, import.meta.url)))
    }
    if (PAGES[path]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(new URL('./site/' + PAGES[path], import.meta.url))) }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('nothing here')
  } catch (e) { res.writeHead(500); res.end('error') }
})
const wss = new WebSocketServer({ server })
const sockets = new Set()

wss.on('connection', (ws) => {
  sockets.add(ws)
  ws.send(JSON.stringify({ type: 'hello', playerId: me.playerId, name: NAME }))
  ws.on('close', () => sockets.delete(ws))
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf) } catch { return }
    if (m.type !== 'act') return
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
    else if (a.do === 'chat') client.chat(String(a.text))
    else if (a.do === 'name') client.claimName(String(a.name))
    else if (a.do === 'stop') client.stop()
  })
})

client.onChat((msg) => {
  const name = node.state.players[msg.playerId]?.name ?? msg.playerId.slice(0, 6)
  const out = JSON.stringify({ type: 'chat', playerId: msg.playerId, name, text: msg.text })
  for (const ws of sockets) if (ws.readyState === 1) ws.send(out)
})

client.onTick((state) => {
  const msg = JSON.stringify({ type: 'state', state, worldId: client.worldId })
  for (const ws of sockets) if (ws.readyState === 1) ws.send(msg)
})

node.startTicking()
server.listen(8787, () => console.log('Interval is live: http://localhost:8787  (site, game, hiscores, API)'))
