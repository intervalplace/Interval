// Interval worldgen: shared by every node of a world.
// The terrain is a pure function of genesis: any node, anywhere,
// grows the identical landscape from the founding record.
// v0.40 geography (spec 2b-2j): the river, the sea, the mountains,
// Norwick, the winding road, and a world with texture in between.
import E from './engine.js'

// the river's course: pure, shared with every window that paints it
export function riverX(genesis, y) {
  const cx = Math.floor(genesis.worldW / 2)
  const h = E.sha256(Buffer.from(genesis.genesisSeed + ':river:' + y))[0]
  return cx + 22 + Math.round(Math.sin(y / 9) * 7) + (h % 3) - 1
}

// the road's course (spec 2j): flat and true through every settlement and
// the river crossing, winding everywhere else. Pure, shared with every window.
export function trailYAt(genesis, x) {
  const W = genesis.worldW, H = genesis.worldH
  const cx = Math.floor(W / 2)
  const base = Math.floor(H / 2)
  const anchors = [6, cx, W - 10, riverX(genesis, base)]
  let dist = Infinity
  for (const ax of anchors) dist = Math.min(dist, Math.abs(x - ax))
  const FLAT = 9, FADE = 34, AMP = 6
  const settle = dist <= FLAT ? 1 : dist >= FLAT + FADE ? 0 : 1 - (dist - FLAT) / FADE
  const h = E.sha256(Buffer.from(genesis.genesisSeed + ':trail:' + x))[0]
  const wobble = Math.sin(x / 21) * AMP + Math.sin(x / 8 + 3) * 2 + (h % 5 - 2)
  return base + Math.round(wobble * (1 - settle))
}

// The generator's own constitutional floor (rev6 §5): below this, the
// procedural layout provably places objects out of bounds (empirically:
// 64x48 builds a valid world; 60x40 does not).
export const WORLDGEN_MIN = { w: 64, h: 48 }
export const GENERATOR_ID = 'interval-classic-v1' // named in every founding record (rev7 §8)

export function buildWorld(genesis) {
  // rev6 §3: never construct a world from an invalid founding record
  const gerr = E.validateGenesis(genesis)
  if (gerr) throw new Error('refusing to build a world from an invalid genesis: ' + gerr)
  if (genesis.worldGenerator !== GENERATOR_ID)
    throw new Error(`this genesis names generator ${JSON.stringify(genesis.worldGenerator)}; this node implements ${GENERATOR_ID} — refusing to guess at another generator's world`)
  if (genesis.worldW < WORLDGEN_MIN.w || genesis.worldH < WORLDGEN_MIN.h)
    throw new Error(`worldgen requires at least ${WORLDGEN_MIN.w}x${WORLDGEN_MIN.h} (got ${genesis.worldW}x${genesis.worldH}) — the procedural layout does not fit smaller worlds`)
  const w = E.newWorld(genesis)
  const W = genesis.worldW, H = genesis.worldH
  const trailY = Math.floor(H / 2)
  const cx = Math.floor(W / 2)
  const city = E.cityRectOf(genesis)
  const spawn = { x: cx, y: trailY }
  const taken = new Set()
  const put = (id, type, x, y, extra) => { taken.add(x + ',' + y); E.addNode(w, id, type, x, y, extra) }

  // ---- hamlets (spec 2b, 2k): same pattern, different trades ----
  const hamlet = (tag, hx, kind) => {
    const ty = trailYAt(genesis, hx) // each hamlet sits on its own (locally flat) stretch of road
    put('bank-' + tag, 'bank', hx, ty - 2)
    if (kind === 'port') {
      put('store-' + tag, 'store', hx, ty + 2)
      put('keeper-' + tag, 'smith', hx + (hx < cx ? 1 : -1), ty + 2)
      const dfx = hx + (hx < cx ? -4 : 4)
      put('dock-fish-' + tag + '1', 'fishing-spot', dfx, ty)
      put('dock-fish-' + tag + '2', 'fishing-spot', dfx, ty + 1)
    } else {
      put('anvil-' + tag, 'anvil', hx, ty + 2)
    }
    put('hearth-' + tag, 'campfire', hx + (hx < cx ? 2 : -2), ty - 1)
    put('house-' + tag + '1', 'house', hx - 2, ty - 3)
    put('house-' + tag + '2', 'house', hx + 3, ty - 3)
    put('house-' + tag + '3', 'house', hx - 2, ty + 3)
    return ty
  }
  hamlet('west', 6, 'starter') // Westhearth: modest, where every citizen begins
  hamlet('east', W - 10, 'port') // Eastmere: a coastal trade town, no forge, all dock

  // ---- Anchor (spec 2d): the capital, smithing and commerce both ----
  let wi = 0
  for (let x = city.x0; x <= city.x1; x++) for (const y of [city.y0, city.y1]) {
    if (y === city.y1 && x >= cx - 1 && x <= cx + 1) continue
    put('wall-' + (wi++), 'wall', x, y)
  }
  for (let y = city.y0 + 1; y < city.y1; y++) for (const x of [city.x0, city.x1]) put('wall-' + (wi++), 'wall', x, y)
  put('guard-w', 'guard', cx - 2, city.y1 + 1)
  put('guard-e', 'guard', cx + 2, city.y1 + 1)
  put('sign-x', 'signpost', cx + 1, trailY - 1,
    { text: "The King's Road. West: Westhearth. East: Eastmere. South: the lake road." })
  for (const [x, y] of [[city.x0+2, city.y0+2], [city.x0+3, city.y0+2], [city.x0+4, city.y0+2],
                        [city.x0+2, city.y0+4], [city.x0+3, city.y0+4], [city.x0+4, city.y0+4],
                        [city.x0+2, city.y0+3]]) put('wall-' + (wi++), 'wall', x, y)
  put('anvil-city', 'anvil', city.x0 + 3, city.y0 + 3)
  put('smith-1', 'smith', city.x0 + 4, city.y0 + 3)
  put('anvil-city2', 'anvil', city.x1 - 4, city.y0 + 3)
  put('smith-2', 'smith', city.x1 - 5, city.y0 + 3)
  put('store-city', 'store', city.x0 + 2, city.y1 - 3)
  put('keeper-city', 'smith', city.x0 + 3, city.y1 - 3)
  put('bank-city', 'bank', city.x1 - 3, city.y0 + 2)
  put('house-c1', 'house', city.x0 + 3, city.y1 - 2)
  put('house-c2', 'house', city.x1 - 3, city.y1 - 2)
  put('house-c3', 'house', city.x1 - 6, city.y0 + 2)
  put('well-1', 'well', cx, city.y0 + 4)
  put('hearth-city', 'campfire', cx, city.y1 - 2)

  // ---- Norwick (spec 2i): the garrison town, walled against the Wilds ----
  const nw = E.norwickRectOf(genesis)
  let ni = 0
  for (let x = nw.x0; x <= nw.x1; x++) for (const y of [nw.y0, nw.y1]) {
    if (y === nw.y1 && x >= nw.x0 + 5 && x <= nw.x0 + 7) continue // south gate
    put('nwall-' + (ni++), 'wall', x, y)
  }
  for (let y = nw.y0 + 1; y < nw.y1; y++) for (const x of [nw.x0, nw.x1]) put('nwall-' + (ni++), 'wall', x, y)
  put('guard-nw', 'guard', nw.x0 + 5, nw.y1 + 1)
  put('guard-ne', 'guard', nw.x0 + 7, nw.y1 + 1)
  put('bank-norwick', 'bank', nw.x0 + 2, nw.y0 + 2)
  put('anvil-norwick', 'anvil', nw.x1 - 3, nw.y0 + 2)
  put('well-norwick', 'well', nw.x0 + 6, nw.y0 + 5)
  put('hearth-norwick', 'campfire', nw.x0 + 6, nw.y1 - 2)
  put('house-n1', 'house', nw.x0 + 2, nw.y1 - 2)
  put('house-n2', 'house', nw.x1 - 2, nw.y1 - 2)
  put('sign-norwick', 'signpost', nw.x0 + 6, nw.y1 + 2, { text: 'Norwick garrison. The Wilds start at your back; mind your coin.' })
  // the quarry outside the walls: what a garrison town mines to pay for itself
  for (const [qx, qy] of [[nw.x0 - 3, nw.y1 + 1], [nw.x0 - 4, nw.y1 + 2], [nw.x0 - 2, nw.y1 + 3],
                           [nw.x0 - 5, nw.y0 - 2], [nw.x0 - 3, nw.y0 - 3]]) put('quarry-' + qx + '-' + qy, 'rock', qx, qy)
  put('sign-wilds', 'signpost', nw.x0 - 8, nw.y0 + 4,
    { text: 'The Wilds lie north and west of here. The King\u2019s peace does not follow.' })

  // ---- Stillwater and Milbrook, scaled south ----
  const lakeC = { x: cx - 10, y: H - 16 }
  for (let dx = -6; dx <= 6; dx++) for (let dy = -4; dy <= 4; dy++) {
    const x = lakeC.x + dx, y = lakeC.y + dy
    const rr = (dx * dx) / 36 + (dy * dy) / 16
    const wob = (E.sha256(Buffer.from(genesis.genesisSeed + ':lake:' + x + ':' + y))[0] % 100) / 100
    if (rr < 0.75 + wob * 0.3) put('lake-' + x + '-' + y, 'fishing-spot', x, y)
  }
  put('store-1', 'store', lakeC.x + 9, lakeC.y - 4)
  put('keeper-1', 'smith', lakeC.x + 10, lakeC.y - 4)
  put('bank-still', 'bank', lakeC.x + 9, lakeC.y - 7)
  put('hearth-still', 'campfire', lakeC.x + 7, lakeC.y - 6)
  put('house-s1', 'house', lakeC.x + 12, lakeC.y - 6)
  put('house-s2', 'house', lakeC.x + 12, lakeC.y - 3)
  put('sign-south', 'signpost', cx + 1, lakeC.y - 6, { text: 'Stillwater ahead. Nets, not swords.' })
  const mb = { x: W - 22, y: H - 14 }
  put('bank-mil', 'bank', mb.x, mb.y)
  put('well-mil', 'well', mb.x + 1, mb.y + 3)
  put('hearth-mil', 'campfire', mb.x - 2, mb.y + 2)
  put('house-m1', 'house', mb.x - 3, mb.y - 2)
  put('house-m2', 'house', mb.x + 4, mb.y - 2)
  put('house-m3', 'house', mb.x - 3, mb.y + 4)
  put('house-m4', 'house', mb.x + 4, mb.y + 4)
  put('sign-mil', 'signpost', mb.x - 10, mb.y, { text: 'Milbrook ahead: quiet fields, quieter nights.' })

  // ---- the river (spec 2h): mountains to lake, bridged by the road ----
  const onRoadAt = (x, y) => Math.abs(y - trailYAt(genesis, x)) <= 1
    || (Math.abs(x - cx) <= 1 && y > city.y1 && y < lakeC.y - 4)
  for (let y = 6; y <= lakeC.y - 4; y++) {
    for (const rx of [riverX(genesis, y), riverX(genesis, y) + 1]) {
      if (onRoadAt(rx, y)) continue // the bridge: the road wins
      if (!taken.has(rx + ',' + y)) put('river-' + rx + '-' + y, 'fishing-spot', rx, y)
    }
  }
  // ---- the sea (spec 2h): the east is open water ----
  for (let y = 1; y < H - 1; y++) for (const sx of [W - 3, W - 2]) {
    if (!taken.has(sx + ',' + y)) put('sea-' + sx + '-' + y, 'fishing-spot', sx, y)
  }

  // ---- plots (spec 6o) ----
  const plotsAt = (tag, px2, py2) => { for (let i = 0; i < 3; i++) put('plot-' + tag + i, 'plot', px2 + i, py2) }
  plotsAt('west', 4, trailY + 4)
  plotsAt('east', W - 14, trailY + 4)
  plotsAt('mil', mb.x - 4, mb.y - 5)
  plotsAt('mil2', mb.x - 4, mb.y - 6)
  plotsAt('anchor', cx + 4, city.y1 + 3)
  plotsAt('still', lakeC.x + 8, lakeC.y - 9)
  plotsAt('norwick', nw.x0 + 3, nw.y1 + 4)

  const wy1 = Math.floor(W / 3), wy2 = Math.floor(2 * W / 3)
  put('fire-way1', 'campfire', wy1, trailYAt(genesis, wy1) - 1)
  put('fire-way2', 'campfire', wy2, trailYAt(genesis, wy2) + 1)
  put('fire-way3', 'campfire', cx - 1, Math.floor((trailY + lakeC.y) / 2))
  for (const [i, [x, y]] of [[0, [12, trailY + 5]], [1, [13, trailY + 5]], [2, [12, trailY + 6]]])
    put('fish-w' + i, 'fishing-spot', x, y)

  // ---- waypoints (spec 2k): the road remembers who walked it ----
  const midWest = Math.floor((6 + cx) / 2)
  put('sign-midwest', 'signpost', midWest, trailYAt(genesis, midWest) - 1,
    { text: 'Halfway to Westhearth. Or halfway home, depending which way you\u2019re walking.' })
  const riverCrossX = riverX(genesis, trailY)
  put('sign-bridge', 'signpost', riverCrossX + 3, trailYAt(genesis, riverCrossX + 3) - 1,
    { text: 'The old crossing. Older than the town at either end of it.' })
  const forestEdgeX = 52
  put('sign-forest', 'signpost', forestEdgeX, H - 32,
    { text: 'The deep forest starts here. Something in there growls back.' })
  // two ruins: a wall standing alone means something used to be here
  put('ruin-1', 'wall', Math.floor(W * 0.32), trailYAt(genesis, Math.floor(W * 0.32)) + 8)
  put('ruin-2', 'wall', 46, H - 34)

  // ---- regions ----
  const inMountains = (x, y) => y <= 8 && (x < city.x0 - 2 || x > city.x1 + 2)
  const inHighlands = (x, y) => x >= W - 46 && y <= 26
  const inCave = (x, y) => x >= W - 30 && x <= W - 10 && y >= 5 && y <= 16
  const inForest = (x, y) => x <= 50 && y >= H - 30
  const nearLake = (x, y) => Math.abs(x - lakeC.x) <= 12 && Math.abs(y - lakeC.y) <= 9
  const nearMilbrook = (x, y) => Math.abs(x - mb.x) <= 8 && Math.abs(y - mb.y) <= 7
  const isEdge = (x, y) => x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1
  const nearRiver = (x, y) => Math.abs(x - riverX(genesis, y)) <= 2 && y >= 6 && y <= lakeC.y - 4
  const inSea = (x, y) => x >= W - 4
  const inCityArea = (x, y) => x >= city.x0 - 1 && x <= city.x1 + 1 && y >= city.y0 - 1 && y <= city.y1 + 2
  const inNorwickArea = (x, y) => x >= nw.x0 - 9 && x <= nw.x1 + 2 && y >= nw.y0 - 4 && y <= nw.y1 + 4
  const inHamlet = (x, y) => (x <= 14 || x >= W - 16) && Math.abs(y - trailY) <= 4
  const nearSpawn = (x, y) => Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) <= 1
  const clearOf = (x, y) => !taken.has(x + ',' + y) && !isEdge(x, y) && !onRoadAt(x, y)
    && !inCityArea(x, y) && !inNorwickArea(x, y) && !inHamlet(x, y) && !nearSpawn(x, y) && !nearMilbrook(x, y)
    && !nearRiver(x, y) && !inSea(x, y)

  // ---- danger gradient (spec 2j): the ground tells you before a wolf does ----
  const rectDist = (x, y, r) => Math.max(
    x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0,
    y < r.y0 ? r.y0 - y : y > r.y1 ? y - r.y1 : 0)
  const caveRect = { x0: W - 30, x1: W - 10, y0: 5, y1: 16 }
  const closeness = (d, buf) => d >= buf ? 0 : 1 - d / buf
  const hazardCloseness = (x, y) => Math.max(
    closeness(Math.max(0, y - 8), 18), // approaching the mountains
    closeness(rectDist(x, y, { x0: 1, x1: 34, y0: 1, y1: 22 }), 16), // approaching the Wilds
    closeness(rectDist(x, y, caveRect), 14)) // approaching the cave

  const place = (kind, count, ok, addFn, opts = {}) => {
    let placed = 0, i = 0
    while (placed < count && i < count * 160) {
      const h = E.sha256(Buffer.from(genesis.genesisSeed + ':' + kind + ':' + i))
      const x = (h[0] * 256 + h[1]) % W, y = (h[2] * 256 + h[3]) % H
      i++
      if (!clearOf(x, y) || !ok(x, y)) continue
      if (opts.thinNearHazard && (h[2] / 256) < hazardCloseness(x, y) * 0.75) continue
      taken.add(x + ',' + y); addFn(kind + '-' + placed, x, y); placed++
    }
  }
  // clustered placement (spec 2j): patchy woods and goblin camps, not uniform noise
  const placeClustered = (kind, count, clusterN, radius, ok, addFn, opts = {}) => {
    const centers = []
    for (let c = 0; c < clusterN; c++) {
      const h = E.sha256(Buffer.from(genesis.genesisSeed + ':' + kind + ':ctr:' + c))
      centers.push([(h[0] * 256 + h[1]) % W, (h[2] * 256 + h[3]) % H])
    }
    let placed = 0, i = 0
    while (placed < count && i < count * 220) {
      const [ccx, ccy] = centers[i % centers.length]
      const h = E.sha256(Buffer.from(genesis.genesisSeed + ':' + kind + ':' + i))
      const ang = (h[0] / 255) * Math.PI * 2, rad = (h[1] / 255) * radius
      const x = Math.round(ccx + Math.cos(ang) * rad), y = Math.round(ccy + Math.sin(ang) * rad)
      i++
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue
      if (!clearOf(x, y) || !ok(x, y)) continue
      if (opts.thinNearHazard && (h[2] / 256) < hazardCloseness(x, y) * 0.75) continue
      taken.add(x + ',' + y); addFn(kind + '-' + placed, x, y); placed++
    }
  }
  placeClustered('tree', 100, 10, 12, (x, y) => !inHighlands(x, y) && !inMountains(x, y) && !nearLake(x, y),
    (id, x, y) => E.addNode(w, id, 'tree', x, y), { thinNearHazard: true })
  place('foresttree', 80, (x, y) => inForest(x, y), (id, x, y) => E.addNode(w, id, 'tree', x, y))
  placeClustered('rock', 22, 7, 8, (x, y) => !inHighlands(x, y) && !inMountains(x, y) && !inForest(x, y) && !nearLake(x, y),
    (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('highrock', 30, (x, y) => inHighlands(x, y) && !inCave(x, y), (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('mtnrock', 24, (x, y) => inMountains(x, y), (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('magicrock', 7, (x, y) => inHighlands(x, y) && !inCave(x, y), (id, x, y) => E.addNode(w, id, 'magic-rock', x, y))
  place('mtnmagic', 5, (x, y) => inMountains(x, y), (id, x, y) => E.addNode(w, id, 'magic-rock', x, y))
  // the scree band: sparser trees near hazard country are backfilled with bare rock
  place('screerock', 18, (x, y) => hazardCloseness(x, y) > 0.2 && hazardCloseness(x, y) < 1
    && !inMountains(x, y) && !E.inWilds(genesis, x, y) && !inCave(x, y) && !inHighlands(x, y) && !inForest(x, y),
    (id, x, y) => E.addNode(w, id, 'rock', x, y))
  placeClustered('gob', 36, 7, 4, (x, y) => x > 20 && x < W - 40 && !nearLake(x, y) && !inForest(x, y) && !inMountains(x, y),
    (id, x, y) => E.addMob(w, id, 'goblin', x, y))
  place('wolf', 16, (x, y) => (y <= 10 || y >= H - 9 || x <= 10) && !inHighlands(x, y) && !nearLake(x, y) && !nearMilbrook(x, y) && !inMountains(x, y), (id, x, y) => E.addMob(w, id, 'wolf', x, y))
  place('troll', 7, (x, y) => inCave(x, y), (id, x, y) => E.addMob(w, id, 'troll', x, y))
  place('bear', 7, (x, y) => inForest(x, y), (id, x, y) => E.addMob(w, id, 'bear', x, y))

  // ---- waystones (spec 2k): recall to any you have walked to; the slow road stays open ----
  const putWaystone = (id, x, y) => {
    for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [-1, 1]]) {
      const nx = x + dx, ny = y + dy
      if (nx >= 1 && ny >= 1 && nx < W - 1 && ny < H - 1 && !taken.has(nx + ',' + ny)) { put(id, 'waystone', nx, ny); return }
    }
    put(id, 'waystone', x, y)
  }
  putWaystone('waystone-anchor', cx - 1, city.y1 + 2)
  putWaystone('waystone-west', 6, trailY - 3)
  putWaystone('waystone-east', W - 10, trailY - 3)
  putWaystone('waystone-norwick', nw.x0 + 4, nw.y0 + 3)
  putWaystone('waystone-still', lakeC.x + 8, lakeC.y - 5)
  putWaystone('waystone-mil', mb.x + 2, mb.y + 1)

  // ---- skeleton-knight warbands: the bone-knights of the frontier, seldom alone ----
  const warbands = [[10, 8], [20, 14], [30, 10], [40, 20], [18, 26], [46, 12]]
  let sk = 0
  for (const [wcx, wcy] of warbands) {
    for (let k = 0; k < 5; k++) {
      const hh = E.sha256(Buffer.from(genesis.genesisSeed + ':skel:' + sk))
      const x = wcx + (hh[0] % 5) - 2, y = wcy + (hh[1] % 5) - 2
      sk++
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue
      if (taken.has(x + ',' + y) || inCityArea(x, y) || inNorwickArea(x, y)) continue
      taken.add(x + ',' + y); E.addMob(w, 'skel-' + sk, 'skeleton-knight', x, y)
    }
  }

  // ---- the crossing (fix brief §2.4): imported citizens are FOUNDING data.
  // They live in the genesis itself (so the worldId commits to them) and are
  // applied here, deterministically, by every node that grows this world.
  if (Array.isArray(genesis.imported)) {
    for (const c of genesis.imported) {
      if (!/^[0-9a-f]{64}$/.test(c.pid ?? '')) continue
      E.addPlayer(w, c.pid, spawn.x, spawn.y)
      const p = w.players[c.pid]
      for (const k of Object.keys(p.skills)) if (c.skills?.[k] !== undefined) p.skills[k] = c.skills[k]
      p.hp = Math.min(c.hp ?? p.hp, E.levelForXp(p.skills.hitpoints))
      // rev7 §6: validateGenesis already ran at the top of buildWorld and
      // validateImports guarantees every field here — construction applies
      // VALIDATED data directly. Silent per-field filtering would let two
      // implementations disagree about which validated citizen got what.
      ;(c.inventory ?? []).forEach((sl, i) => { if (i < p.inventory.length) p.inventory[i] = sl ?? null })
      p.equipment.weapon = c.weapon ?? null
      for (const [it, q] of Object.entries(c.bank ?? {})) p.bank[it] = q
      if (c.name != null) { w.names[c.name] = c.pid; p.name = c.name }
    }
  }

  // rev6 §4: every accepted genesis produces a constitutionally valid
  // initial state — proven here, at the source, with the exact invariant
  // named on failure. A generator bug becomes an aborted founding, never
  // a world whose own checkpoints are unloadable.
  const serr = E.validateState(w)
  if (serr) throw new Error('worldgen produced an invalid state (' + serr + ') — founding aborted')
  return w
}
