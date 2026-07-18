#!/usr/bin/env node
// Large-history storage benchmark (production readiness brief §4). Builds a
// synthetic finality history at a requested scale and measures the operations
// that matter for multi-year operation: append throughput, indexed lookup,
// startup validation (structural + bounded cert), a full integrity check, and
// consistent online backup. "Storage is not consensus" — the synthetic records
// are structurally valid but not signature-bearing, so this measures STORAGE,
// not cryptography (bounded cert verification is measured separately with real
// certs in the test suite).
//
// Usage: node bench-storage.mjs [ticks] [backend]
//   ticks:   history size (default 1_000_000). Try 1e6, 1e7, 5e7, 1e8.
//   backend: 'sqlite' (default) or 'flatfile'
//
// At one tick / 600 ms a year is ≈ 52.6M ticks; run beyond that to project
// multi-year operation. Large runs need disk: ~a few hundred bytes per row.
import { sqliteFinalityStore, finalityIndexStore } from './node.mjs'
import fs from 'fs'
import os from 'os'
import path from 'path'

const ticks = Number(process.argv[2] || 1_000_000)
const backend = process.argv[3] || 'sqlite'
const worldId = 'ab'.repeat(32)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-bench-'))
const dbPath = path.join(dir, backend === 'sqlite' ? 'finality.db' : 'fi.ndjson')

const hx = (n) => n.toString(16).padStart(64, '0')
const mkRecord = (t) => ({
  worldId, tick: t, round: 0, previousStateHash: hx(t), bundle: { worldId, tick: t, inputs: [] },
  bundleHash: hx(t ^ 0x5555), resultingStateHash: hx(t ^ 0xaaaa), attestations: [],
})

function ms(fn) { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 } }

console.log(`# storage benchmark — backend=${backend}, ticks=${ticks.toLocaleString()}`)
console.log(`# dir=${dir}`)

const open = () => backend === 'sqlite' ? sqliteFinalityStore(dbPath, { worldId }) : finalityIndexStore(dbPath)
let store = open()

// --- append throughput ---
// Production appends one record per tick (600ms apart), each its own fsynced
// transaction — so per-append latency (~1ms) is what matters live and is
// measured in the test suite. HERE we measure raw STORAGE throughput by
// batching into transactions, which is what a bulk import / migration sees.
{
  const batch = 50_000
  const t0 = process.hrtime.bigint()
  if (backend === 'sqlite') {
    const ins = store._db.prepare('INSERT INTO finality (world_id,tick,bundle_hash,state_hash,certificate_hash,certificate,created_at) VALUES (?,?,?,?,?,?,?)')
    for (let base = 0; base < ticks; base += batch) {
      store._db.exec('BEGIN')
      const end = Math.min(base + batch, ticks)
      for (let t = base; t < end; t++) ins.run(worldId, t, hx(t), hx(t ^ 0xaaaa), hx(t), Buffer.from('{}'), Date.now())
      store._db.exec('COMMIT')
      const el = Number(process.hrtime.bigint() - t0) / 1e3
      process.stdout.write(`\r  append ${end.toLocaleString()} / ${ticks.toLocaleString()} (${(end / el).toFixed(0)}k/s)   `)
    }
  } else {
    for (let t = 0; t < ticks; t++) {
      store.append(mkRecord(t))
      if ((t + 1) % batch === 0) { const el = Number(process.hrtime.bigint() - t0) / 1e3; process.stdout.write(`\r  append ${(t + 1).toLocaleString()} / ${ticks.toLocaleString()} (${((t + 1) / el).toFixed(0)}k/s)   `) }
    }
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`\n  append total: ${total.toFixed(0)} ms  (${(ticks / total).toFixed(1)}k rows/s, ${(total / ticks * 1000).toFixed(1)} µs/row batched)`)
}

// --- database size ---
{
  const size = (p) => { try { return fs.statSync(p).size } catch { return 0 } }
  const bytes = size(dbPath) + size(dbPath + '-wal') + size(dbPath + '-shm')
  console.log(`  db size: ${(bytes / 1e6).toFixed(1)} MB  (${(bytes / ticks).toFixed(0)} bytes/row)`)
}

// --- lookup latency (random gets over a fresh handle = cold offset index) ---
if (backend === 'sqlite') { store.close(); store = open() }
else { store = open() } // fresh handle rebuilds the offset index from disk
{
  const N = 10_000
  const { ms: warm } = ms(() => store.get(Math.floor(ticks / 2))) // warm the index
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) store.get((Math.random() * ticks) | 0)
  const total = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`  lookup: ${N.toLocaleString()} random gets in ${total.toFixed(1)} ms (${(total / N * 1000).toFixed(1)} µs/get; first-get warm ${warm.toFixed(1)} ms)`)
}

// --- startup validation: structural on all + bounded cert on the tail ---
{
  const { ms: full } = ms(() => store.validate({ worldId, verifyRecentN: 0 })) // structure/hash only
  console.log(`  startup validation (structure+hash, all rows): ${full.toFixed(0)} ms`)
}

// --- integrity + backup (sqlite only) ---
if (backend === 'sqlite') {
  const { ms: integ } = ms(() => store.integrityCheck())
  console.log(`  integrity quick_check: ${integ.toFixed(0)} ms`)
  const bk = path.join(dir, 'backup.db')
  const { ms: bkms } = ms(() => store.backup(bk))
  const bkBytes = fs.statSync(bk).size
  console.log(`  online backup: ${bkms.toFixed(0)} ms  (${(bkBytes / 1e6).toFixed(1)} MB)`) 
}

store.close?.()
fs.rmSync(dir, { recursive: true, force: true })
console.log('# done')
