// Interval worldgen: THE EXPANSE, third founding (interval-expanse-v3).
//
// The structural lesson of the maps this world descends from: geography must
// pose routing problems, and a border must be a thing you can stand beside.
// So in the third founding, **every border is a physical feature**:
//
//   the world | nothing     = the COAST — the world is an island with a
//                             silhouette, ringed by sea instead of an
//                             invisible wall
//   wilds     | heartlands  = the BRANDLINE — a scorched march marked by
//                             standing stones, freely crossable: a line you
//                             step over deliberately
//   heartland | crags       = the RIDGE — high stone that bars the way,
//                             crossed at the North Pass and the South Pass,
//                             or skirted the long way through the deep wood
//                             where the ridge sinks beneath the trees
//   heartland | greenwood   = the TREELINE (a meander, not a ruler)
//   heartland | fens        = the FENLINE (likewise)
//
// The Great River gains a biography: it rises in the northern wood, passes
// Millbrook, gathers the western Marchwater at the WATERSMEET, and reaches
// the bay as a delta at Fenmarch's feet. Stillwater lies in the eastern wood.
// Two islands stand off the coast: SHRINE ISLE, reached by a long causeway
// and carrying a waystone (the pilgrimage is walked once; the recall is
// yours forever), and the FARSHORE, which is reached by nothing at all.
//
// Roads are a GRAPH of routes through named junctions, with three
// independent loops — a walk can be a circuit. Settlements SELF-SEAT from
// the geography (the port from the bay's shoreline, the river towns from
// the river) rather than sitting at fractions the terrain could drown.
//
// Determinism is stricter here than anywhere, as always: no transcendentals.
// The coast's angular parameter is built from octant arithmetic (+ - * /
// and comparisons only), not atan2, which ECMA-262 leaves implementation-
// defined. Math.sqrt is exactly rounded and lawful.
//
// Per PRELAUNCH-AUDIT §6 and SPEC §9c this ships as a NEW GENERATOR ID.
import E from './engine.js'
import { seedNum, meander, thash } from './worldgen-expanse.mjs'
export { seedNum, meander, thash }

export const GENERATOR_ID = 'interval-expanse-v3'
export const WORLDGEN_MIN = { w: 448, h: 256 }

// ---------- the coast ----------
// Angular parameter u in [0,360): piecewise-linear angle from octant
// arithmetic. Exact ops only; continuous across octant boundaries.
export function angleOf(dx, dy) {
  const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy
  if (ax === 0 && ay === 0) return 0
  if (dx > 0 && dy >= 0) return ax >= ay ? (ay / ax) * 45 : 90 - (ax / ay) * 45
  if (dx <= 0 && dy > 0) return ay > ax ? 90 + (ax / ay) * 45 : 180 - (ay / ax) * 45
  if (dx < 0 && dy <= 0) return ax >= ay ? 180 + (ay / ax) * 45 : 270 - (ax / ay) * 45
  return ay > ax ? 270 + (ax / ay) * 45 : 360 - (ay / ax) * 45
}
// The island's radius at angle u: a base circle, two meander harmonics for
// raggedness, and the named capes and gulfs. East is 0, south is 90.
export function coastR(g, u0) {
  const u = ((u0 % 360) + 360) % 360
  let r = 0.80 + meander(g, 301, u / 5, 10, 12) / 130 + meander(g, 302, u / 5, 4, 6) / 160
  const bump = (c, w, amt) => {
    const d1 = u - c < 0 ? c - u : u - c
    const d = d1 < 360 - d1 ? d1 : 360 - d1
    if (d < w) r += amt * (1 - d / w)
  }
  bump(180, 28, +0.18)  // the Wilds cape: the west reaches out
  bump(150, 12, -0.09)  // ...past a pinched neck
  bump(210, 12, -0.09)  //    on both shoulders
  bump(38, 22, -0.12)   // the bay: the southeast bitten in
  bump(78, 16, -0.07)   // the fen estuary
  bump(0, 14, +0.07)    // the east cape below the crags
  bump(305, 18, +0.06)  // a northern headland
  return r
}
export function inSeaBase(g, x, y) { // the coast alone, before the islands
  const dx = (x - g.worldW / 2) / (g.worldW / 2), dy = (y - g.worldH / 2) / (g.worldH / 2)
  const r = Math.sqrt(dx * dx + dy * dy)
  if (r <= 0.52) return false // deep interior: skip the angle work
  return r > coastR(g, angleOf(dx, dy))
}

// ---------- the islands ----------
// Shrine Isle stands off the bay shore at the port's latitude; the Farshore
// stands off the northwest, reached by nothing. Both derive from the coast.
export function emY(g) { return Math.round(g.worldH * 0.75) }
const _shoreMemo = new Map()
export function bayShoreX(g, y) { // last land column before the bay at row y
  const k = g.genesisSeed + ':' + g.worldW + 'x' + g.worldH + ':' + y
  const hit = _shoreMemo.get(k)
  if (hit !== undefined) return hit
  let sx = null
  for (let x = g.worldW - 4; x >= Math.floor(g.worldW / 2); x--)
    if (!inSeaBase(g, x, y)) { sx = x; break }
  _shoreMemo.set(k, sx)
  return sx
}
export function islesOf(g) {
  const ey = emY(g), sh = bayShoreX(g, ey) ?? Math.round(g.worldW * 0.7)
  return [
    { x: sh + 22, y: ey + 26, rx: 10, ry: 7, tag: 'shrine' },
    { x: Math.round(g.worldW * 0.185), y: Math.round(g.worldH * 0.10), rx: 8, ry: 5, tag: 'farshore' },
  ]
}
export function onIsle(g, x, y) {
  for (const i of islesOf(g)) {
    const dx = (x - i.x) / i.rx, dy = (y - i.y) / i.ry
    if (dx * dx + dy * dy < 1) return true
  }
  return false
}
export const inSea = (g, x, y) => inSeaBase(g, x, y) && !onIsle(g, x, y)

// ---------- the borders that are features ----------
export const brandX = (g, y) => Math.round(g.worldW * 0.235 + meander(g, 310, y, 34, 7))
export const ridgeX = (g, y) => Math.round(g.worldW * 0.685 + meander(g, 311, y, 30, 9))
export const treeY  = (g, x) => Math.round(g.worldH * 0.30 + meander(g, 312, x, 44, 11))
export const fenY   = (g, x) => Math.round(g.worldH * 0.71 + meander(g, 313, x, 44, 9))
export const passesOf = (g) => [Math.round(g.worldH * 0.37), Math.round(g.worldH * 0.655)]
export function onRidge(g, x, y) {
  const rx = ridgeX(g, y)
  const d = x - rx < 0 ? rx - x : x - rx
  if (d > 2) return false
  for (const p of passesOf(g)) { const pd = y - p < 0 ? p - y : y - p; if (pd < 4) return false }
  if (y < treeY(g, x) - 8) return false // the ridge sinks beneath the northern wood
  if (inSeaBase(g, x, y)) return false
  return true
}

// ---------- the waters ----------
export const SRC_YF = 0.115 // the Great River rises in the wood
export function riverX(g, y) {
  return Math.floor(g.worldW / 2) + Math.round(meander(g, 21, y, 52, 30) + meander(g, 22, y, 16, 6))
}
export const confY = (g) => Math.round(g.worldH * 0.63)
export function marchWY(g, x) { // the Marchwater: out of the wilds, east to the Watersmeet
  const cyy = confY(g)
  const reach = riverX(g, cyy) - 8 - x
  const t = reach < 0 ? 0 : reach > 70 ? 1 : reach / 70
  return cyy + Math.round(meander(g, 25, x, 36, 12) * t)
}
export function inRiver(g, x, y) {
  const srcY = Math.round(g.worldH * SRC_YF)
  if (y >= srcY) {
    const rx = riverX(g, y)
    const d = x - rx < 0 ? rx - x : x - rx
    if (d <= (y > g.worldH * 0.82 ? 2 : 1)) return true
    if (y > g.worldH * 0.84) { // a distributary in the delta
      const dx2 = rx - 7 + Math.round(meander(g, 27, y, 9, 3))
      const d2 = x - dx2 < 0 ? dx2 - x : x - dx2
      if (d2 <= 1) return true
    }
  }
  if (x < riverX(g, confY(g)) - 1 && x > brandX(g, y) - 16) {
    const my = marchWY(g, x)
    const d3 = y - my < 0 ? my - y : y - my
    if (d3 <= 1) return true
  }
  return false
}
export function lakeC(g) { return { x: Math.round(g.worldW * 0.73), y: Math.round(g.worldH * 0.22) } }
export function inLake(g, x, y) {
  const c = lakeC(g), dx = (x - c.x) / 24, dy = (y - c.y) / 13
  return dx * dx + dy * dy < 1
}
export const isWater = (g, x, y) => inSea(g, x, y) || inRiver(g, x, y) || inLake(g, x, y)

export function biomeAt(g, x, y) {
  if (inSeaBase(g, x, y) && !onIsle(g, x, y)) return 'sea'
  if (x <= brandX(g, y)) return 'wilds'
  if (x >= ridgeX(g, y) && y >= treeY(g, x) - 8) return 'crags'
  if (y <= treeY(g, x)) return 'greenwood'
  if (y >= fenY(g, x)) return 'fens'
  return 'heartlands'
}

// ---------- the seven settlements, self-seated ----------
export function settlementsOf(g) {
  const W = g.worldW, H = g.worldH
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const mby = Math.round(H * 0.305), fmy = Math.round(H * 0.825), ey = emY(g)
  const shore = bayShoreX(g, ey) ?? Math.round(W * 0.7)
  return [
    { tag: 'anchor',     name: 'Anchor',     x: cx,                   y: cy,  w: 24, h: 14, kind: 'capital' },
    { tag: 'greenhollow',name: 'Greenhollow',x: Math.round(W * 0.40), y: Math.round(H * 0.16), w: 14, h: 10, kind: 'timber' },
    { tag: 'millbrook',  name: 'Millbrook',  x: riverX(g, mby) + 6,   y: mby, w: 14, h: 10, kind: 'mill' },
    { tag: 'cragfoot',   name: 'Cragfoot',   x: Math.round(W * 0.87), y: Math.round(H * 0.49), w: 14, h: 10, kind: 'forge' },
    { tag: 'eastmere',   name: 'Eastmere',   x: shore - 5,            y: ey,  w: 14, h: 10, kind: 'port' },
    { tag: 'fenmarch',   name: 'Fenmarch',   x: riverX(g, fmy) + 6,   y: fmy, w: 14, h: 10, kind: 'port' },
    { tag: 'norwick',    name: 'Norwick',    x: Math.round(W * 0.235) + 20, y: Math.round(H * 0.49), w: 16, h: 12, kind: 'garrison' },
  ]
}
export const rectOf = (s) => ({
  x0: s.x - (s.w >> 1), x1: s.x + (s.w >> 1),
  y0: s.y - (s.h >> 1), y1: s.y + (s.h >> 1),
})

// ---------- the road graph: routes through named junctions, with loops ----------
export function junctionsOf(g) {
  const [p1, p2] = passesOf(g)
  return {
    watersmeet: { x: riverX(g, confY(g)) + 3, y: confY(g) + 3 },
    npass: { x: ridgeX(g, p1), y: p1 },
    spass: { x: ridgeX(g, p2), y: p2 },
    shrine: (() => { const i = islesOf(g)[0]; return { x: i.x, y: i.y } })(),
  }
}
export function roadSegsOf(g) {
  const s = {}; for (const t of settlementsOf(g)) s[t.tag] = t
  const j = junctionsOf(g)
  return [
    [s.anchor, s.millbrook, 91], [s.millbrook, s.greenhollow, 92], [s.greenhollow, s.norwick, 93],
    [s.anchor, s.norwick, 94], [s.anchor, j.npass, 95], [j.npass, s.cragfoot, 96],
    [s.anchor, j.watersmeet, 97], [j.watersmeet, j.spass, 98], [j.spass, s.eastmere, 99],
    [j.watersmeet, s.fenmarch, 100], [s.eastmere, s.fenmarch, 101], [s.cragfoot, s.eastmere, 102],
    [s.eastmere, j.shrine, 103], // the causeway
  ]
}
const _roadMemo = new Map()
export function roadTilesOf(g) {
  const key = g.genesisSeed + ':' + g.worldW + 'x' + g.worldH
  const hit = _roadMemo.get(key)
  if (hit) return hit
  const set = new Set()
  for (const [a, b, tag] of roadSegsOf(g)) {
    const vx = b.x - a.x, vy = b.y - a.y
    const L = Math.sqrt(vx * vx + vy * vy)
    const nx = -vy / L, ny = vx / L
    const steps = Math.ceil(L * 2)
    for (let stp = 0; stp <= steps; stp++) {
      const t = stp / steps
      const taper = Math.min(1, Math.min(t, 1 - t) * 6)
      const o = meander(g, tag, t * L, 26, 8) * taper
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
export function roadBendsOf(g) {
  const out = []
  for (const [a, b, tag] of roadSegsOf(g)) {
    const vx = b.x - a.x, vy = b.y - a.y
    const L = Math.sqrt(vx * vx + vy * vy)
    const segs = Math.max(2, Math.round(L / 26))
    for (let k = 1; k < segs; k++) {
      const u = k * 26, t = u / L
      if (t <= 0.08 || t >= 0.92) continue
      const taper = Math.min(1, Math.min(t, 1 - t) * 6)
      const off = meander(g, tag, u, 26, 8) * taper
      if (Math.abs(off) < 4) continue
      out.push({ x: Math.round(a.x + vx * t), y: Math.round(a.y + vy * t), off })
    }
  }
  return out
}

// Fords: the road pays for its crossings (the causeway included), and every
// main street crosses on pilings. Windows paint every ford as a BRIDGE.
export function fordAt(g, x, y) {
  if (onRoad(g, x, y)) return true
  for (const s of settlementsOf(g)) {
    const r = rectOf(s)
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
      && (x === s.x || y === s.y)) return true
  }
  return false
}
// A pass is where the ridge is absent; elsewhere the high stone bars the way.
// The composite answer is memoized per tile: terrain is immutable for the
// life of a genesis, movement asks the same tiles hundreds of thousands of
// times per tick at population, and the coast alone costs a square root and
// nine meanders per fresh ask. (v1 precedent: "a pure function may remember
// its own answers.") 0 = unknown, 1 = open, 2 = blocked.
const _blockedCache = new Map()
export function blockedAt(g, x, y) {
  if (x < 0 || y < 0 || x >= g.worldW || y >= g.worldH) return true
  const ck = g.genesisSeed + ':' + g.worldW + 'x' + g.worldH
  let arr = _blockedCache.get(ck)
  if (!arr) { arr = new Uint8Array(g.worldW * g.worldH); _blockedCache.set(ck, arr) }
  const i = y * g.worldW + x
  const hit = arr[i]
  if (hit) return hit === 2
  let b = false
  if (isWater(g, x, y) && !fordAt(g, x, y)) b = true
  else if (onRidge(g, x, y) && !onRoad(g, x, y)) b = true
  arr[i] = b ? 2 : 1
  return b
}
// ---- the keepers' names (v0.79): a pure function of town and role,
// mirrored by every window. No byte of state stores 'Maud': she is
// COMPUTED, identically, forever. First names of an island. ----
const KEEPER_NAMES = ['Maud', 'Aldric', 'Bess', 'Corwin', 'Delia', 'Edmund', 'Ffion', 'Gareth',
  'Hild', 'Ivo', 'Joan', 'Kemp', 'Lettice', 'Miles', 'Nell', 'Osric', 'Peronel', 'Quill',
  'Rosamund', 'Sim', 'Tilda', 'Ulric', 'Verity', 'Wat', 'Ysolt', 'Zachary']
export function keeperName(tag, role) {
  const h = E.sha256('keeper|' + tag + '|' + role)
  return KEEPER_NAMES[h[0] % KEEPER_NAMES.length]
}

// ---- the ground beneath (v0.79): SURFACE KINDS ----
// The constitution cares only whether ground blocks; the WINDOWS care
// what it feels like. This function is the canonical answer, mirrored
// verbatim by every window and the chart: cobble where roads run near
// towns (civilization paves), gravel on the Ridge passes, trail in the
// open country, flagstone inside town walls, sand where land meets
// water. Pure in the genesis; no window may disagree about where the
// cobbles end.
export function groundKindAt(g, x, y) {
  if (isWater(g, x, y)) return null
  const sts = settlementsOf(g)
  for (const st of sts) {
    const r = rectOf(st)
    if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return onRoad(g, x, y) ? 'cobble' : 'flag'
  }
  if (onRoad(g, x, y)) {
    for (const st of sts) if (Math.max(Math.abs(x - st.x), Math.abs(y - st.y)) <= 15) return 'cobble'
    if (onRidge(g, x - 1, y) || onRidge(g, x + 1, y) || onRidge(g, x, y - 1) || onRidge(g, x, y + 1)
      || biomeAt(g, x, y) === 'crags') return 'gravel'
    return 'trail'
  }
  if (isWater(g, x + 1, y) || isWater(g, x - 1, y) || isWater(g, x, y + 1) || isWater(g, x, y - 1)) return 'sand'
  return null // the biome's own ground
}

export function spawnDry(g) {
  const cx = Math.floor(g.worldW / 2), cy = Math.floor(g.worldH / 2)
  if (!blockedAt(g, cx, cy) && !isWater(g, cx, cy)) return { x: cx, y: cy }
  for (let r = 1; r < 128; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
      const x = cx + dx, y = cy + dy
      if (x < 2 || y < 2 || x >= g.worldW - 2 || y >= g.worldH - 2) continue
      if (!isWater(g, x, y) && !blockedAt(g, x, y)) return { x, y }
    }
  return { x: cx, y: cy }
}
E.registerTerrain(GENERATOR_ID, {
  blocked: (g, x, y) => blockedAt(g, x, y),
  spawn: (g) => spawnDry(g),
  country: (g, x, y) => biomeAt(g, x, y),
})

// ---------- the founding ----------
export function makeExpanse3Genesis(genesisSeed, rulesHash, anchorMs = 0, W = 896, H = 512) {
  const g = E.makeGenesis(genesisSeed, rulesHash, anchorMs, W, H)
  g.worldGenerator = GENERATOR_ID
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2)
  const nw = settlementsOf(g).find(s => s.tag === 'norwick')
  g.geo = {
    city:    { x0: cx - 12, x1: cx + 12, y0: cy - 7, y1: cy + 7 },
    // The LEGAL wilds sit strictly inside the VISUAL wilds (the Brandline
    // meanders east of this rectangle): a citizen may find themselves west
    // of a stone yet already safe, never the reverse. The land warns before
    // the law binds.
    wilds:   { x0: 1, x1: Math.round(W * 0.235) - 8, y0: 1, y1: H - 2 },
    norwick: { x0: nw.x - 8, x1: nw.x + 8, y0: nw.y - 6, y1: nw.y + 6 },
  }
  g.watch = { level: 60, kindleLogs: 10, perLog: 420, cap: 12600, xpPerLog: 200, burnXp: 1, maxOwned: 4, decayTicks: 432000 }
  // Founded from survey-sim-expanse3 (the SPEC 7c discipline) against the
  // v0.79 placement rule, on THIS geometry at 896x512: the recall-optimal
  // solo explorer (all stones attuned, ~163 surveys/hr, mean marker distance
  // ~162 tiles) reaches 99 in ~117h. max sits at the p99 distance (393 tiles)
  // so the deep frontier still pays past the cap. NOT a universal curve.
  g.survey = { k: 16, base: 40, perTile: 4, max: 1600 }
  return g
}

export function buildWorld(genesis) {
  const gerr = E.validateGenesis(genesis)
  if (gerr) throw new Error('refusing to build a world from an invalid genesis: ' + gerr)
  if (genesis.worldGenerator !== GENERATOR_ID)
    throw new Error(`this genesis names generator ${JSON.stringify(genesis.worldGenerator)}; this node implements ${GENERATOR_ID}`)
  if (genesis.worldW < WORLDGEN_MIN.w || genesis.worldH < WORLDGEN_MIN.h)
    throw new Error(`the third expanse requires at least ${WORLDGEN_MIN.w}x${WORLDGEN_MIN.h}`)

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
    && !onRidge(g, x, y) && !onRoad(g, x, y) && !fordAt(g, x, y) && !inAnySettlement(x, y)

  const H32 = (tag, i) => E.sha256(Buffer.from(g.genesisSeed + ':' + tag + ':' + i))

  // ---- the seven settlements (v2's law: walls yield to water and to roads;
  // essentials seat by ring search and never drown) ----
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
    const sp0 = spawnDry(g) // the spawn tile is hallowed ground (v0.78):
    // citizens wake at the world's center, and were waking INSIDE the
    // well that placeNear seated on that same tile. No furniture may
    // stand where souls arrive; the well slides one ring out.
    const placeNear = (id, type, dx, dy, extra) => {
      for (let rad = 0; rad <= 4; rad++) for (let ody = -rad; ody <= rad; ody++) for (let odx = -rad; odx <= rad; odx++) {
        if (Math.max(Math.abs(odx), Math.abs(ody)) !== rad) continue
        const p = at(dx + odx, dy + ody)
        if (p.x <= r.x0 || p.x >= r.x1 || p.y <= r.y0 || p.y >= r.y1) continue
        if (p.x === sp0.x && p.y === sp0.y) continue
        if (!inB(p.x, p.y) || taken.has(key(p.x, p.y)) || isWater(g, p.x, p.y)) continue
        put(id, type, p.x, p.y, extra); return
      }
    }
    placeNear('bank-' + s.tag, 'bank', -3, -2)
    placeNear('kpr-bank-' + s.tag, 'keeper', -3, -3) // the banker stands at their counter
    placeNear('well-' + s.tag, 'well', 0, 0)
    placeNear('hearth-' + s.tag, 'campfire', 2, -2)
    // The capital's sign carries the island's name: Tallyholm, the tally
    // being the split stick whose two halves prove each other. A traveler
    // learns where they are from the land, not from a website.
    placeNear('sign-' + s.tag, 'signpost', 0, 3, { text: s.kind === 'capital' ? 'Anchor, on Tallyholm' : s.name })
    if (s.kind === 'capital') {
      placeNear('anvil-' + s.tag, 'anvil', 3, -2); placeNear('smith-' + s.tag, 'smith', 4, -2)
      placeNear('store-' + s.tag, 'store', -4, 2); placeNear('store2-' + s.tag, 'store', 5, 2)
      placeNear('kpr-store-' + s.tag, 'keeper', -4, 3); placeNear('kpr-store2-' + s.tag, 'keeper', 5, 3)
      placeNear('anvil2-' + s.tag, 'anvil', -5, -2)
      for (let k = 0; k < 6; k++) place('house-' + s.tag + k, 'house', -6 + k * 2, 4)
      for (let k = 0; k < 4; k++) place('guard-' + s.tag + k, 'guard', -8 + k * 5, -5)
    } else {
      if (s.kind === 'forge' || s.kind === 'garrison' || s.kind === 'mill') {
        placeNear('anvil-' + s.tag, 'anvil', 3, -2); placeNear('smith-' + s.tag, 'smith', 4, -2)
      }
      if (s.kind === 'port' || s.kind === 'timber' || s.kind === 'mill') {
        placeNear('store-' + s.tag, 'store', -4, 2)
        placeNear('kpr-store-' + s.tag, 'keeper', -4, 3)
      }
      if (s.kind === 'garrison') for (let k = 0; k < 3; k++) place('guard-' + s.tag + k, 'guard', -4 + k * 4, -4)
      for (let k = 0; k < 4; k++) place('house-' + s.tag + k, 'house', -4 + k * 2, 3)
    }
    for (let k = 0; k < 4; k++) {
      const p = at(-5 + k * 3, 5)
      if (inB(p.x, p.y) && !taken.has(key(p.x, p.y)) && !isWater(g, p.x, p.y)) put('plot-' + s.tag + k, 'plot', p.x, p.y, { plantedAt: 0 })
    }
  }

  // ---- the Brandline: standing stones along the march, every fourteenth row.
  // Menhirs, not a fence: single unmineable stones with the whole march open
  // between them. The law's edge, visible on the land. ----
  let br = 0
  for (let y = 4; y < H - 4; y += 14) {
    const x = brandX(g, y)
    if (free(x, y) && biomeAt(g, x, y) !== 'sea') { taken.add(key(x, y)); E.addNode(w, 'brandstone-' + (br++), 'wall', x, y) }
  }

  // ---- the four landmarks: never repeated, each a place ----
  // the Old Oak: one great tree in the deep wood, ringed by its children.
  // The Oak itself seats by ring search: a landmark may step aside from the
  // sea or a trail, but it must exist — a named place that failed to be
  // founded would be a lie on every map.
  {
    let ox = Math.round(W * 0.62), oy = Math.round(H * 0.10)
    seek: for (let rad = 0; rad < 24; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
      if (free(ox + dx, oy + dy) && biomeAt(g, ox + dx, oy + dy) === 'greenwood') { ox += dx; oy += dy; break seek }
    }
    put('oldoak', 'landmark', ox, oy, { kind: 'old-oak' }) // the Oak is FOREVER; its children (below) feed the axe
    for (const [dx, dy] of [[-3, 1], [3, 1], [0, 3], [-2, -2], [2, -2]]) {
      if (free(ox + dx, oy + dy)) put('oldoak-child-' + dx + '-' + dy, 'tree', ox + dx, oy + dy)
    }
  }
  // seatLandmark (v0.79b): every monument's seek, hardened. Ring-search
  // from the nominal; if the rings exhaust (the Sentinel once landed in
  // the SEA when no crags lay within thirty tiles of its nominal),
  // raster-scan the whole country for the nearest lawful tile. A
  // landmark may step far aside — but it stands on land, always.
  const seatLandmark = (nomX, nomY, biome, maxRad = 60) => {
    let x = nomX, y = nomY
    for (let rad = 0; rad < maxRad; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
      if (free(x + dx, y + dy) && (!biome || biomeAt(g, x + dx, y + dy) === biome)) return { x: x + dx, y: y + dy }
    }
    let best = null, bd = Infinity // the rings failed: the whole country answers
    for (let yy = 2; yy < H - 2; yy += 3) for (let xx = 2; xx < W - 2; xx += 3) {
      if (!free(xx, yy) || (biome && biomeAt(g, xx, yy) !== biome)) continue
      const d2 = (xx - nomX) ** 2 + (yy - nomY) ** 2
      if (d2 < bd) { bd = d2; best = { x: xx, y: yy } }
    }
    return best ?? { x: nomX, y: nomY }
  }
  // the Elder Tree (v0.79): one giant in the open heartlands, north-east
  // of Anchor where the meadow runs widest. It cannot be cut; it was
  // here before the roads, and the roads bent around it. A world needs
  // at least one thing that is older than everyone and useful to no one.
  {
    const ep = seatLandmark(Math.round(W * 0.56), Math.round(H * 0.36), 'heartlands')
    put('eldertree', 'landmark', ep.x, ep.y, { kind: 'elder-tree' })
  }
  // the Sentinel (v0.79): one pillar of stone on the high Crags,
  // standing over the passes. Miners swear it moves when nobody climbs.
  {
    const sp = seatLandmark(Math.round(W * 0.83), Math.round(H * 0.60), 'crags') // the SOUTH crags: one monument per shoulder of the country, the Delving holding the north
    put('sentinel', 'landmark', sp.x, sp.y, { kind: 'sentinel' })
  }
  // the Drowned Bell (v0.79): a bell tower sunk to its shoulders in the
  // marsh. Nobody remembers the town it called to prayer; on some
  // mornings, the fenfolk say, the mud still rings.
  {
    const bp = seatLandmark(Math.round(W * 0.58), Math.round(H * 0.82), 'fens')
    put('drownedbell', 'landmark', bp.x, bp.y, { kind: 'drowned-bell' })
  }
  // the Wreck (v0.79): a ship broken on the south shore. It implies the
  // largest thing on the island: a world beyond it, and a sea worth
  // sailing. It is drawn faithfully and explained never.
  {
    let wx9 = Math.round(W * 0.42), wy9 = Math.round(H * 0.90)
    seekW: for (let rad = 0; rad < 60; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
      const x9 = wx9 + dx, y9 = wy9 + dy
      if (free(x9, y9) && groundKindAt(g, x9, y9) === 'sand') { wx9 = x9; wy9 = y9; break seekW }
    }
    put('wreck', 'landmark', wx9, wy9, { kind: 'shipwreck' })
  }
  // the Ring: a circle of standing stones in the south heartlands
  {
    const rx0 = Math.round(W * 0.37), ry0 = Math.round(H * 0.655)
    const ring = [[4, 0], [3, 3], [0, 4], [-3, 3], [-4, 0], [-3, -3], [0, -4], [3, -3]]
    let n = 0
    for (const [dx, dy] of ring) if (free(rx0 + dx, ry0 + dy)) put('ring-' + (n++), 'landmark', rx0 + dx, ry0 + dy, { kind: 'standing-stone' })
  }
  // the Ruined Tower: broken masonry in the wilds. Its old fixed site
  // was UNDERWATER on some seeds and the walls silently never stood —
  // a lie on every chart. The Oak's law applies: a landmark may step
  // aside from the sea, but it must exist.
  {
    let tx = Math.round(W * 0.12), ty = Math.round(H * 0.32)
    seek3: for (let rad = 0; rad < 40; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
      if (free(tx + dx, ty + dy) && free(tx + dx + 2, ty + dy + 2) && biomeAt(g, tx + dx, ty + dy) === 'wilds') { tx += dx; ty += dy; break seek3 }
    }
    const stones = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2]]
    let n = 0
    for (const [dx, dy] of stones) if (free(tx + dx, ty + dy)) put('ruin-' + (n++), 'landmark', tx + dx, ty + dy, { kind: 'broken-tower' })
  }
  // Shrine Isle: the waystone at the end of the causeway, a ring of stone,
  // a hearth for the pilgrim — walked to once, recalled to forever
  {
    const isle = islesOf(g)[0]
    const seat = (id, type, dx, dy, extra) => {
      for (let rad = 0; rad <= 3; rad++) for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [rad, rad], [-rad, -rad]]) {
        const x = isle.x + dx + ox, y = isle.y + dy + oy
        if (inB(x, y) && !taken.has(key(x, y)) && !isWater(g, x, y) && onIsle(g, x, y)) { put(id, type, x, y, extra); return }
      }
    }
    seat('waystone-shrine', 'waystone', 0, 0)
    seat('shrine-hearth', 'campfire', 3, 0)
    for (let k = 0; k < 4; k++) seat('shrine-stone-' + k, 'landmark', [-4, 4, 0, 0][k], [0, 2, -4, 4][k], { kind: 'standing-stone' })
  }

  // ---- the paddocks (v0.79): fenced fields outside every heartlands
  // town, each with a gate-gap and a few plots inside. What separates a
  // real island from a generated one is BOUNDARIES: land somebody
  // divided, hedgerows somebody laid. Two per town, hash-turned. ----
  for (const st of settlementsOf(g)) {
    if (biomeAt(g, st.x, st.y) !== 'heartlands' && st.tag !== 'anchor') continue
    for (let pk = 0; pk < 2; pk++) {
      const hp9 = H32('paddock|' + st.tag, pk)
      const pw = 6 + (hp9.readUInt16BE(0) % 3), ph = 4 + (hp9.readUInt16BE(2) % 2)
      const side = hp9.readUInt16BE(4) % 4
      const r = rectOf(st)
      let ax = side === 0 ? r.x0 - pw - 4 : side === 1 ? r.x1 + 4 : st.x - (pw >> 1)
      let ay = side === 2 ? r.y0 - ph - 4 : side === 3 ? r.y1 + 4 : st.y - (ph >> 1)
      if (side < 2) ay = st.y - (ph >> 1)
      // the whole rectangle must be placeable ground
      let ok9 = true
      for (let yy = ay; yy <= ay + ph && ok9; yy++) for (let xx = ax; xx <= ax + pw; xx++)
        if (!free(xx, yy)) { ok9 = false; break }
      if (!ok9) continue
      const mat9 = hp9.readUInt16BE(6) % 2 ? 'hedge' : 'fence'
      const gate9 = 1 + (hp9.readUInt16BE(8) % (pw - 1)) // a gap on the south side
      let fi9 = 0
      for (let xx = ax; xx <= ax + pw; xx++) {
        put('pdk-' + st.tag + pk + '-' + (fi9++), mat9, xx, ay)
        if (xx - ax !== gate9) put('pdk-' + st.tag + pk + '-' + (fi9++), mat9, xx, ay + ph)
      }
      for (let yy = ay + 1; yy < ay + ph; yy++) {
        put('pdk-' + st.tag + pk + '-' + (fi9++), mat9, ax, yy)
        put('pdk-' + st.tag + pk + '-' + (fi9++), mat9, ax + pw, yy)
      }
      for (let pi9 = 0; pi9 < 3; pi9++) {
        const px9 = ax + 1 + (H32('pdkplot|' + st.tag + pk, pi9).readUInt16BE(0) % (pw - 1))
        const py9 = ay + 1 + (H32('pdkplot|' + st.tag + pk, pi9).readUInt16BE(2) % (ph - 1))
        if (free(px9, py9)) put('pdkp-' + st.tag + pk + '-' + pi9, 'plot', px9, py9, { plantedAt: 0 })
      }
    }
  }
  // ---- the worksites (v0.79): between the towns and the wild, the
  // places where the island's WORK lives. A farm with real fields, a
  // sawyer's clearing, an open delving, eel sheds on the marsh edge —
  // each a public hub of its country's trade, each with a keeper who
  // lives out there and a name on the chart. Built entirely from
  // existing law: no new node type, just composition. The Wilds get
  // nothing, which is the point of the Wilds. ----
  {
    const siteSeek = (fx, fy, biome, need) => {
      let x = Math.round(W * fx), y = Math.round(H * fy)
      seekQ: for (let rad = 0; rad < 40; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
        let ok = biomeAt(g, x + dx, y + dy) === biome
        for (let yy = -need; yy <= need && ok; yy++) for (let xx = -need; xx <= need; xx++)
          if (!free(x + dx + xx, y + dy + yy)) { ok = false; break }
        if (ok) { x += dx; y += dy; break seekQ }
      }
      return { x, y }
    }
    const sput = (id, type, x, y, extra) => { if (free(x, y)) put(id, type, x, y, extra) }

    { // Hollybarrow Farm: the heartlands' working fields
      const c = siteSeek(0.44, 0.50, 'heartlands', 5)
      sput('farm-house', 'house', c.x, c.y - 3)
      sput('farm-well', 'well', c.x + 2, c.y - 3)
      sput('farm-hearth', 'campfire', c.x - 2, c.y - 3)
      sput('kpr-farm-hollybarrow', 'keeper', c.x + 1, c.y - 2)
      let fi = 0
      for (let xx = -5; xx <= 5; xx++) { // two hedge-bound field rows
        sput('farm-h-' + (fi++), 'hedge', c.x + xx, c.y - 1)
        if (xx !== 0) sput('farm-h-' + (fi++), 'hedge', c.x + xx, c.y + 4) // the gate faces the house
      }
      for (let yy = 0; yy <= 3; yy++) { sput('farm-h-' + (fi++), 'hedge', c.x - 5, c.y + yy); sput('farm-h-' + (fi++), 'hedge', c.x + 5, c.y + yy) }
      let pi = 0
      for (let yy = 0; yy <= 3; yy++) for (let xx = -4; xx <= 4; xx += 2)
        sput('farm-p-' + (pi++), 'plot', c.x + xx, c.y + yy, { plantedAt: 0 })
    }
    { // the Sawyer's Camp: a worked clearing in the deep wood
      const c = siteSeek(0.50, 0.16, 'greenwood', 4)
      sput('camp-house', 'house', c.x, c.y)
      sput('camp-hearth', 'campfire', c.x + 2, c.y)
      sput('kpr-camp-sawyer', 'keeper', c.x + 1, c.y + 1)
      const ringT = [[-3, -2], [3, -2], [-4, 1], [4, 1], [-2, 3], [2, 3], [0, -4], [-4, -1], [4, 2], [0, 4]]
      ringT.forEach(([dx, dy], i) => sput('camp-t-' + i, 'tree', c.x + dx, c.y + dy))
    }
    { // the High Delving: an open mine on the Crags
      const c = siteSeek(0.80, 0.42, 'crags', 4)
      sput('delve-house', 'house', c.x, c.y - 2)
      sput('delve-hearth', 'campfire', c.x + 2, c.y - 2)
      sput('delve-anvil', 'anvil', c.x - 2, c.y - 2)
      sput('kpr-delve-high', 'keeper', c.x + 1, c.y - 1)
      const ringR = [[-3, 0], [3, 0], [-2, 2], [2, 2], [0, 3], [-4, 1], [4, 1], [-1, 4], [1, 4]]
      ringR.forEach(([dx, dy], i) => sput('delve-r-' + i, 'rock', c.x + dx, c.y + dy))
    }
    { // the Eel Sheds: fishing gathered at the marsh edge
      const c = siteSeek(0.50, 0.84, 'fens', 3)
      sput('sheds-house', 'house', c.x, c.y)
      sput('sheds-hearth', 'campfire', c.x + 2, c.y) // the smokehouse fire
      sput('kpr-sheds-eel', 'keeper', c.x + 1, c.y + 1)
      // fishing spots seek their own water nearby
      let fs = 0
      seekF: for (let rad = 1; rad < 14 && fs < 4; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
        const x = c.x + dx, y = c.y + dy
        if (!isWater(g, x, y) && !taken.has(key(x, y))
          && (isWater(g, x + 1, y) || isWater(g, x - 1, y) || isWater(g, x, y + 1) || isWater(g, x, y - 1))) {
          put('sheds-f-' + (fs++), 'fishing-spot', x, y)
          if (fs >= 4) break seekF
        }
      }
    }
  }
  // ---- the Lantern (v0.79b): a wayside inn on the east road, halfway
  // between Anchor and the passes. Every long road earns one lit window
  // at dusk. The house is a HOUSE in law, which means the brewpot
  // statute applies: any brewer may raise their pots in the yard — the
  // inn is built expecting to become a brewhouse, because inns always
  // do. Rest, traveler; the fire is kept.
  {
    // the NORTH road to Cragfoot: the south road hugs the fens boundary
    // its whole length, and no innkeeper builds a common room in a marsh
    let ix = Math.round(W * 0.59), iy = Math.round(H * 0.42)
    seekI: for (let rad = 0; rad < 60; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
      const x = ix + dx, y = iy + dy
      if (biomeAt(g, x, y) !== 'heartlands') continue
      if (onRoad(g, x, y)) continue // beside the road, not on it
      if (!(onRoad(g, x + 1, y) || onRoad(g, x - 1, y) || onRoad(g, x, y + 1) || onRoad(g, x, y - 1))) continue
      // exactly the five tiles the inn stands on must be lawful ground
      // (free() excludes road tiles by design, so a whole-block test
      // failed everywhere the inn was REQUIRED to be: beside a road)
      const spots = [[0, 0], [2, 0], [-1, 1], [1, 1], [0, 2]]
      let ok = true
      for (const [ox, oy] of spots) if (!free(x + ox, y + oy) || onRoad(g, x + ox, y + oy)) { ok = false; break }
      if (ok) { ix = x; iy = y; break seekI }
    }
    put('inn-house', 'house', ix, iy)
    put('inn-hearth', 'campfire', ix + 2, iy)
    put('inn-well', 'well', ix - 1, iy + 1)
    put('kpr-inn-lantern', 'keeper', ix + 1, iy + 1)
    put('inn-sign', 'signpost', ix, iy + 2, { text: 'the Lantern \u00b7 rest, traveler' })
    // the yard east of the house stays OPEN on purpose: the brewer's
    // ground, waiting for its first pot (build_brewpot wants a house
    // adjacent, and here one stands)
  }
  // ---- scattered plots in the heartlands ----
  let pl = 0
  for (let i = 0; i < 1200 && pl < 62; i++) {
    const h = H32('plot', i)
    const x = 1 + (h.readUInt16BE(0) % (W - 2)), y = 1 + (h.readUInt16BE(2) % (H - 2))
    if (!free(x, y) || biomeAt(g, x, y) !== 'heartlands') continue
    put('plotf-' + (pl++), 'plot', x, y, { plantedAt: 0 })
  }

  // ---- fishing: the sampled shore, now with a real coast ----
  let fs = 0
  const shoreOf = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWater(g, x + dx, y + dy)) return true
    return false
  }
  for (let y = 1; y < H - 1 && fs < 1000; y++) {
    for (let x = 1; x < W - 1 && fs < 1000; x++) {
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
      if (bi === 'sea') continue
      const stone = bi === 'crags' || bi === 'wilds' || (thash(g, x, y, 61) % 3) === 0
      taken.add(key(x, y))
      E.addNode(w, 'waymark-' + (wm++), stone ? 'rock' : 'tree', x, y)
      break
    }
  }
  const _waymarks = wm

  // ---- wayside hearths: one near the midpoint of every route ----
  let wr = 0
  for (const [a, b, tag] of roadSegsOf(g)) {
    if (tag === 103) continue // the causeway rests at the shrine itself
    const vx = b.x - a.x, vy = b.y - a.y
    const L = Math.sqrt(vx * vx + vy * vy)
    const nx = -vy / L, ny = vx / L
    const t = 0.5, taper = Math.min(1, Math.min(t, 1 - t) * 6)
    const o = meander(g, tag, t * L, 26, 8) * taper
    placed: for (const side of [2, -2, 3, -3]) {
      const x = Math.round(a.x + vx * t + nx * (o + side))
      const y = Math.round(a.y + vy * t + ny * (o + side))
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
        if (free(x + dx, y + dy)) { put('wayrest-' + (wr++), 'campfire', x + dx, y + dy); break placed }
      }
    }
  }
  const _wayrests = wr

  // ---- the country itself: v2's proven densities, seated on the island ----
  const scatter = (tag, want, pred, place) => {
    let n = 0
    for (let i = 0; i < want * 40 && n < want; i++) { // 40x oversample: half the canvas is sea
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

  const counts = { waymarks: _waymarks, wayrests: _wayrests, brandstones: br }
  // Density anchor: the calibrated 896x512 island. Counts are the v2 founding's
  // proven envelope, carried whole — the island's land area matches the v2
  // rectangle's within a few percent, so density per land tile is unchanged.
  const A = (n) => Math.max(1, Math.round(n * (W * H) / (896 * 512)))
  counts.greenwoodTrees = scatter('gwtree', A(1500), (x, y) => B(x, y) === 'greenwood', tree)
  counts.heartTrees     = scatter('httree', A(460), (x, y) => B(x, y) === 'heartlands', tree)
  counts.fenTrees       = scatter('fntree', A(300), (x, y) => B(x, y) === 'fens', tree)
  counts.wildTrees      = scatter('wdtree', A(260), (x, y) => B(x, y) === 'wilds', tree)
  counts.cragRocks      = scatter('cgrock', A(860), (x, y) => B(x, y) === 'crags', rock)
  counts.wildRocks      = scatter('wdrock', A(280), (x, y) => B(x, y) === 'wilds', rock)
  counts.heartRocks     = scatter('htrock', A(250), (x, y) => B(x, y) === 'heartlands', rock)
  counts.magicWilds     = scatter('wdmagic', A(54), (x, y) => B(x, y) === 'wilds', mrock)
  counts.magicCrags     = scatter('cgmagic', A(34), (x, y) => B(x, y) === 'crags' && x > W * 0.80, mrock)

  // town copses: the chop-and-bank loop works at EVERY home. A handful
  // of trees seeded just past each town's plots, so no settlement
  // depends on the scatter's generosity for its firewood.
  let copse = 0
  for (const st of settlementsOf(g)) {
    const r = rectOf(st)
    let placed = 0
    for (let att = 0; att < 120 && placed < 6; att++) {
      const hb = H32('copse:' + st.name, att)
      const x = r.x0 - 9 + (hb.readUInt16BE(0) % (r.x1 - r.x0 + 19))
      const y = r.y0 - 9 + (hb.readUInt16BE(2) % (r.y1 - r.y0 + 19))
      if (x >= r.x0 - 2 && x <= r.x1 + 2 && y >= r.y0 - 2 && y <= r.y1 + 2) continue // past walls and plots
      if (!free(x, y) || onRoad(g, x, y)) continue
      tree('copse-' + st.name + '-' + placed, x, y); taken.add(key(x, y)); placed++; copse++
    }
  }
  counts.copseTrees = copse

  const mob = (kind) => (id, x, y) => E.addMob(w, id, kind, x, y)
  // the Anchor commons (Lumbridge law): the first goblin is a sight
  // from the capital's walls in ANY direction — a sparse ring, 18 to 60
  // tiles out, thinned to a third of band density by the draw's own
  // digest. The budget grows to fund it, so the fens stay as thick as
  // ever; the commons is a petting zoo, the marshes are a war.
  const ccx = Math.floor(W / 2), ccy = Math.floor(H / 2)
  counts.goblins = scatter('gob', A(180), (x, y, h) => {
    const b = B(x, y)
    if (b === 'fens' || (b === 'heartlands' && (x < W * 0.4 || y > H * 0.55))) return true
    if (b !== 'heartlands') return false
    const dx = x - ccx, dy = y - ccy, d2 = dx * dx + dy * dy
    return d2 >= 324 && d2 <= 3600 && h.readUInt16BE(4) % 3 === 0
  }, mob('goblin'))
  counts.wolves  = scatter('wolf', A(108), (x, y) => { const b = B(x, y); return b === 'greenwood' || b === 'fens' }, mob('wolf'))
  counts.bears   = scatter('bear', A(62), (x, y) => B(x, y) === 'greenwood' && y < H * 0.22, mob('bear'))
  counts.trolls  = scatter('troll', A(70), (x, y) => { const b = B(x, y); return b === 'crags' || (b === 'wilds' && x < W * 0.10) }, mob('troll'))

  let sk = 0
  for (let band = 0; band < A(13); band++) {
    const hb = H32('warband', band)
    const bx = 2 + (hb.readUInt16BE(0) % Math.max(1, Math.round(W * 0.22)))
    const by = 2 + (hb.readUInt16BE(2) % (H - 4))
    for (let k = 0; k < 5; k++) {
      const hh = H32('skel', sk)
      const x = bx + (hh[0] % 7) - 3, y = by + (hh[1] % 7) - 3
      sk++
      if (!free(x, y) || B(x, y) !== 'wilds') continue
      taken.add(key(x, y)); E.addMob(w, 'skel-' + sk, 'skeleton-knight', x, y)
    }
  }
  counts.knights = sk

  // ---- waystones: one per town, the shrine's, and anchors in the country ----
  const putWaystone = (id, x, y) => {
    for (let rad = 0; rad < 8; rad++) for (const [dx, dy] of [[0, rad], [rad, 0], [0, -rad], [-rad, 0], [rad, rad], [-rad, -rad]]) {
      const nx = x + dx, ny = y + dy
      if (inB(nx, ny) && !taken.has(key(nx, ny)) && !isWater(g, nx, ny) && !onRidge(g, nx, ny) && biomeAt(g, nx, ny) !== 'sea') { put(id, 'waystone', nx, ny); return true }
    }
    return false
  }
  for (const s of ss) putWaystone('waystone-' + s.tag, s.x, rectOf(s).y1 + 3)
  const j = junctionsOf(g)
  putWaystone('waystone-watersmeet', j.watersmeet.x + 4, j.watersmeet.y + 4)
  putWaystone('waystone-npass', j.npass.x + 5, j.npass.y)
  putWaystone('waystone-spass', j.spass.x + 5, j.spass.y)
  const frontier = [
    ['wildsnorth', Math.round(W * 0.12), Math.round(H * 0.20)],
    ['wildssouth', Math.round(W * 0.12), Math.round(H * 0.72)],
    ['wildsdeep',  Math.round(W * 0.06), Math.round(H * 0.48)],
    ['cragshigh',  Math.round(W * 0.90), Math.round(H * 0.32)],
    ['greendeep',  Math.round(W * 0.60), Math.round(H * 0.08)],
    ['stillwater', Math.round(W * 0.73), Math.round(H * 0.28)],
    ['fensdeep',   Math.round(W * 0.55), Math.round(H * 0.90)],
    ['oldoak',     Math.round(W * 0.62), Math.round(H * 0.115)],
    ['thering',    Math.round(W * 0.37), Math.round(H * 0.67)],
  ]
  for (const [tag, x, y] of frontier) putWaystone('waystone-' + tag, x, y)

  const serr = E.validateState(w)
  if (serr) throw new Error('worldgen produced an invalid state (' + serr + ') — founding aborted')
  w._composition = counts

  // ---- the crossing (restored, v0.78): genesis.imported is FOUNDING
  // data — the worldId commits to it, the engine validates it, serve
  // builds it — and this generator was dropping it on the floor. The
  // application block was lost in a merge, and a world's worth of
  // veterans arrived at a founding that could not hear them. Every
  // imported soul now wakes at the spawn with everything the genesis
  // swears they carried: skills, name, pack, bank, weapon, wounds.
  // (block restored to the v0.66 canon, rev7 §6: validated data applied
  // directly — era-known skills only, hp capped at the hitpoints level,
  // the name REGISTRY written alongside the nameplate.)
  for (const c9 of (g.imported ?? [])) {
    if (!/^[0-9a-f]{64}$/.test(c9.pid ?? '')) continue
    const sp9 = spawnDry(g)
    E.addPlayer(w, c9.pid, sp9.x, sp9.y)
    const p9 = w.players[c9.pid]
    for (const k9 of Object.keys(p9.skills)) if (c9.skills?.[k9] !== undefined) p9.skills[k9] = c9.skills[k9]
    p9.hp = Math.min(c9.hp ?? p9.hp, E.levelForXp(p9.skills.hitpoints))
    ;(c9.inventory ?? []).forEach((sl9, i9) => { if (i9 < p9.inventory.length) p9.inventory[i9] = sl9 ?? null })
    p9.equipment.weapon = c9.weapon ?? null
    for (const [it9, q9] of Object.entries(c9.bank ?? {})) p9.bank[it9] = q9
    if (c9.name != null) { w.names[c9.name] = c9.pid; p9.name = c9.name }
  }
  return w
}
