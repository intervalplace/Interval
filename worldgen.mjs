// Interval worldgen: shared by every node of a world.
// The terrain is a pure function of genesis: any node, anywhere,
// grows the identical landscape from the founding record.
// v0.22 geography (spec 2b): Westhearth and Eastmere, joined by a trail.
import E from './engine.js'

export function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  const W = genesis.worldW, H = genesis.worldH
  const trailY = Math.floor(H / 2)
  const spawn = { x: Math.floor(W / 2), y: Math.floor(H / 2) }
  const taken = new Set()
  const put = (id, type, x, y) => { taken.add(x + ',' + y); E.addNode(w, id, type, x, y) }

  // the hamlets: bank, anvil, hearth, arranged around the trail
  put('bank-west', 'bank', 5, trailY - 2)
  put('anvil-west', 'anvil', 5, trailY + 2)
  put('hearth-west', 'campfire', 7, trailY - 1)
  put('bank-east', 'bank', W - 6, trailY - 2)
  put('anvil-east', 'anvil', W - 6, trailY + 2)
  put('hearth-east', 'campfire', W - 8, trailY - 1)

  // the shelter of the hamlets (spec 2b): homes make a place a place
  put('house-w1', 'house', 3, trailY - 3)
  put('house-w2', 'house', 8, trailY - 3)
  put('house-w3', 'house', 3, trailY + 3)
  put('house-e1', 'house', W - 4, trailY - 3)
  put('house-e2', 'house', W - 9, trailY - 3)
  put('house-e3', 'house', W - 4, trailY + 3)

  // waters near each hamlet
  const waters = [
    [10, trailY + 4], [11, trailY + 4], [10, trailY + 5],
    [W - 11, trailY - 5], [W - 12, trailY - 5], [W - 11, trailY - 4], [W - 12, trailY - 4],
  ]
  waters.forEach(([x, y], i) => put('fish-' + i, 'fishing-spot', x, y))

  // two wayside campfires on the long road
  put('fire-way1', 'campfire', Math.floor(W / 3), trailY - 1)
  put('fire-way2', 'campfire', Math.floor(2 * W / 3), trailY + 1)

  const onTrail = (x, y) => Math.abs(y - trailY) <= 1
  const inHamlet = (x, y) => (x <= 10 || x >= W - 11) && Math.abs(y - trailY) <= 4
  const nearSpawn = (x, y) => Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) <= 1

  const place = (kind, count, ok, addFn) => {
    let placed = 0, i = 0
    while (placed < count && i < count * 60) {
      const h = E.sha256(Buffer.from(genesis.genesisSeed + ':' + kind + ':' + i))
      const x = h[0] % W, y = h[1] % H, k = x + ',' + y
      i++
      if (taken.has(k) || onTrail(x, y) || inHamlet(x, y) || nearSpawn(x, y) || !ok(x, y)) continue
      taken.add(k); addFn(kind + '-' + placed, x, y); placed++
    }
  }
  place('tree', 34, () => true, (id, x, y) => E.addNode(w, id, 'tree', x, y))
  place('rock', 14, (x, y) => y < trailY, (id, x, y) => E.addNode(w, id, 'rock', x, y))
  place('gob', 12, (x) => x > 12 && x < W - 13, (id, x, y) => E.addMob(w, id, 'goblin', x, y))
  return w
}
