// Interval worldgen: THE EXPANSE, second founding (interval-expanse-v2).
//
// The land is the land: the river, the bay, the pools, and the five countries
// are imported unchanged from the first expanse, so a citizen who knew the
// old country still knows this one. What changed is everything the audit and
// the walk revealed:
//
//   - **A water town stands on its water.** Millbrook's wheel turns in the
//     river; Fenmarch is a river port in the fens; Eastmere opens on the bay
//     through a watergate. A port with no dock was a promise the terrain
//     didn't keep.
//   - **Where a road meets a wall, that is a gate.** The first expanse cut
//     gates on the town's axes and let diagonal roads run into masonry
//     beside them. Now the wall yields to the road, wherever the road
//     arrives.
//   - **The country is thicker.** The first greenwood held one tree per
//     hundred tiles — a wood that was mostly the idea of a wood. Densities
//     roughly double across the wild countries, and the beasts with them.
//     Measured, not assumed: see test/expanse2.test.mjs for the envelope
//     this founding was benchmarked into.
//   - **Rest on the road.** Each spoke carries a wayside hearth near its
//     midpoint — light and cooked food halfway through the long walk.
//
// Per PRELAUNCH-AUDIT §6, this ships as a NEW GENERATOR ID: the first
// expanse's worlds keep their country, and a divergence is an announcement,
// never an accident.
import E from './engine.js'
import {
  seedNum, meander, thash, riverX, inSea, inPool, isWater, wildsX1, biomeAt,
} from './worldgen-expanse.mjs'
export { seedNum, meander, thash, riverX, inSea, inPool, isWater, wildsX1, biomeAt }

export const GENERATOR_ID = 'interval-expanse-v2'
export const WORLDGEN_MIN = { w: 256, h: 160 }

// The seven settlements. Three now stand on the water their names promised:
// the river towns sit six tiles east of the river's centerline at their own
// latitude (the river runs along their western streets, inside the walls,
// entering through watergates), and Eastmere's southeast corner opens on the
// bay. Positions remain pure in the founding record — riverX is seed-pure —
// so every node and every window agrees where the towns stand.
export function settlementsOf(g) {
  const W = g.worldW, H = g.worldH
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const mby = Math.round(H * 0.24), fmy = Math.round(H * 0.84)
  return [
    { tag: 'anchor',     name: 'Anchor',     x: cx,                     y: cy,  w: 24, h: 14, kind: 'capital' },
    { tag: 'greenhollow',name: 'Greenhollow',x: Math.round(W * 0.46),   y: Math.round(H * 0.14), w: 14, h: 10, kind: 'timber' },
    { tag: 'millbrook',  name: 'Millbrook',  x: riverX(g, mby) + 6,     y: mby, w: 14, h: 10, kind: 'mill' },
    { tag: 'cragfoot',   name: 'Cragfoot',   x: Math.round(W * 0.86),   y: Math.round(H * 0.50), w: 14, h: 10, kind: 'forge' },
    { tag: 'eastmere',   name: 'Eastmere',   x: Math.round(W * 0.85),   y: Math.round(H * 0.80), w: 14, h: 10, kind: 'port' },
    { tag: 'fenmarch',   name: 'Fenmarch',   x: riverX(g, fmy) + 6,     y: fmy, w: 14, h: 10, kind: 'port' },
    { tag: 'norwick',    name: 'Norwick',    x: Math.round(W * 0.26),   y: Math.round(H * 0.46), w: 16, h: 12, kind: 'garrison' },
  ]
}
export const rectOf = (s) => ({
  x0: s.x - (s.w >> 1), x1: s.x + (s.w >> 1),
  y0: s.y - (s.h >> 1), y1: s.y + (s.h >> 1),
})

// Roads: spokes to Anchor, as before, computed against the v2 settlements.
export function roadBendsOf(g) {
  const ss = settlementsOf(g), a = ss[0]
  const out = []
  for (let i = 1; i < ss.length; i++) {
    const s = ss[i]
    const vx = s.x - a.x, vy = s.y - a.y
    const L = Math.sqrt(vx * vx + vy * vy)
    const segs = Math.max(2, Math.round(L / 26))
    for (let k = 1; k < segs; k++) {
      const u = k * 26
      const t = u / L
      if (t <= 0.08 || t >= 0.92) continue
      const taper = Math.min(1, Math.min(t, 1 - t) * 6)
      const off = meander(g, 90 + i, u, 26, 9) * taper
      if (Math.abs(off) < 4) continue
      out.push({ x: Math.round(a.x + vx * t), y: Math.round(a.y + vy * t), off })
    }
  }
  return out
}

const _roadMemo = new Map()
export function roadTilesOf(g) {
  const key = g.genesisSeed + ':' + g.worldW + 'x' + g.worldH
  const hit = _roadMemo.get(key)
  if (hit) return hit
  const ss = settlementsOf(g), a = ss[0]
  const set = new Set()
  for (let i = 1; i < ss.length; i++) {
    const s = ss[i]
    const vx = s.x - a.x, vy = s.y - a.y
    const L = Math.sqrt(vx * vx + vy * vy)
    const nx = -vy / L, ny = vx / L
    const steps = Math.ceil(L * 2)
    for (let stp = 0; stp <= steps; stp++) {
      const t = stp / steps
      const taper = Math.min(1, Math.min(t, 1 - t) * 6)
      const o = meander(g, 90 + i, t * L, 26, 9) * taper
      const px = Math.round(a.x + vx * t + nx * o)
      const py = Math.round(a.y + vy * t + ny * o)
      set.add(px + ',' + py)
      set.add((px + 1) + ',' + py)
    }
  }
  _roadMemo.set(key, set)
  return set
}
export const onRoad = (g, x, y) => roadTilesOf(g).has(x + ',' + y)

// Fords: crossings exist where the road crosses and along every town's main
// street — same law as the first expanse. What v2 adds is not a new crossing
// but a visible one: windows paint every ford tile as planks (a bridge), so a
// crossing the rules permit is a crossing the eye can find.
export function fordAt(g, x, y) {
  if (onRoad(g, x, y)) return true
  for (const s of settlementsOf(g)) {
    const r = rectOf(s)
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
      && (x === s.x || y === s.y)) return true
  }
  return false
}
export function spawnDry(g) {
  const cx = Math.floor(g.worldW / 2), cy = Math.floor(g.worldH / 2)
  if (!isWater(g, cx, cy)) return { x: cx, y: cy }
  for (let r = 1; r < 96; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
      const x = cx + dx, y = cy + dy
      if (x < 2 || y < 2 || x >= g.worldW - 2 || y >= g.worldH - 2) continue
      if (!isWater(g, x, y)) return { x, y }
    }
  return { x: cx, y: cy }
}
E.registerTerrain(GENERATOR_ID, {
  blocked: (g, x, y) => isWater(g, x, y) && !fordAt(g, x, y),
  spawn: (g) => spawnDry(g),
  country: (g, x, y) => biomeAt(g, x, y),
})

// ---------- the founding ----------
export function makeExpanse2Genesis(genesisSeed, rulesHash, anchorMs = 0, W = 640, H = 400) {
  const g = E.makeGenesis(genesisSeed, rulesHash, anchorMs, W, H)
  g.worldGenerator = GENERATOR_ID
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const nw = settlementsOf(g).find(s => s.tag === 'norwick')
  g.geo = {
    city:    { x0: cx - 12, x1: cx + 12, y0: cy - 7, y1: cy + 7 },
    wilds:   { x0: 1, x1: Math.round(W * 0.19), y0: 1, y1: H - 2 },
    norwick: { x0: nw.x - 8, x1: nw.x + 8, y0: nw.y - 6, y1: nw.y + 6 },
  }
  g.watch = { level: 60, kindleLogs: 10, perLog: 420, cap: 12600, xpPerLog: 200, burnXp: 1, maxOwned: 4, decayTicks: 432000 }
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
  const free = (x, y) => inB(x, y) && !taken.has(key(x, y)) && !isWater(g, x, y)
    && !onRoad(g, x, y) && !inAnySettlement(x, y)

  const H32 = (tag, i) => E.sha256(Buffer.from(g.genesisSeed + ':' + tag + ':' + i))

  // ---- the seven settlements ----
  // A wall stops at the water's edge (watergate), and NOW ALSO at the road:
  // wherever the trail meets the wall, the wall opens. A road that dead-ends
  // into masonry two tiles from the gate was the first expanse's worst welcome.
  for (const s of ss) {
    const r = rectOf(s)
    let wi = 0
    const gapx = s.x, gapy = s.y
    const open = (x, y) => isWater(g, x, y) || onRoad(g, x, y)
    for (let x = r.x0; x <= r.x1; x++) for (const y of [r.y0, r.y1]) {
      if (Math.abs(x - gapx) <= 1) continue
      if (inB(x, y) && !open(x, y)) put('wall-' + s.tag + '-' + (wi++), 'wall', x, y)
    }
    for (let y = r.y0 + 1; y < r.y1; y++) for (const x of [r.x0, r.x1]) {
      if (Math.abs(y - gapy) <= 1) continue
      if (inB(x, y) && !open(x, y)) put('wall-' + s.tag + '-' + (wi++), 'wall', x, y)
    }
    const at = (dx, dy) => ({ x: s.x + dx, y: s.y + dy })
    const place = (id, type, dx, dy, extra) => { const p = at(dx, dy); if (inB(p.x, p.y) && !taken.has(key(p.x, p.y)) && !isWater(g, p.x, p.y)) put(id, type, p.x, p.y, extra) }
    // A town's essentials step aside from the water rather than drown: if a
    // fixed offset lands in the river (the river towns are ON the river now),
    // the building takes the nearest free dry tile inside the walls, by a
    // deterministic ring search — every node seats the same bank on the same
    // ground. The first expanse skipped a drowned offset silently, which is
    // how a town could quietly lose its bank.
    const placeNear = (id, type, dx, dy, extra) => {
      for (let rad = 0; rad <= 4; rad++) for (let ody = -rad; ody <= rad; ody++) for (let odx = -rad; odx <= rad; odx++) {
        if (Math.max(Math.abs(odx), Math.abs(ody)) !== rad) continue
        const p = at(dx + odx, dy + ody)
        if (p.x <= r.x0 || p.x >= r.x1 || p.y <= r.y0 || p.y >= r.y1) continue
        if (!inB(p.x, p.y) || taken.has(key(p.x, p.y)) || isWater(g, p.x, p.y)) continue
        put(id, type, p.x, p.y, extra); return
      }
    }
    placeNear('bank-' + s.tag, 'bank', -3, -2)
    placeNear('well-' + s.tag, 'well', 0, 0)
    placeNear('hearth-' + s.tag, 'campfire', 2, -2)
    placeNear('sign-' + s.tag, 'signpost', 0, 3, { text: s.name })
    if (s.kind === 'capital') {
      placeNear('anvil-' + s.tag, 'anvil', 3, -2); placeNear('smith-' + s.tag, 'smith', 4, -2)
      placeNear('store-' + s.tag, 'store', -4, 2); placeNear('store2-' + s.tag, 'store', 5, 2)
      placeNear('anvil2-' + s.tag, 'anvil', -5, -2)
      for (let k = 0; k < 6; k++) place('house-' + s.tag + k, 'house', -6 + k * 2, 4)
      for (let k = 0; k < 4; k++) place('guard-' + s.tag + k, 'guard', -8 + k * 5, -5)
    } else {
      if (s.kind === 'forge' || s.kind === 'garrison' || s.kind === 'mill') {
        placeNear('anvil-' + s.tag, 'anvil', 3, -2); placeNear('smith-' + s.tag, 'smith', 4, -2)
      }
      if (s.kind === 'port' || s.kind === 'timber' || s.kind === 'mill') placeNear('store-' + s.tag, 'store', -4, 2)
      if (s.kind === 'garrison') for (let k = 0; k < 3; k++) place('guard-' + s.tag + k, 'guard', -4 + k * 4, -4)
      for (let k = 0; k < 4; k++) place('house-' + s.tag + k, 'house', -4 + k * 2, 3)
    }
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

  // ---- fishing: sampled shore, budget raised with the rest of the country ----
  let fs = 0
  const shoreOf = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWater(g, x + dx, y + dy)) return true
    return false
  }
  for (let y = 1; y < H - 1 && fs < 850; y++) {
    for (let x = 1; x < W - 1 && fs < 850; x++) {
      if (!free(x, y) || !shoreOf(x, y)) continue
      if (thash(g, x, y, 5) % 5 !== 0) continue
      put('fish-' + (fs++), 'fishing-spot', x, y)
    }
  }

  // ---- what the trails go around ----
  let wm = 0
  for (const b of roadBendsOf(g)) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]) {
      const x = b.x + dx, y = b.y + dy
      if (!free(x, y)) continue
      const bi = biomeAt(g, x, y)
      const stone = bi === 'crags' || bi === 'wilds' || (thash(g, x, y, 61) % 3) === 0
      taken.add(key(x, y))
      E.addNode(w, 'waymark-' + (wm++), stone ? 'rock' : 'tree', x, y)
      break
    }
  }
  const _waymarks = wm

  // ---- wayside hearths: rest at the middle of the long walk ----
  // Every spoke carries a permanent campfire near its midpoint, set a step
  // off the trail. Light, warmth, and somewhere to cook, halfway to anywhere.
  let wr = 0
  {
    const a = ss[0]
    for (let i = 1; i < ss.length; i++) {
      const s = ss[i]
      const vx = s.x - a.x, vy = s.y - a.y
      const L = Math.sqrt(vx * vx + vy * vy)
      const nx = -vy / L, ny = vx / L
      const t = 0.5
      const taper = Math.min(1, Math.min(t, 1 - t) * 6)
      const o = meander(g, 90 + i, t * L, 26, 9) * taper
      placed: for (const side of [2, -2, 3, -3]) {
        const x = Math.round(a.x + vx * t + nx * (o + side))
        const y = Math.round(a.y + vy * t + ny * (o + side))
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
          if (free(x + dx, y + dy)) { put('wayrest-' + (wr++), 'campfire', x + dx, y + dy); break placed }
        }
      }
    }
  }
  const _wayrests = wr

  // ---- the country itself, thickened ----
  // The first expanse held one greenwood tree per ~106 tiles: a wood in name.
  // v2 roughly doubles the wild countries. These counts were BENCHED before
  // they were founded (test/expanse2.test.mjs pins the measured envelope).
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

  const counts = { waymarks: _waymarks, wayrests: _wayrests }
  const A = (n) => Math.max(1, Math.round(n * (W * H) / (640 * 400)))
  counts.greenwoodTrees = scatter('gwtree', A(1500), (x, y) => B(x, y) === 'greenwood', tree)
  counts.heartTrees     = scatter('httree', A(460), (x, y) => B(x, y) === 'heartlands', tree)
  counts.fenTrees       = scatter('fntree', A(300), (x, y) => B(x, y) === 'fens', tree)
  counts.wildTrees      = scatter('wdtree', A(260), (x, y) => B(x, y) === 'wilds', tree)
  counts.cragRocks      = scatter('cgrock', A(860), (x, y) => B(x, y) === 'crags', rock)
  counts.wildRocks      = scatter('wdrock', A(280), (x, y) => B(x, y) === 'wilds', rock)
  counts.heartRocks     = scatter('htrock', A(250), (x, y) => B(x, y) === 'heartlands', rock)
  counts.magicWilds     = scatter('wdmagic', A(54), (x, y) => B(x, y) === 'wilds', mrock)
  counts.magicCrags     = scatter('cgmagic', A(34), (x, y) => B(x, y) === 'crags' && x > W * 0.82, mrock)

  // ---- the beasts, each where it belongs, in fuller number ----
  const mob = (kind) => (id, x, y) => E.addMob(w, id, kind, x, y)
  counts.goblins = scatter('gob', A(168), (x, y) => { const b = B(x, y); return b === 'fens' || (b === 'heartlands' && (x < W * 0.4 || y > H * 0.55)) }, mob('goblin'))
  counts.wolves  = scatter('wolf', A(108), (x, y) => { const b = B(x, y); return b === 'greenwood' || b === 'fens' }, mob('wolf'))
  counts.bears   = scatter('bear', A(62), (x, y) => B(x, y) === 'greenwood' && y < H * 0.22, mob('bear'))
  counts.trolls  = scatter('troll', A(70), (x, y) => { const b = B(x, y); return b === 'crags' || (b === 'wilds' && x < W * 0.09) }, mob('troll'))

  let sk = 0
  for (let band = 0; band < A(13); band++) {
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
