#!/usr/bin/env node
// recover.mjs (v0.78) — certified reconstruction from the accountability store.
//
// When every checkpoint is lost, fabricated, or forked, ONE source of
// truth remains: the finality index, where every finalized tick sits as
// a quorum-signed certificate carrying its input bundle. This tool
// rebuilds the world from genesis, replays every certified tick (each
// replay checked against its attested hash), and writes the resulting
// state as checkpoints/web.json — the exact finalized present, bit for
// bit. No history is re-signed; nothing is trusted that is not proved.
//
// Usage:  INTERVAL_DATA=/path node recover.mjs
// Reads:  $DATA/checkpoints/world.json (the founding record)
//         $DATA/witness-safety/<worldId>/<witnessId>/finality.db
//         $DATA/witness-safety/<worldId>/<witnessId>/frontier.json
// Writes: $DATA/checkpoints/web.json  (prior file archived first)
import fs from 'fs'
import path from 'path'
import E from './engine.js'
import * as P from './protocol.mjs'
import { sqliteFinalityStore } from './node.mjs'
import { buildWorld } from './worldgen-any.mjs'

const DATA = (process.env.INTERVAL_DATA || '.').replace(/\/$/, '')
const WORLD_FILE = DATA + '/checkpoints/world.json'
const CP_FILE = DATA + '/checkpoints/web.json'

const saved = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'))
const genesis = saved.genesis ?? saved
const worldId = E.worldId(genesis)
console.log('world ' + worldId.slice(0, 12) + '… (generator ' + (genesis.worldGenerator ?? '?') + ')')

// find the witness dir (there is one witness on a pillar; take the first)
const wroot = path.join(DATA, 'witness-safety', worldId)
const witnessDirs = fs.readdirSync(wroot).filter((d) => /^[0-9a-f]{64}$/.test(d))
if (!witnessDirs.length) { console.error('no witness dir under ' + wroot); process.exit(1) }
// a split-data migration can leave TWO witness identities for one world,
// each with its own finalized branch. Survey them all; recover the
// branch that reached furthest (or set INTERVAL_WITNESS=<id> to choose).
const surveyed = witnessDirs.map((d) => {
  try {
    const f2 = JSON.parse(fs.readFileSync(path.join(wroot, d, 'frontier.json'), 'utf8'))
    return { d, tick: f2.tick, hash: f2.resultingStateHash, f: f2 }
  } catch { return { d, tick: -1 } }
})
for (const sv of surveyed) console.log('witness ' + sv.d.slice(0, 12) + '…: '
  + (sv.tick >= 0 ? 'frontier tick ' + sv.tick + ' (' + sv.hash.slice(0, 8) + '…)' : 'no frontier'))
const want = process.env.INTERVAL_WITNESS
const pick = want ? surveyed.find((sv) => sv.d.startsWith(want))
  : surveyed.reduce((a, b) => (b.tick > (a?.tick ?? -1) ? b : a), null)
if (!pick || pick.tick < 0) { console.error('no usable frontier' + (want ? ' for witness ' + want : '')); process.exit(1) }
if (surveyed.filter((sv) => sv.tick >= 0).length > 1)
  console.log('MULTIPLE branches found — recovering the furthest (' + pick.d.slice(0, 12) + '…). Set INTERVAL_WITNESS to choose the other.')
const wdir = path.join(wroot, pick.d)
const frontier = pick.f
const target = frontier.tick
console.log('recovering branch: tick ' + target + ' finalized as ' + frontier.resultingStateHash.slice(0, 12) + '…')

const index = sqliteFinalityStore(path.join(wdir, 'finality.db'), { worldId })
let state = buildWorld(genesis)
let ph = E.stateHash(state)
console.log('genesis state rebuilt at tick ' + state.tick + ' (' + ph.slice(0, 12) + '…); replaying ' + (target - state.tick) + ' certified tick(s)…')
const t0 = Date.now()
let lastRec = null
for (let t = state.tick + 1; t <= target; t++) {
  const entry = index.get(t)
  const rec = entry?.cert ?? entry
  if (!rec?.bundle) { console.error('no certificate stored for tick ' + t + ' — cannot reconstruct past it'); process.exit(1) }
  const perr = P.verifyFinalityProof(genesis, worldId, rec)
  if (perr) { console.error('tick ' + t + ': stored certificate invalid: ' + perr); process.exit(1) }
  if (rec.previousStateHash !== ph) { console.error('tick ' + t + ': lineage break (cert expects ' + String(rec.previousStateHash).slice(0, 8) + '…, replay is at ' + ph.slice(0, 8) + '…)'); process.exit(1) }
  state = E.nextState(state, rec.bundle.inputs)
  ph = E.stateHash(state)
  lastRec = rec
  if (ph !== rec.resultingStateHash) { console.error('tick ' + t + ': replay hashes ' + ph.slice(0, 8) + '… but the quorum certified ' + String(rec.resultingStateHash).slice(0, 8) + '…'); process.exit(1) }
  if (t % 2000 === 0) console.log('  … tick ' + t + ' (' + Math.round((t - 0) * 100 / target) + '%, ' + Math.round((Date.now() - t0) / 1000) + 's)')
}
if (ph !== frontier.resultingStateHash) { console.error('reconstruction reached tick ' + target + ' but hashes ' + ph.slice(0, 8) + '… ≠ frontier ' + frontier.resultingStateHash.slice(0, 8) + '…'); process.exit(1) }
console.log('reconstructed the exact finalized present: tick ' + target + ' = ' + ph.slice(0, 12) + '… (' + Math.round((Date.now() - t0) / 1000) + 's)')

try { if (fs.existsSync(CP_FILE)) fs.copyFileSync(CP_FILE, CP_FILE.replace(/\.json$/, '') + '-forked-' + Date.now() + '.json') } catch {}
fs.writeFileSync(CP_FILE + '.tmp', JSON.stringify({
  formatVersion: 3, worldId, tick: state.tick, state,
  stateHash: E.stateHash(state),
  finalityProof: lastRec, // the quorum record certifying exactly this state
})) // node's own checkpointEnvelope shape, hash-sealed, proof attached
fs.renameSync(CP_FILE + '.tmp', CP_FILE)
console.log('checkpoint written: ' + CP_FILE + ' — boot serve normally; it will resume AT the frontier.')
