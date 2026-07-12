// Interval worldgen: shared by every node of a world.
// The terrain is a pure function of genesis: any node, anywhere,
// grows the identical landscape from the founding record.
// v0.30 geography (spec 2b, 2d, 2e, 2f): the wide world.
import E from './engine.js'

export function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  const W = genesis.worldW, H = genesis.worldH
  const trailY = Math.floor(H / 2)
  const cx = Math.floor(W / 2)
  const city = E.cityRectOf(genesis)
  const spawn = { x: cx, y: trailY }
  const taken = new Set()
  const put = (id, type, x, y) => { taken.add(x + ',' + y); E.addNode(w, id, type, x, y) }
  const hamlet = (tag, hx) => {
    put('bank-' + tag, 'bank', hx, trailY - 2)
    put('anvil-' + tag, 'anvil', hx, trailY + 2)
    put('hearth-' + tag, 'campfire', hx + (hx < cx ? 2 : -2), trailY - 1)
    put('house-' + tag + '1', 'house', hx - 2, trailY - 3)
    put('house-' + tag + '2', 'house', hx + 3, trailY - 3)
    put('house-' + tag + '3', 'house', hx - 2, trailY + 3)
  }
  hamlet('west', 6)
  hamlet('east', W - 7)

  // ---- Anchor (spec 2d), unchanged bounds relative to cx ----
  let wi = 0
  for (let x = city.x0; x <= city.x1; x++) for (const y of [city.y0, city.y1]) {
    if (y === city.y1 && x >= cx - 1 && x <= cx + 1) continue
    put('wall-' + (wi++), 'wall', x, y)
  }
  for (let y = city.y0 + 1; y < city.y1; y++) for (const x of [city.x0, city.x1]) put('wall-' + (wi++), 'wall', x, y)
  put('guard-w', 'guard', cx - 2, city.y1 + 1)
  put('guard-e', 'guard', cx + 2, city.y1 + 1)
  put('sign-x', 'signpost', cx + 1, trailY - 1)
  for (const [x, y] of [[city.x0+2, city.y0+2], [city.x0+3, city.y0+2], [city.x0+4, city.y0+2],
                        [city.x0+2, city.y0+4], [city.x0+3, city.y0+4], [city.x0+4, city.y0+4],
                        [city.x0+2, city.y0+3]]) put('wall-' + (wi++), 'wall', x, y)
  put('anvil-city', 'anvil', city.x0 + 3, city.y0 + 3)
  put('smith-1', 'smith', city.x0 + 4, city.y0 + 3)
  put('bank-city', 'bank', city.x1 - 3, city.y0 + 2)
  put('house-c1', 'house', city.x0 + 3, city.y1 - 2)
  put('house-c2', 'house', city.x1 - 3, city.y1 - 2)
  put('house-c3', 'house', city.x1 - 6, city.y0 + 2)
  put('well-1', 'well', cx, city.y0 + 4)
  put('hearth-city', 'campfire', cx, city.y1 - 2)

  // ---- Stillwater: lake village, south (spec 2f) ----
  const lakeC = { x: cx - 6, y: H - 12 }
  const lakeTiles = []
  for (let dx = -5; dx <= 5; dx++) for (let dy = -3; dy <= 3; dy++) {
    const x = lakeC.x + dx, y = lakeC.y + dy
    const rr = (dx * dx) / 25 + (dy * dy) / 9
    const wob = (E.sha256(Buffer.from(genesis.genesisSeed + ':lake:' + x + ':' + y))[0] % 100) / 100
    if (rr < 0.75 + wob * 0.3) lakeTiles.push([x, y])
  }
  lakeTiles.forEach(([x, y], i) => put('lake-' + i, 'fishing-spot', x, y))
  put('store-1', 'store', lakeC.x + 8, lakeC.y - 3)
  put('keeper-1', 'smith', lakeC.x + 9, lakeC.y - 3)
  put('bank-still', 'bank', lakeC.x + 8, lakeC.y - 6)
  put('hearth-still', 'campfire', lakeC.x + 6, lakeC.y - 5)
  put('house-s1', 'house', lakeC.x + 11, lakeC.y - 5)
  put('house-s2', 'house', lakeC.x + 11, lakeC.y - 2)
  put('sign-south', 'signpost', cx + 1, lakeC.y - 5)

  // ---- Milbrook: quiet town, southeast ----
  const mb = { x: W - 16, y: H - 12 }
  put('bank-mil', 'bank', mb.x, mb.y)
  put('anvil-mil', 'anvil', mb.x + 3, mb.y)
  put('well-mil', 'well', mb.x + 1, mb.y + 3)
  put('hearth-mil', 'campfire', mb.x - 2, mb.y + 2)
  put('house-m1', 'house', mb.x - 3, mb.y - 2)
  put('house-m2', 'house', mb.x + 4, mb.y - 2)
  put('house-m3', 'house', mb.x - 3, mb.y + 4)
  put('house-m4', 'house', mb.x + 4, mb.y + 4)

  // small waters near the west hamlet, as of old
  for (const [i, [x, y]] of [[0, [10, trailY + 4]], [1, [11, trailY + 4]], [2, [10, trailY + 5]]])
    put('fish-w' + i, 'fishing-spot', x, y)
  put('fire-way1', 'campfire', Math.floor(W / 3), trailY - 1)
  put('fire-way2', 'campfire', Math.floor(2 * W / 3), trailY + 1)
  put('fire-way3', 'campfire', cx - 1, Math.floor((trailY + lakeC.y) / 2))

  // ---- regions ----
  const inHighlands = (x, y) => x >= W - 30 && y <= 20
  const inCave = (x, y) => x >= W - 20 && x <= W - 6 && y >= 4 && y <= 13
  const inForest = (x, y) => x <= 34 && y >= H - 24
  const nearLake = (x, y) => Math.abs(x - lakeC.x) <= 10 && Math.abs(y - lakeC.y) <= 7
  const nearMilbrook = (x, y) => Math.abs(x - mb.x) <= 7 && Math.abs(y - mb.y) <= 6
  const isEdge = (x, y) => x === 0 || y === 0 || x === W - 1 || y === H - 1
  const onTrail = (x, y) => Math.abs(y - trailY) <= 1
  const onNorthRoad = (x, y) => Math.abs(x - cx) <= 1 && y > city.y1 && y < trailY
  const onSouthRoad = (x, y) => Math.abs(x - cx) <= 1 && y > trailY && y < lakeC.y - 3
  const inCityArea = (x, y) => x >= city.x0 - 1 && x <= city.x1 + 1 && y >= city.y0 - 1 && y <= city.y1 + 2
  const inHamlet = (x, y) => (x <= 12 || x >= W - 13) && Math.abs(y - trailY) <= 4
  const nearSpawn = (x, y) => Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) <= 1
  const clearOf = (x, y) => !taken.has(x + ',' + y) && !isEdge(x, y) && !onTrail(x, y)
    && !onNorthRoad(x, y) && !onSouthRoad(x, y) && !inCityArea(x, y) && !inHamlet(x, y)
    && !nearSpawn(x, y) && !nearMilbrook(x, y)

  const place = (kind, count, ok, addFn) => {
    let placed = 0, i = 0
    while (placed < count && i < count * 90) {
      const h = E.sha256(Buffer.from(genesis.genesisSeed + ':' + kind + ':' + i))
      const x = (h[0] * 256 + h[1]) % W, y = (h[2] * 256 + h[3]) % H
      i++
      if (!clearOf(x, y) || !ok(x, y)) continue
      taken.add(x + ',' + y); addFn(kind + '-' + placed, x, y); placed++
    }
  }
  place('tree', 60, (x, y) => !inHighlands(x, y) && !nearLake(x, y), (id, x, y) => E.addNode(w, id, 'tree', x, y))
  place('foresttree', 55, (x, y) => inForest(x, y), (id, x, y) => E.addNode(w, id, 'tree', x, y))
  place('rock', 14, (x, y) => !inHighlands(x, y) && !inForest(x, y) && !nearLake(x, y), (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('highrock', 26, (x, y) => inHighlands(x, y) && !inCave(x, y), (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('magicrock', 7, (x, y) => inHighlands(x, y) && !inCave(x, y), (id, x, y) => E.addNode(w, id, 'magic-rock', x, y))
  place('gob', 22, (x, y) => x > 16 && x < W - 32 && !nearLake(x, y) && !inForest(x, y), (id, x, y) => E.addMob(w, id, 'goblin', x, y))
  place('wolf', 10, (x, y) => (y <= 6 || y >= H - 7) && !inHighlands(x, y) && !nearLake(x, y) && !nearMilbrook(x, y), (id, x, y) => E.addMob(w, id, 'wolf', x, y))
  place('troll', 5, (x, y) => inCave(x, y), (id, x, y) => E.addMob(w, id, 'troll', x, y))
  place('bear', 4, (x, y) => inForest(x, y), (id, x, y) => E.addMob(w, id, 'bear', x, y))
  return w
}
