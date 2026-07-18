#!/usr/bin/env node
// Storage operations tooling (production brief §8). Operates on a witness's
// SQLite finality store WITHOUT touching consensus — health snapshot, integrity
// checks, consistent online backup, and restore verification. "Storage is not
// consensus": nothing here changes a protocol record.
//
// Usage:
//   node storage-ops.mjs health   <finality.db>
//   node storage-ops.mjs integrity <finality.db>          # PRAGMA integrity_check (full)
//   node storage-ops.mjs backup   <finality.db> <dest.db> # consistent online backup
//   node storage-ops.mjs verify   <backup.db> [worldId]   # validate a backup/restore
//
// Exit code 0 = ok, 1 = a problem was found (for use in monitoring/cron).
import { sqliteFinalityStore } from './node.mjs'
import { createRequire } from 'module'
import fs from 'fs'

const require = createRequire(import.meta.url)
const [cmd, file, arg2] = process.argv.slice(2)

function die(msg) { console.error(msg); process.exit(1) }
if (!cmd || !file) die('usage: node storage-ops.mjs <health|integrity|backup|verify> <db> [dest|worldId]')
if (cmd !== 'verify' && cmd !== 'restore-verify' && !fs.existsSync(file)) die(`no such database: ${file}`)

function fullIntegrity(dbFile) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA integrity_check').all()
    const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok'
    return { ok, detail: ok ? 'ok' : JSON.stringify(rows) }
  } finally { db.close() }
}

if (cmd === 'health') {
  const store = sqliteFinalityStore(file)
  const h = store.health()
  const integ = store.integrityCheck()
  store.close()
  console.log(JSON.stringify({ ...h, quickCheck: integ === null ? 'ok' : integ }, null, 2))
  process.exit(integ === null ? 0 : 1)
}

if (cmd === 'integrity') {
  const r = fullIntegrity(file)
  console.log(`integrity_check: ${r.detail}`)
  process.exit(r.ok ? 0 : 1)
}

if (cmd === 'backup') {
  if (!arg2) die('usage: node storage-ops.mjs backup <finality.db> <dest.db>')
  if (fs.existsSync(arg2)) die(`destination already exists: ${arg2} (refusing to overwrite)`)
  const store = sqliteFinalityStore(file)
  const t0 = Date.now()
  store.backup(arg2)
  store.close()
  // verify the backup opens, is integrity-clean, and has the same row count
  const srcStore = sqliteFinalityStore(file)
  const srcRows = srcStore._db.prepare('SELECT COUNT(*) AS c FROM finality').get().c
  srcStore.close()
  const r = fullIntegrity(arg2)
  const bkStore = sqliteFinalityStore(arg2)
  const bkRows = bkStore._db.prepare('SELECT COUNT(*) AS c FROM finality').get().c
  bkStore.close()
  const ok = r.ok && bkRows === srcRows
  console.log(JSON.stringify({ backup: arg2, ms: Date.now() - t0, srcRows, backupRows: bkRows, integrity: r.detail, ok }, null, 2))
  process.exit(ok ? 0 : 1)
}

if (cmd === 'verify' || cmd === 'restore-verify') {
  // validate a restored/backed-up database: integrity + structural validation
  const r = fullIntegrity(file)
  if (!r.ok) { console.log(JSON.stringify({ ok: false, integrity: r.detail })); process.exit(1) }
  const worldId = arg2 || null
  const store = sqliteFinalityStore(file, worldId ? { worldId } : {})
  // structural + hash validation of every row (cert signatures need genesis,
  // which a standalone restore-check does not carry, so hashes are the bound)
  const verr = store.validate({ worldId })
  const rows = store._db.prepare('SELECT COUNT(*) AS c FROM finality').get().c
  const latest = store.latestTick()
  store.close()
  const ok = verr === null
  console.log(JSON.stringify({ ok, rows, latestTick: latest, integrity: 'ok', validation: verr ?? 'clean' }, null, 2))
  process.exit(ok ? 0 : 1)
}

die(`unknown command: ${cmd}`)
