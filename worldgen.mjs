// Interval worldgen — shared by every node of a world.
// The terrain is a pure function of genesis: any node, anywhere,
// grows the identical landscape from the founding record.
import E from './engine.js'

export function buildWorld(genesis) {
  const w = E.newWorld(genesis)
  const W2 = genesis.worldW, H2 = genesis.worldH
  const spawn = { x: Math.floor(W2 / 2), y: Math.floor(H2 / 2) }
  const taken = new Set()
  const clear = (x, y) => Math.max(Math.abs(x - spawn.x), Math.abs(y - spawn.y)) <= 1
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
  place('bank', 2,  (id, x, y) => E.addNode(w, id, 'bank', x, y))
  place('gob', 10,  (id, x, y) => E.addMob(w, id, 'goblin', x, y))
  return w
}
