// survey-sim: measure exploration throughput on the REAL world geometry, then
// solve for the XP constant that lands 99 at a target of active hours. Balance
// from data, not intuition (the advsim discipline, applied to gameplay).
import E from './engine.js';
import { buildWorld } from './worldgen.mjs';

const XP99 = 13034431;            // XP_TABLE[99]
const TICK_MS = 600;
const TICKS_PER_HOUR = 3600_000 / TICK_MS; // 6000
const TARGET_HOURS = 120;
const TARGET_XP_PER_HOUR = XP99 / TARGET_HOURS;

// a small seeded PRNG — stands in for the beacon for MEASURING geometry
// (the engine will place markers from the real beacon; the statistics match)
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function run({ W, H, K, ticks, seed = 1, nearBias = 0.6 }) {
  const G = E.makeGenesis('sim', 'ab'.repeat(32), 0, W, H);
  const w = buildWorld(G);
  const anchor = E.spawnOf(G);
  const maxDist = Math.max(anchor.x, W - anchor.x, anchor.y, H - anchor.y);
  const blocked = new Set();
  for (const n of Object.values(w.nodes)) blocked.add(n.x + ',' + n.y);
  const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  const R = rng(seed);

  const placeMarker = () => {
    for (let att = 0; att < 200; att++) {
      const x = 1 + Math.floor(R() * (W - 2)), y = 1 + Math.floor(R() * (H - 2));
      if (E.inCity(G, x, y) || blocked.has(x + ',' + y)) continue;
      const d = cheb(x, y, anchor.x, anchor.y);
      // near-bias: far markers accepted less often, so most land near/mid, few deep
      if (R() > 1 - nearBias * (d / maxDist)) continue;
      return { x, y, dist: d };
    }
    return { x: anchor.x + 5, y: anchor.y, dist: 5 };
  };

  const markers = [];
  const markerKey = new Map(); // "x,y" -> marker index
  const addMarker = (i) => { const m = placeMarker(); markers[i] = m; markerKey.set(m.x + ',' + m.y, i); };
  for (let i = 0; i < K; i++) addMarker(i);

  // BFS from pos to the NEAREST REACHABLE marker; returns { mi, pathLen }
  const NBR = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const blockedGrid = new Uint8Array(W * H);
  for (const n of Object.values(w.nodes)) blockedGrid[n.y * W + n.x] = 1;
  const seenGen = new Int32Array(W * H); let gen = 0;
  const qx = new Int32Array(W * H), qy = new Int32Array(W * H), qd = new Int32Array(W * H);
  function nearestMarker(px, py) {
    gen++; let head = 0, tail = 0;
    qx[tail] = px; qy[tail] = py; qd[tail] = 0; tail++; seenGen[py * W + px] = gen;
    while (head < tail) {
      const x = qx[head], y = qy[head], d = qd[head]; head++;
      const k = x + ',' + y;
      if (d > 0 && markerKey.has(k)) return { mi: markerKey.get(k), pathLen: d };
      for (const [dx, dy] of NBR) {
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
        const idx = ny * W + nx;
        if (blockedGrid[idx] || seenGen[idx] === gen) continue;
        seenGen[idx] = gen; qx[tail] = nx; qy[tail] = ny; qd[tail] = d + 1; tail++;
      }
    }
    return { mi: -1, pathLen: 0 };
  }

  let pos = { x: anchor.x, y: anchor.y };
  let surveys = 0, travel = 0, distSum = 0, ticksUsed = 0;
  const distHist = { near: 0, mid: 0, deep: 0 };
  const N_SURVEYS = 4000;

  while (surveys < N_SURVEYS) {
    const { mi, pathLen } = nearestMarker(pos.x, pos.y);
    if (mi < 0) break;
    ticksUsed += Math.max(1, pathLen); travel += pathLen; surveys++;
    const m = markers[mi]; distSum += m.dist;
    const frac = m.dist / maxDist;
    if (frac < 0.25) distHist.near++; else if (frac < 0.6) distHist.mid++; else distHist.deep++;
    pos = { x: m.x, y: m.y };
    markerKey.delete(m.x + ',' + m.y);
    addMarker(mi);
  }

  const hours = ticksUsed / TICKS_PER_HOUR;
  const surveysPerHour = surveys / hours;
  const meanTravel = travel / surveys;
  const meanDist = distSum / surveys;
  // solve: XP/survey needed = TARGET_XP_PER_HOUR / surveysPerHour
  const xpPerSurveyNeeded = TARGET_XP_PER_HOUR / surveysPerHour;
  // fix BASE=40, solve PER_TILE so mean survey pays what's needed
  const BASE = 40;
  const perTile = (xpPerSurveyNeeded - BASE) / meanDist;
  return { W, H, K, surveysPerHour, meanTravel, meanDist, maxDist, distHist, surveys, xpPerSurveyNeeded, BASE, perTile };
}

console.log(`target: 99 (${XP99.toLocaleString()} xp) in ${TARGET_HOURS}h  =>  ${Math.round(TARGET_XP_PER_HOUR).toLocaleString()} xp/hour\n`);
const header = ['world', 'K', 'surv/hr', 'meanTravel', 'meanDist(maxD)', 'near/mid/deep%', 'xp/survey', '=> PER_TILE (BASE 40)'];
console.log(header.join('  |  '));
for (const cfg of [
  { W: 320, H: 200, K: 6, ticks: 300000 },
  { W: 320, H: 200, K: 8, ticks: 300000 },
  { W: 320, H: 200, K: 12, ticks: 300000 },
  { W: 640, H: 400, K: 16, ticks: 300000 }, // a ~4x launch world, K scaled with area
]) {
  const r = run(cfg);
  const tot = r.distHist.near + r.distHist.mid + r.distHist.deep;
  const pct = (n) => Math.round(100 * n / tot);
  console.log([
    `${r.W}x${r.H}`, r.K, r.surveysPerHour.toFixed(1), r.meanTravel.toFixed(1),
    `${r.meanDist.toFixed(0)} (${r.maxDist})`, `${pct(r.distHist.near)}/${pct(r.distHist.mid)}/${pct(r.distHist.deep)}`,
    Math.round(r.xpPerSurveyNeeded), r.perTile.toFixed(2),
  ].join('  |  '));
}
console.log('\nread: at these constants a survey pays ~BASE + PER_TILE*distance, tuned so an');
console.log('optimal solo explorer reaches 99 in ~120h. crowds/anti-monopoly caps only slow it.');
