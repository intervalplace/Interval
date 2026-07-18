// Interval worldgen: THE EXPANSE (interval-expanse-v1).
//
// The classic world says "a safe town, then danger" — a radial gradient, the
// same in every direction, which is why it can be large without ever becoming
// a place you *know*. The expanse says something else: **every direction means
// something.** North is wood, east is stone, south is water, west is danger,
// and the middle is home. A citizen can hold that in their head after one
// walk and still have it years later, which is the whole point of a world you
// return to rather than a level you finish.
//
// Every function here is pure in the founding record, so any node anywhere
// grows the identical landscape, and any window can mirror the terrain
// without being told it.
import E from './engine.js'

export const GENERATOR_ID = 'interval-expanse-v1'
export const WORLDGEN_MIN = { w: 256, h: 160 }

// ---------- the shape of the country (pure; windows mirror these) ----------
//
// Terrain uses an integer avalanche rather than sha256, deliberately: a window
// must be able to paint this country tile-for-tile without a crypto library and
// without going async mid-frame. The classic world's windows could only
// *approximate* their river for exactly this reason. Here the map a window
// draws is the map the engine placed nodes on, to the tile.
const _seedNums = new Map()
export function seedNum(g) {
  const hit = _seedNums.get(g.genesisSeed)
  if (hit !== undefined) return hit
  let h = 0
  for (let i = 0; i < g.genesisSeed.length; i++) h = Math.imul(h ^ g.genesisSeed.charCodeAt(i), 2654435761) | 0
  const v = h >>> 0
  _seedNums.set(g.genesisSeed, v)
  return v
}
export function thash(g, x, y, k) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(k | 0, 2246822519) + seedNum(g)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

// The Wilds are the western marches. Their rectangle is in the founding
// record (genesis.geo.wilds) because recall and the Brand read it as law.
export const wildsX1 = (g) => Math.round(g.worldW * 0.19)

// The great river: falls out of the Greenwood, past Anchor, into the fens.
// Memoized per (world, y): a pure function may remember its own answers, and
// terrain is asked for the same row hundreds of thousands of times per build.
export function riverX(g, y) {
  const cx = Math.floor(g.worldW / 2)
  return cx + Math.round(Math.sin(y / 34) * 26 + Math.sin(y / 11) * 5) + (thash(g, 0, y, 11) % 3) - 1
}
// The bay: the southeast is open water.
export function inSea(g, x, y) {
  const W = g.worldW, H = g.worldH
  const bx = W * 0.80, by = H * 0.74
  if (x < bx || y < by) return false
  const dx = (x - bx) / (W - bx), dy = (y - by) / (H - by)
  return dx + dy > 0.55
}
// Fen pools: shallow water scattered through the southern wetland.
export function inPool(g, x, y) {
  if (y < g.worldH * 0.66) return false
  const bx = Math.floor(x / 7), by = Math.floor(y / 7)
  const h = thash(g, bx, by, 7)
  if ((h & 255) > 34) return false
  const px = bx * 7 + ((h >>> 8) % 5), py = by * 7 + ((h >>> 16) % 5)
  return Math.abs(x - px) + Math.abs(y - py) <= 2
}
export function isWater(g, x, y) {
  return inSea(g, x, y) || inPool(g, x, y) || Math.abs(x - riverX(g, y)) <= 1
}

// The seven settlements, at the compass points a citizen learns first.
export function settlementsOf(g) {
  const W = g.worldW, H = g.worldH
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  return [
    { tag: 'anchor',     name: 'Anchor',     x: cx,                    y: cy,                    w: 24, h: 14, kind: 'capital' },
    { tag: 'greenhollow',name: 'Greenhollow',x: Math.round(W * 0.46),  y: Math.round(H * 0.14),  w: 14, h: 10, kind: 'timber' },
    { tag: 'millbrook',  name: 'Millbrook',  x: Math.round(W * 0.72),  y: Math.round(H * 0.24),  w: 14, h: 10, kind: 'mill' },
    { tag: 'cragfoot',   name: 'Cragfoot',   x: Math.round(W * 0.86),  y: Math.round(H * 0.50),  w: 14, h: 10, kind: 'forge' },
    { tag: 'eastmere',   name: 'Eastmere',   x: Math.round(W * 0.74),  y: Math.round(H * 0.70),  w: 14, h: 10, kind: 'port' },
    { tag: 'fenmarch',   name: 'Fenmarch',   x: Math.round(W * 0.44),  y: Math.round(H * 0.84),  w: 14, h: 10, kind: 'port' },
    { tag: 'norwick',    name: 'Norwick',    x: Math.round(W * 0.26),  y: Math.round(H * 0.46),  w: 16, h: 12, kind: 'garrison' },
  ]
}
export const rectOf = (s) => ({
  x0: s.x - (s.w >> 1), x1: s.x + (s.w >> 1),
  y0: s.y - (s.h >> 1), y1: s.y + (s.h >> 1),
})

// Roads: every road leads to Anchor. Spokes, not a maze — a world you can
// navigate by memory. Roads carry no nodes, so they cost the tick nothing.
export function onRoad(g, x, y) {
  const ss = settlementsOf(g), a = ss[0]
  for (let i = 1; i < ss.length; i++) {
    const s = ss[i]
    const vx = s.x - a.x, vy = s.y - a.y
    const L2 = vx * vx + vy * vy
    let t = ((x - a.x) * vx + (y - a.y) * vy) / L2
    if (t < 0 || t > 1) continue
    const px = a.x + vx * t, py = a.y + vy * t
    if (Math.abs(x - px) + Math.abs(y - py) * 0.6 <= 1.6) return true
  }
  return false
}

// ---------- the five countries ----------
export function biomeAt(g, x, y) {
  const W = g.worldW, H = g.worldH
  if (x <= wildsX1(g)) return 'wilds'
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const dx = (x - cx) / W, dy = (y - cy) / H
  if (dx * dx + dy * dy < 0.019) return 'heartlands'   // the settled middle
  if (y <= H * 0.32) return 'greenwood'                 // north: the wood
  if (x >= W * 0.70) return 'crags'                     // east: the stone
  if (y >= H * 0.70) return 'fens'                      // south: the water
  return 'heartlands'                                   // the broad country between
}

// ---------- the founding ----------
export function makeExpanseGenesis(genesisSeed, rulesHash, anchorMs = 0, W = 640, H = 400) {
  const g = E.makeGenesis(genesisSeed, rulesHash, anchorMs, W, H)
  g.worldGenerator = GENERATOR_ID
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const nw = settlementsOf({ worldW: W, worldH: H }).find(s => s.tag === 'norwick')
  g.geo = {
    city:    { x0: cx - 12, x1: cx + 12, y0: cy - 7, y1: cy + 7 },
    wilds:   { x0: 1, x1: Math.round(W * 0.19), y0: 1, y1: H - 2 },
    norwick: { x0: nw.x - 8, x1: nw.x + 8, y0: nw.y - 6, y1: nw.y + 6 },
  }
  // a wider, darker country wants longer burns and more hands to light it
  g.watch = { level: 60, kindleLogs: 10, perLog: 420, cap: 12600, xpPerLog: 200, burnXp: 1, maxOwned: 4, decayTicks: 432000 }
  // survey is re-derived for this geometry by bench/expanse-survey.mjs
  g.survey = { k: 16, base: 40, perTile: 7, max: 2600 }
  return g
}

export function buildWorld(genesis) {
  const gerr = E.validateGenesis(genesis)
  if (gerr) throw new Error('refusing to build a world from an invalid genesis: ' + gerr)
  if (genesis.worldGenerator !== GENERATOR_ID)
    throw new Error(`this genesis names generator ${JSON.stringify(genesis.worldGenerator)}; this node implements ${GENERATOR_ID}`)
  if (genesis.worldW < WORLDGEN_MIN.w || genesis.worldH < WORLDGEN_MIN.h)
    throw new Error(`the expanse requires at least ${WORLDGEN_MIN.w}x${WORLDGEN_MIN.h}`)

  const g = genesis, W = g.worldW, H = g.worldH
  const w = E.newWorld(g)
  const taken = new Set()
  const key = (x, y) => x + ',' + y
  const put = (id, type, x, y, extra) => { taken.add(key(x, y)); E.addNode(w, id, type, x, y, extra) }
  const inB = (x, y) => x >= 1 && y >= 1 && x < W - 1 && y < H - 1
  const ss = settlementsOf(g)
  const inAnySettlement = (x, y) => ss.some(s => {
    const r = rectOf(s)
    return x >= r.x0 - 1 && x <= r.x1 + 1 && y >= r.y0 - 1 && y <= r.y1 + 1
  })
  // ground a node may occupy: in bounds, dry, unclaimed, off the road, out of town
  const free = (x, y) => inB(x, y) && !taken.has(key(x, y)) && !isWater(g, x, y)
    && !onRoad(g, x, y) && !inAnySettlement(x, y)

  const H32 = (tag, i) => E.sha256(Buffer.from(g.genesisSeed + ':' + tag + ':' + i))

  // ---- the seven settlements ----
  for (const s of ss) {
    const r = rectOf(s)
    let wi = 0
    const gapx = s.x, gapy = s.y // a gate on each wall, so no town is sealed
    // a wall stops at the water's edge: the river runs through the town, and
    // where it enters there is a watergate rather than masonry
    for (let x = r.x0; x <= r.x1; x++) for (const y of [r.y0, r.y1]) {
      if (Math.abs(x - gapx) <= 1) continue
      if (inB(x, y) && !isWater(g, x, y)) put('wall-' + s.tag + '-' + (wi++), 'wall', x, y)
    }
    for (let y = r.y0 + 1; y < r.y1; y++) for (const x of [r.x0, r.x1]) {
      if (Math.abs(y - gapy) <= 1) continue
      if (inB(x, y) && !isWater(g, x, y)) put('wall-' + s.tag + '-' + (wi++), 'wall', x, y)
    }
    const at = (dx, dy) => ({ x: s.x + dx, y: s.y + dy })
    const place = (id, type, dx, dy, extra) => { const p = at(dx, dy); if (inB(p.x, p.y) && !taken.has(key(p.x, p.y)) && !isWater(g, p.x, p.y)) put(id, type, p.x, p.y, extra) }
    place('bank-' + s.tag, 'bank', -3, -2)
    place('well-' + s.tag, 'well', 0, 0)
    place('hearth-' + s.tag, 'campfire', 2, -2)
    place('sign-' + s.tag, 'signpost', 0, 3, { text: s.name })
    if (s.kind === 'capital') {
      place('anvil-' + s.tag, 'anvil', 3, -2); place('smith-' + s.tag, 'smith', 4, -2)
      place('store-' + s.tag, 'store', -4, 2); place('store2-' + s.tag, 'store', 5, 2)
      place('anvil2-' + s.tag, 'anvil', -5, -2)
      for (let k = 0; k < 6; k++) place('house-' + s.tag + k, 'house', -6 + k * 2, 4)
      for (let k = 0; k < 4; k++) place('guard-' + s.tag + k, 'guard', -8 + k * 5, -5)
    } else {
      if (s.kind === 'forge' || s.kind === 'garrison' || s.kind === 'mill') {
        place('anvil-' + s.tag, 'anvil', 3, -2); place('smith-' + s.tag, 'smith', 4, -2)
      }
      if (s.kind === 'port' || s.kind === 'timber' || s.kind === 'mill') place('store-' + s.tag, 'store', -4, 2)
      if (s.kind === 'garrison') for (let k = 0; k < 3; k++) place('guard-' + s.tag + k, 'guard', -4 + k * 4, -4)
      for (let k = 0; k < 4; k++) place('house-' + s.tag + k, 'house', -4 + k * 2, 3)
    }
    // plots: the settled country farms around its towns
    for (let k = 0; k < 4; k++) {
      const p = at(-5 + k * 3, 5)
      if (inB(p.x, p.y) && !taken.has(key(p.x, p.y)) && !isWater(g, p.x, p.y)) put('plot-' + s.tag + k, 'plot', p.x, p.y, { plantedAt: 0 })
    }
  }

  // ---- scattered plots in the heartlands ----
  let pl = 0
  for (let i = 0; i < 900 && pl < 62; i++) {
    const h = H32('plot', i)
    const x = 1 + (h.readUInt16BE(0) % (W - 2)), y = 1 + (h.readUInt16BE(2) % (H - 2))
    if (!free(x, y) || biomeAt(g, x, y) !== 'heartlands') continue
    put('plotf-' + (pl++), 'plot', x, y, { plantedAt: 0 })
  }

  // ---- fishing: the shore is SAMPLED, not paved ----
  // The classic generator marks every water-adjacent tile fishable, which on a
  // 4x map would spend the entire node budget on shoreline. Sampling every
  // third stretch gives more absolute fishing than the classic world at a
  // fifth of the cost, and leaves the budget for actual country.
  let fs = 0
  const shoreOf = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWater(g, x + dx, y + dy)) return true
    return false
  }
  // one dry tile in five along the whole shore, chosen by the tile's own hash so
  // every node picks the same ones. ~700 spots from ~3,800 tiles of coast.
  for (let y = 1; y < H - 1 && fs < 700; y++) {
    for (let x = 1; x < W - 1 && fs < 700; x++) {
      if (!free(x, y) || !shoreOf(x, y)) continue
      if (thash(g, x, y, 5) % 5 !== 0) continue
      put('fish-' + (fs++), 'fishing-spot', x, y)
    }
  }

  // ---- the country itself: each biome's signature ----
  const scatter = (tag, want, pred, place) => {
    let n = 0
    for (let i = 0; i < want * 26 && n < want; i++) {
      const h = H32(tag, i)
      const x = 1 + (h.readUInt16BE(0) % (W - 2)), y = 1 + (h.readUInt16BE(2) % (H - 2))
      if (!free(x, y) || !pred(x, y, h)) continue
      place(tag + '-' + n, x, y); taken.add(key(x, y)); n++
    }
    return n
  }
  const B = (x, y) => biomeAt(g, x, y)
  const tree = (id, x, y) => E.addNode(w, id, 'tree', x, y)
  const rock = (id, x, y) => E.addNode(w, id, 'rock', x, y)
  const mrock = (id, x, y) => E.addNode(w, id, 'magic-rock', x, y)

  const counts = {}
  counts.greenwoodTrees = scatter('gwtree', 620, (x, y) => B(x, y) === 'greenwood', tree)
  counts.heartTrees     = scatter('httree', 210, (x, y) => B(x, y) === 'heartlands', tree)
  counts.fenTrees       = scatter('fntree', 130, (x, y) => B(x, y) === 'fens', tree)
  counts.wildTrees      = scatter('wdtree', 140, (x, y) => B(x, y) === 'wilds', tree)
  counts.cragRocks      = scatter('cgrock', 430, (x, y) => B(x, y) === 'crags', rock)
  counts.wildRocks      = scatter('wdrock', 150, (x, y) => B(x, y) === 'wilds', rock)
  counts.heartRocks     = scatter('htrock', 120, (x, y) => B(x, y) === 'heartlands', rock)
  counts.magicWilds     = scatter('wdmagic', 44, (x, y) => B(x, y) === 'wilds', mrock)
  counts.magicCrags     = scatter('cgmagic', 26, (x, y) => B(x, y) === 'crags' && x > W * 0.82, mrock)

  // ---- the beasts, each where it belongs ----
  const mob = (kind) => (id, x, y) => E.addMob(w, id, kind, x, y)
  counts.goblins = scatter('gob', 118, (x, y) => { const b = B(x, y); return b === 'fens' || (b === 'heartlands' && (x < W * 0.4 || y > H * 0.55)) }, mob('goblin'))
  counts.wolves  = scatter('wolf', 68, (x, y) => { const b = B(x, y); return b === 'greenwood' || b === 'fens' }, mob('wolf'))
  counts.bears   = scatter('bear', 44, (x, y) => B(x, y) === 'greenwood' && y < H * 0.22, mob('bear'))
  counts.trolls  = scatter('troll', 50, (x, y) => { const b = B(x, y); return b === 'crags' || (b === 'wilds' && x < W * 0.09) }, mob('troll'))

  // skeleton-knight warbands: the frontier musters in companies, never alone
  let sk = 0
  for (let band = 0; band < 10; band++) {
    const hb = H32('warband', band)
    const bx = 2 + (hb.readUInt16BE(0) % Math.max(1, wildsX1(g) - 4))
    const by = 2 + (hb.readUInt16BE(2) % (H - 4))
    for (let k = 0; k < 5; k++) {
      const hh = H32('skel', sk)
      const x = bx + (hh[0] % 7) - 3, y = by + (hh[1] % 7) - 3
      sk++
      if (!free(x, y)) continue
      taken.add(key(x, y)); E.addMob(w, 'skel-' + sk, 'skeleton-knight', x, y)
    }
  }
  counts.knights = sk

  // ---- waystones: one per town, and anchors out in the country ----
  const putWaystone = (id, x, y) => {
    for (let rad = 0; rad < 6; rad++) for (const [dx, dy] of [[0, rad], [rad, 0], [0, -rad], [-rad, 0], [rad, rad], [-rad, -rad]]) {
      const nx = x + dx, ny = y + dy
      if (inB(nx, ny) && !taken.has(key(nx, ny)) && !isWater(g, nx, ny)) { put(id, 'waystone', nx, ny); return true }
    }
    return false
  }
  for (const s of ss) putWaystone('waystone-' + s.tag, s.x, rectOf(s).y1 + 3)
  const frontier = [
    ['wildsnorth', Math.round(W * 0.10), Math.round(H * 0.14)],
    ['wildssouth', Math.round(W * 0.10), Math.round(H * 0.80)],
    ['wildsdeep',  Math.round(W * 0.05), Math.round(H * 0.48)],
    ['cragshigh',  Math.round(W * 0.92), Math.round(H * 0.30)],
    ['cragsdeep',  Math.round(W * 0.92), Math.round(H * 0.66)],
    ['greendeep',  Math.round(W * 0.60), Math.round(H * 0.08)],
    ['greenwest',  Math.round(W * 0.30), Math.round(H * 0.10)],
    ['fensdeep',   Math.round(W * 0.60), Math.round(H * 0.92)],
    ['fenswest',   Math.round(W * 0.28), Math.round(H * 0.88)],
    ['baywatch',   Math.round(W * 0.70), Math.round(H * 0.90)],
    ['crossroads', Math.round(W * 0.50), Math.round(H * 0.66)],
  ]
  for (const [tag, x, y] of frontier) putWaystone('waystone-' + tag, x, y)

  const serr = E.validateState(w)
  if (serr) throw new Error('worldgen produced an invalid state (' + serr + ') — founding aborted')
  w._composition = counts
  return w
}
