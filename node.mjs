// Interval node v0.3 — the networked constitution.
// Wraps the deterministic engine in a libp2p gossipsub mesh:
//   - signed inputs are gossiped on the world's input topic
//   - every node advances the world in lockstep on the tick schedule
//   - every node publishes its state hash after each tick
//   - hashes are compared; divergent peers are flagged and ignored
// Topics are namespaced by the FULL world ID (hash of the complete
// canonical genesis): a different constitution, seed, anchor, or size is
// literally a different network. Forks are separate worlds by construction.

import { createLibp2p } from 'libp2p'
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { identify } from '@libp2p/identify'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import E from './engine.js'
import { throwCoded, ERR, DEFAULT_STARTUP_VERIFY_RECENT_N } from './errors.mjs'
import * as P from './protocol.mjs'
import { IntervalAgreement } from './agreement.mjs'

// ---- protocol limits (fix brief §5.1): every surface is bounded ----
export const LIMITS = {
  MAX_GOSSIP_BYTES: 16 * 1024,          // one signed input or hash is <1KB
  MAX_CHAT_BYTES: 2 * 1024,
  MAX_FUTURE_TICKS: 20,                 // ~12s lookahead; distant futures are noise or attack
  // A BUFFER bound, not a rule. Which inputs a tick applies is decided by the
  // engine (SPEC §5.4), deterministically, from everything received. This is
  // simply how much a node will hold in memory while waiting for the tick, and
  // it is set well above the applied cap so that a node has the whole field to
  // choose from rather than whichever arrived first.
  MAX_INPUTS_PER_INTERVAL: 16384,       // per-tick buffer bucket cap
  MAX_BUFFERED_INTERVALS: 64,           // distinct future ticks held at once
  MAX_REPLAY_TICKS_PER_REQUEST: 256,
  MAX_REPLAY_RESPONSE_BYTES: 4 * 1024 * 1024,
  MAX_HASH_HISTORY_TICKS: 512,          // myHashes / peerHashes retention
  MAX_CHAT_SENDERS: 4096,               // _chatLast rate-limit table cap
  MAX_CHECKPOINT_BYTES: 16 * 1024 * 1024, // checkpoint stream read cap
  MAX_REQUEST_BYTES: 1024,              // ticklog request read cap
}

// Bounded full-stream reading (remaining-fixes brief §7/§8): requests and
// responses may arrive in many transport chunks and may be hostile in
// size. Read everything, count everything, abort the moment a cap breaks.
export async function readAll(source, maxBytes) {
  const chunks = []
  let total = 0
  for await (const c of source) {
    const b = c.subarray ? c.subarray() : Buffer.from(c)
    total += b.length
    if (total > maxBytes) throw new Error(`stream exceeded ${maxBytes} bytes — aborted`)
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

// A small durable JSON store (final-fixes brief §4): write tmp → fsync tmp
// → atomic rename → fsync the DIRECTORY (the rename itself must survive
// power loss, not just the bytes) — restrictive permissions throughout.
// Used for witness vote locks and the finality frontier.
export function fsyncDir(dir, { strict = false } = {}) {
  try {
    const dfd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
  } catch (e) {
    // rev4 brief §4: for CONSENSUS records (locks, frontier) a rename that
    // may not survive power loss is a silent safety hole — propagate. For
    // non-consensus artifacts (checkpoints, archives) best-effort stands.
    if (strict) throw new Error(`directory fsync failed for ${dir}: ${e.message} — this platform cannot host a production witness`)
  }
}

// Exclusive witness process lock (storage brief §1; final review §2;
// production brief §1). Two processes sharing the same (worldId, witnessId)
// safety state can race before durable records update, so an honestly-operated
// witness could double-sign.
//
// SCOPE — this is a LOCAL-HOST kernel lock, NOT a distributed lock. We bind a
// Unix-domain socket at <safetyBase>/process.lock.sock; the kernel guarantees
// exclusive ownership of a live socket address ON THAT HOST (a second bind
// fails with EADDRINUSE) and releases it automatically when the holder dies.
// The supported operating model (production brief §1, Option A) is therefore:
//   • one witness identity == one host;
//   • witness safety directories live on LOCAL, non-shared storage;
//   • shared/NFS safety directories are UNSUPPORTED — a Unix socket bound on
//     host A does not exclude a process on host B against the same NFS path,
//     so cross-host exclusivity requires fencing the old host on failover.
// Within a host this is a true kernel lock, not a PID file: no PID guessing,
// no unsafe reclamation. The only stale state is the pathname entry a dead
// process leaves behind; we resolve it SAFELY by first trying to CONNECT — a
// successful connect proves a live holder (refuse); a refused connect
// (ECONNREFUSED) proves the socket is dead and the path can be unlinked and
// rebound. An .info file is written for operator visibility only.
// A Unix domain socket path lives in `sun_path`, which the kernel caps at 108
// bytes on Linux and 104 on macOS. The safety directory layout
// (witness-safety/<worldId 64hex>/<witnessId 64hex>/) is 145+ bytes before the
// filename, so binding the socket *inside* it silently TRUNCATED the path: the
// socket landed at a chopped name, while unlink and existence checks all
// targeted the full name and quietly did nothing. A restarted witness then
// found the truncated file still in place, could not remove it, and refused to
// start forever. So the socket gets a short hashed name of its own, and the
// full identity is recorded in the neighbouring .info file.
const LOCK_PATH_MAX = 100 // conservative: under both the Linux and macOS caps
export function processLockPathFor(safetyDir, worldId, witnessId) {
  const tag = createHash('sha256').update(worldId + ':' + witnessId).digest('hex').slice(0, 16)
  return path.join(safetyDir, 'locks', tag + '.sock')
}
export async function acquireProcessLock(sockPath, identity = null) {
  const net = await import('net')
  // Never hand the kernel a path it will truncate: a truncated lock is worse
  // than no lock, since two identities can share one and neither can clean up.
  if (Buffer.byteLength(sockPath) > LOCK_PATH_MAX) {
    const err = new Error(
      `witness process lock path is ${Buffer.byteLength(sockPath)} bytes, above the ${LOCK_PATH_MAX}-byte limit a Unix `
      + `domain socket can carry (${sockPath}). The kernel would truncate it, so the lock could neither exclude nor be `
      + `cleaned up. Use a shorter safety directory.`)
    err.code = 'ERR_WITNESS_LOCK_PATH_TOO_LONG'
    throw err
  }
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 })
  const infoFile = sockPath.replace(/\.sock$/, '') + '.info'
  // §1 Option A: the lock is host-local. If the safety directory sits on a
  // known NETWORK filesystem (NFS/SMB/etc.), the host-local socket cannot
  // provide cross-host exclusivity — warn loudly, since this is an operating
  // model violation, not a code bug.
  try {
    if (fs.statfsSync) {
      const NETWORK_FS_MAGIC = new Set([0x6969 /*NFS*/, 0xff534d42 /*CIFS/SMB*/, 0x517b /*SMB*/, 0xfe534d42 /*SMB2*/, 0x73757245 /*CODA*/, 0x65735543 /*FUSE*/])
      const magic = fs.statfsSync(path.dirname(sockPath)).type
      if (NETWORK_FS_MAGIC.has(magic >>> 0)) {
        console.error(`WARNING: witness safety directory appears to be on a NETWORK filesystem (fs magic 0x${(magic >>> 0).toString(16)}). The witness process lock is HOST-LOCAL and cannot prevent a second witness on another host sharing this path. Move the safety directory to local storage (one witness identity == one host).`)
      }
    }
  } catch { /* statfs unsupported or path absent — best-effort */ }
  const bind = () => new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(sockPath, () => { server.removeListener('error', reject); resolve(server) })
  })
  const probeLive = () => new Promise((resolve) => {
    // is a live process listening on this socket?
    const c = net.connect(sockPath)
    const done = (live) => { c.destroy(); resolve(live) }
    c.once('connect', () => done(true))
    c.once('error', (e) => done(false)) // ECONNREFUSED/ENOENT ⇒ no live holder
    setTimeout(() => done(false), 500).unref?.()
  })
  let server
  try {
    server = await bind()
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e
    // address in use: is the holder actually alive?
    if (await probeLive()) {
      let held = null
      try { held = JSON.parse(fs.readFileSync(infoFile, 'utf8')) } catch { /* visibility only */ }
      const who = held?.pid ? ` (held by pid ${held.pid} on ${held.host ?? 'this host'})` : ''
      // the lock name is a hash: if the holder is a DIFFERENT identity this is
      // a collision, not a double-start, and the operator must be told which.
      if (identity && held?.worldId && held?.witnessId
          && (held.worldId !== identity.worldId || held.witnessId !== identity.witnessId)) {
        const err = new Error(
          `witness process lock ${sockPath} is held by a DIFFERENT identity${who}: world ${held.worldId?.slice(0, 12)}… `
          + `witness ${held.witnessId?.slice(0, 12)}…, while this process is world ${identity.worldId.slice(0, 12)}… `
          + `witness ${identity.witnessId.slice(0, 12)}…. This is a lock-name collision, not a second start.`)
        err.code = 'ERR_WITNESS_LOCK_COLLISION'
        throw err
      }
      const err = new Error(`witness process lock ${sockPath} is held by a live process${who} — refusing to start a second witness for this (worldId, witnessId)`)
      err.code = 'ERR_WITNESS_LOCK_HELD'
      throw err
    }
    // stale socket file from a dead holder: unlink and rebind. An unlink that
    // fails for any reason other than "already gone" is reported, not
    // swallowed: silently ignoring it is what turned a stale lock into a
    // permanent refusal to start.
    try { fs.unlinkSync(sockPath) }
    catch (eu) {
      if (eu.code !== 'ENOENT') {
        const err = new Error(`witness process lock ${sockPath} is stale but could not be removed (${eu.code}): ${eu.message}`)
        err.code = 'ERR_WITNESS_LOCK_STUCK'
        throw err
      }
    }
    try { server = await bind() }
    catch (e2) {
      if (e2.code === 'EADDRINUSE') {
        const err = new Error(
          `witness process lock ${sockPath} is in use but nothing is listening on it, and removing it did not free it. `
          + `Check for a leftover socket file at that exact path and delete it.`)
        err.code = 'ERR_WITNESS_LOCK_STUCK'
        throw err
      }
      throw e2
    }
  }
  server.unref() // the lock must not keep the event loop alive on its own
  try { fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: Date.now(), ...(identity ?? {}) }) + '\n', { mode: 0o600 }) } catch { /* visibility only */ }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try { server.close() } catch { /* closing */ }
    try { fs.unlinkSync(sockPath) } catch { /* gone */ }
    try { fs.unlinkSync(infoFile) } catch { /* gone */ }
    // §3: unregister our exit listener so repeated acquire/release cycles do
    // not accumulate process listeners (which would leak closures and trip
    // Node's MaxListenersExceededWarning under a long-lived supervisor).
    process.removeListener('exit', onExit)
  }
  // a named listener so it can be removed on release; on process exit it runs
  // the same cleanup (a no-op if release() already ran).
  const onExit = () => release()
  process.once('exit', onExit)
  return { file: sockPath, release, heldBy: process.pid }
}

export function durableStore(file) {
  return {
    save: (obj) => {
      const tmp = file + '.tmp'
      const fd = fs.openSync(tmp, 'w', 0o600)
      try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, file)
      fsyncDir(path.dirname(file), { strict: true }) // consensus record: the RENAME must survive power loss
    },
    // FAIL-CLOSED reads (rev4 brief §1): only a MISSING file means "no
    // record". A corrupt, truncated, empty, permission-denied, or
    // directory-shaped safety record is evidence of trouble and must stop
    // a witness, never be treated as absence.
    load: () => {
      let raw
      try { raw = fs.readFileSync(file) } catch (e) {
        if (e.code === 'ENOENT') return null
        throw new Error(`safety record ${file} is unreadable (${e.code ?? e.message}) — refusing to treat it as absent; inspect the file`)
      }
      try { return JSON.parse(raw.toString()) } catch (e) {
        throwCoded(ERR.CORRUPT_SAFETY_RECORD, `safety record ${file} is corrupt (${e.message}) — refusing to treat it as absent; preserve and inspect the file`)
      }
    },
    // Spent safety records retire into a HISTORY JOURNAL with unique,
    // content-addressed names (final brief §5): `<file>.history/<tick>-
    // <bundleHash>.json` — never overwritten, rename fsynced, pruned to a
    // bounded window so the journal cannot grow without limit.
    archive: (name = String(Date.now())) => {
      const dir = file + '.history'
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.renameSync(file, path.join(dir, name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'))
      // rev6 §7: STRICT fsync — an archival durability failure cannot hurt
      // consensus (the frontier is already durable) but it must SURFACE:
      // the throw lands in the agreement layer's log, never in silence
      fsyncDir(dir, { strict: true })
      fsyncDir(path.dirname(file), { strict: true })
      const entries = fs.readdirSync(dir).sort()
      for (const stale of entries.slice(0, Math.max(0, entries.length - 64)))
        fs.rmSync(path.join(dir, stale), { force: true })
    },
  }
}

// An append-only finality INDEX (final pre-freeze brief §2): durable,
// forensic record of every finalized tick — tick, bundle hash, resulting
// state hash, certificate hash, and (optionally) the full certificate. This
// outlives the bounded in-memory history so conflicting historical
// certificates can be detected after any retention window, and after a
// restart. Append is via a fsynced rename of a growing NDJSON file; reads
// build a tick→entry map. Corruption is fail-closed like every safety store.
export function finalityIndexStore(file, { keepFullCert = true } = {}) {
  // append-only log + in-memory offset index (final review §10): the on-disk
  // format stays a simple NDJSON append log, but an in-memory map of
  // tick → { start, len } lets get(tick) seek directly instead of scanning
  // the whole file. Built lazily on first read, kept warm across appends, so
  // repeated lookups are O(1) and long histories don't degrade. A future
  // SQLite/LevelDB backend can drop in behind this same interface.
  let offsets = null // Map(tick -> { start, len })  (last write wins)
  let indexedBytes = 0
  const ensureOffsets = () => {
    if (offsets === null) { offsets = new Map(); indexedBytes = 0 }
    let raw
    try { raw = fs.readFileSync(file) } catch (e) {
      if (e.code === 'ENOENT') return
      throw new Error(`finality index ${file} is unreadable (${e.code ?? e.message})`)
    }
    if (raw.length <= indexedBytes) return
    let lineStart = indexedBytes
    for (let i = indexedBytes; i < raw.length; i++) {
      if (raw[i] === 0x0a) {
        const slice = raw.subarray(lineStart, i)
        if (slice.length) {
          try { const e = JSON.parse(slice.toString()); offsets.set(e.tick, { start: lineStart, len: i - lineStart }) } catch { /* validated elsewhere */ }
        }
        lineStart = i + 1
      }
    }
    indexedBytes = lineStart
  }
  const readAt = (start, len) => {
    const fd = fs.openSync(file, 'r')
    try { const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start); return JSON.parse(buf.toString()) }
    finally { fs.closeSync(fd) }
  }
  return {
    // Append one finalized record's index entry. The STORE enforces the
    // per-(worldId, tick) immutability invariant (final pre-freeze §2) — its
    // correctness does not depend on the caller checking first:
    //   • first append for a tick        → written and returned
    //   • identical append for that tick  → idempotent, returns the existing entry
    //   • conflicting append for that tick → throws (history is immutable)
    append: (record) => {
      ensureOffsets()
      const existing = offsets.get(record.tick)
      if (existing) {
        const prior = readAt(existing.start, existing.len)
        if (prior.bundleHash === record.bundleHash && prior.resultingStateHash === record.resultingStateHash)
          return prior // idempotent: history already holds this exact commitment
        const e = new Error(`finality index: refusing to overwrite tick ${record.tick} — history is immutable (indexed ${prior.bundleHash.slice(0, 8)}…→${prior.resultingStateHash.slice(0, 8)}…, attempted ${record.bundleHash.slice(0, 8)}…→${record.resultingStateHash.slice(0, 8)}…)`)
        e.conflict = { indexed: prior, committing: { tick: record.tick, bundleHash: record.bundleHash, resultingStateHash: record.resultingStateHash } }
        throw e
      }
      const entry = {
        tick: record.tick,
        bundleHash: record.bundleHash,
        resultingStateHash: record.resultingStateHash,
        certHash: E.sha256(Buffer.from(E.canonical(record))).toString('hex'),
        ...(keepFullCert ? { cert: record } : {}),
      }
      const line = JSON.stringify(entry) + '\n'
      let start = 0
      try { start = fs.statSync(file).size } catch { start = 0 }
      const fd = fs.openSync(file, 'a', 0o600)
      try { fs.writeSync(fd, line); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fsyncDir(path.dirname(file), { strict: true })
      if (offsets) { offsets.set(entry.tick, { start, len: line.length - 1 }); indexedBytes = start + line.length }
      return entry
    },
    // O(1) lookup of a finalized tick's index entry via the offset index
    get: (tick) => {
      ensureOffsets()
      const off = offsets.get(tick)
      if (off) return readAt(off.start, off.len)
      return null
    },
    // look up a single finalized tick's index entry, or null
    _getLinear: (tick) => {
      let raw
      try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
        if (e.code === 'ENOENT') return null
        throw new Error(`finality index ${file} is unreadable (${e.code ?? e.message})`)
      }
      let found = null
      for (const line of raw.split('\n')) {
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch (err) {
          throwCoded(ERR.CORRUPT_SAFETY_RECORD, `finality index ${file} has a corrupt entry (${err.message}) — preserve and inspect`)
        }
        if (e.tick === tick) found = e // last write wins (append order)
      }
      return found
    },
    // the highest indexed tick, or -1
    latestTick: () => {
      let raw
      try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
        if (e.code === 'ENOENT') return -1
        throw new Error(`finality index ${file} is unreadable (${e.code ?? e.message})`)
      }
      let max = -1
      for (const line of raw.split('\n')) {
        if (!line) continue
        try { const e = JSON.parse(line); if (e.tick > max) max = e.tick } catch { /* checked in get() */ }
      }
      return max
    },
    // Startup validation (final review §3): every record parses, its
    // canonical hashes are well-formed, each retained certificate verifies
    // against genesis, ticks are non-negative integers, and NO two entries
    // for one tick conflict. Returns null if clean, else a description of
    // the first corruption found. `verifyCert(cert)` returns null on a valid
    // certificate; when a record kept no full cert, cert verification is
    // skipped (the index-level hashes are still checked).
    validate: ({ worldId, verifyCert, verifyRecentN = Infinity } = {}) => {
      let raw
      try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
        if (e.code === 'ENOENT') return null // no index yet is fine
        return `finality index ${file} is unreadable (${e.code ?? e.message})`
      }
      const byTick = new Map()
      const parsed = []
      let lineNo = 0
      for (const line of raw.split('\n')) {
        lineNo++
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch (err) { return `line ${lineNo}: unparseable (${err.message})` }
        if (!Number.isInteger(e.tick) || e.tick < 0) return `line ${lineNo}: invalid tick ${e.tick}`
        if (typeof e.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(e.bundleHash)) return `line ${lineNo}: malformed bundleHash`
        if (typeof e.resultingStateHash !== 'string' || !/^[0-9a-f]{64}$/.test(e.resultingStateHash)) return `line ${lineNo}: malformed resultingStateHash`
        if (typeof e.certHash !== 'string' || !/^[0-9a-f]{64}$/.test(e.certHash)) return `line ${lineNo}: malformed certHash`
        // structure + hash checks on EVERY record (cheap, immutable)
        if (e.cert) {
          const h = E.sha256(Buffer.from(E.canonical(e.cert))).toString('hex')
          if (h !== e.certHash) return `line ${lineNo}: certHash does not match the retained certificate`
          if (worldId && e.cert.worldId && e.cert.worldId !== worldId) return `line ${lineNo}: certificate belongs to a different world`
        }
        const prior = byTick.get(e.tick)
        if (prior) {
          if (prior.bundleHash !== e.bundleHash || prior.resultingStateHash !== e.resultingStateHash)
            return `conflicting index entries for tick ${e.tick}: ${prior.bundleHash.slice(0, 8)}…→${prior.resultingStateHash.slice(0, 8)}… vs ${e.bundleHash.slice(0, 8)}…→${e.resultingStateHash.slice(0, 8)}…`
        } else byTick.set(e.tick, e)
        parsed.push({ e, lineNo })
      }
      // §3: full signature/quorum verification, BOUNDED to the recent tail
      if (verifyCert) {
        const from = Number.isFinite(verifyRecentN) ? Math.max(0, parsed.length - verifyRecentN) : 0
        for (let i = from; i < parsed.length; i++) {
          const { e, lineNo: ln } = parsed[i]
          if (e.cert) { const cerr = verifyCert(e.cert); if (cerr) return `line ${ln}: certificate does not verify (${cerr})` }
        }
      }
      return null
    },
  }
}

// Production finality store on SQLite (freeze & storage brief §2), behind the
// EXACT same interface as the flat-file store: { get, append, latestTick,
// validate, close }. "Storage is not consensus" — this changes only how the
// same protocol records are persisted, never the records, hashes, signatures,
// or replay semantics. It provides atomic transactions, an indexed primary
// key on (world_id, tick), a uniqueness constraint that enforces append-only
// immutability at the STORAGE layer, and crash recovery via WAL.
//
// Immutability, enforced by the schema + a transaction, not by callers:
//   • first insert for (world_id, tick) succeeds;
//   • an identical insert is idempotent (returns the existing row);
//   • a conflicting insert fails immediately (surfaced as a safety failure);
//   • finalized rows are never updated and never auto-deleted.
export function sqliteFinalityStore(file, { worldId = null, durability = {} } = {}) {
  // lazy import so environments without node:sqlite still load the module
  const { DatabaseSync } = requireSqlite()
  const db = new DatabaseSync(file)
  const journal = durability.journalMode ?? 'WAL'
  const sync = durability.synchronous ?? 'FULL'
  db.exec(`PRAGMA journal_mode = ${journal}; PRAGMA synchronous = ${sync}; PRAGMA foreign_keys = ON;`)
  db.exec(`CREATE TABLE IF NOT EXISTS finality (
    world_id TEXT NOT NULL,
    tick INTEGER NOT NULL,
    bundle_hash TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    certificate_hash TEXT NOT NULL,
    certificate BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (world_id, tick)
  );`)
  db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const wid = worldId // may be null → the store serves whatever worldId rows hold
  const selectRow = db.prepare('SELECT * FROM finality WHERE world_id = ? AND tick = ?')
  const selectRowAny = db.prepare('SELECT * FROM finality WHERE tick = ? LIMIT 1')
  const insertRow = db.prepare('INSERT INTO finality (world_id, tick, bundle_hash, state_hash, certificate_hash, certificate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const maxTick = db.prepare('SELECT MAX(tick) AS m FROM finality WHERE world_id = ?')
  const maxTickAny = db.prepare('SELECT MAX(tick) AS m FROM finality')
  const rowWorld = (r) => wid ?? r.worldId ?? r.world_id
  const toEntry = (row) => ({
    tick: row.tick, bundleHash: row.bundle_hash, resultingStateHash: row.state_hash,
    certHash: row.certificate_hash, cert: JSON.parse(Buffer.from(row.certificate).toString('utf8')),
  })
  return {
    backend: 'sqlite',
    get: (tick) => {
      const row = wid ? selectRow.get(wid, tick) : selectRowAny.get(tick)
      return row ? toEntry(row) : null
    },
    append: (record) => {
      // §3 strict world binding: a world-bound store requires every record to
      // identify its world — via the top-level worldId or its bundle.worldId
      // (certificates always carry the bundle). A record that identifies NO
      // world, or a DIFFERENT world, is rejected: cross-world contamination
      // could mask a conflicting certificate. A store with no configured
      // world (tests) is lenient.
      const recWorld = record.worldId ?? record.bundle?.worldId ?? null
      if (wid) {
        if (recWorld == null) {
          const e = new Error(`sqlite finality store for world ${String(wid).slice(0, 8)}… refuses a record with no world ID — production records must be world-bound`)
          e.code = 'ERR_WORLD_MISMATCH'
          throw e
        }
        if (recWorld !== wid) {
          const e = new Error(`sqlite finality store for world ${String(wid).slice(0, 8)}… refuses a record for world ${String(recWorld).slice(0, 8)}… — cross-world contamination`)
          e.code = 'ERR_WORLD_MISMATCH'
          throw e
        }
      }
      const rid = recWorld ?? wid
      const certHash = E.sha256(Buffer.from(E.canonical(record))).toString('hex')
      // idempotent / conflict at the STORAGE layer, inside a transaction
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = selectRow.get(rid, record.tick)
        if (existing) {
          if (existing.bundle_hash === record.bundleHash && existing.state_hash === record.resultingStateHash) {
            db.exec('COMMIT')
            return toEntry(existing) // idempotent
          }
          db.exec('ROLLBACK')
          const e = new Error(`sqlite finality store: refusing to overwrite (world ${String(rid).slice(0, 8)}…, tick ${record.tick}) — history is immutable`)
          e.conflict = { indexed: { tick: existing.tick, bundleHash: existing.bundle_hash, resultingStateHash: existing.state_hash }, committing: { tick: record.tick, bundleHash: record.bundleHash, resultingStateHash: record.resultingStateHash } }
          throw e
        }
        insertRow.run(rid, record.tick, record.bundleHash, record.resultingStateHash, certHash, Buffer.from(E.canonical(record)), Date.now())
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
        throw e
      }
      return { tick: record.tick, bundleHash: record.bundleHash, resultingStateHash: record.resultingStateHash, certHash, cert: record }
    },
    latestTick: () => {
      const r = wid ? maxTick.get(wid) : maxTickAny.get()
      return (r && r.m != null) ? r.m : -1
    },
    validate: ({ worldId: vWorld, verifyCert, verifyRecentN = Infinity } = {}) => {
      const w = vWorld ?? wid
      // §3/§6 bounded startup: the schema (PRIMARY KEY, NOT NULL columns) and
      // append-only immutability already guarantee no duplicate/partial rows,
      // so cheap column-format checks run on EVERY row via SQL, while the
      // EXPENSIVE per-record work (JSON parse + canonical re-hash + optional
      // signature verification) is bounded to the recent tail. Sealed older
      // records were fully verified when first accepted and cannot change.
      const total = (w
        ? db.prepare('SELECT COUNT(*) AS c FROM finality WHERE world_id = ?').get(w)
        : db.prepare('SELECT COUNT(*) AS c FROM finality').get()).c
      // cheap structural scan on all rows: malformed hashes or ticks anywhere
      const bad = (w
        ? db.prepare("SELECT tick FROM finality WHERE world_id = ? AND (tick < 0 OR length(bundle_hash) != 64 OR length(state_hash) != 64 OR length(certificate_hash) != 64) LIMIT 1").get(w)
        : db.prepare("SELECT tick FROM finality WHERE (tick < 0 OR length(bundle_hash) != 64 OR length(state_hash) != 64 OR length(certificate_hash) != 64) LIMIT 1").get())
      if (bad) return `malformed row at tick ${bad.tick}`
      // expensive tail: parse + re-hash (+ optional cert verify) on the newest N
      const tailN = Number.isFinite(verifyRecentN) ? Math.min(verifyRecentN, total) : total
      if (tailN > 0) {
        const tail = w
          ? db.prepare('SELECT * FROM finality WHERE world_id = ? ORDER BY tick DESC LIMIT ?').all(w, tailN)
          : db.prepare('SELECT * FROM finality ORDER BY tick DESC LIMIT ?').all(tailN)
        for (const row of tail) {
          let cert
          try { cert = JSON.parse(Buffer.from(row.certificate).toString('utf8')) } catch { return `unparseable certificate at tick ${row.tick}` }
          const h = E.sha256(Buffer.from(E.canonical(cert))).toString('hex')
          if (h !== row.certificate_hash) return `certificate_hash mismatch at tick ${row.tick}`
          if (w && cert.worldId && cert.worldId !== w) return `certificate for a different world at tick ${row.tick}`
          if (verifyCert) { const cerr = verifyCert(cert); if (cerr) return `certificate does not verify at tick ${row.tick} (${cerr})` }
        }
      }
      return null
    },
    integrityCheck: () => {
      const quick = db.prepare('PRAGMA quick_check').get()
      return quick && (quick.quick_check === 'ok' || Object.values(quick)[0] === 'ok') ? null : JSON.stringify(quick)
    },
    // §8 operational health snapshot: sizes, row count, WAL state, integrity.
    // Cheap enough to poll from a monitor; does not lock finalization.
    health: () => {
      const stat = (p) => { try { return fs.statSync(p).size } catch { return 0 } }
      const rowCount = db.prepare('SELECT COUNT(*) AS c FROM finality').get().c
      const maxT = wid
        ? db.prepare('SELECT MAX(tick) AS m FROM finality WHERE world_id = ?').get(wid)
        : db.prepare('SELECT MAX(tick) AS m FROM finality').get()
      let freeBytes = null
      try { const s = fs.statfsSync ? fs.statfsSync(path.dirname(file)) : null; if (s) freeBytes = s.bavail * s.bsize } catch { /* not all platforms */ }
      return {
        backend: 'sqlite',
        dbBytes: stat(file),
        walBytes: stat(file + '-wal'),
        shmBytes: stat(file + '-shm'),
        rows: rowCount,
        latestTick: (maxT && maxT.m != null) ? maxT.m : -1,
        journalMode: (db.prepare('PRAGMA journal_mode').get() || {}).journal_mode,
        integrity: null, // call integrityCheck() explicitly (it scans pages)
        freeDiskBytes: freeBytes,
      }
    },
    // §8 consistent online backup via VACUUM INTO — safe while the store is
    // live (does not require copying the file or stopping finalization).
    backup: (destPath) => {
      db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
      return destPath
    },
    close: () => { try { db.close() } catch { /* already closed */ } },
    _db: db,
  }
}

// resolve node:sqlite lazily and give a clear error if unavailable
function requireSqlite() {
  try { return createRequire(import.meta.url)('node:sqlite') }
  catch (e) { throw new Error('node:sqlite is unavailable in this runtime (need Node >= 22.5 with SQLite) — use finalityIndexStore (flat-file) instead: ' + e.message) }
}

// One-time migration from the flat-file finality index to SQLite (§2). It
// validates every source record, verifies certificate hashes, rejects
// conflicting ticks, inserts transactionally, verifies the row count, and
// preserves the original log as an immutable backup. It never reinterprets
// protocol data — it copies verified records verbatim.
export function migrateFlatFileToSqlite(flatFile, sqliteFile, { worldId = null, verifyCert = null } = {}) {
  // §5 fully atomic migration: validate source → build a TEMP database →
  // verify row counts, content hashes, and integrity → atomically replace the
  // destination. A failure at any step leaves NO partial production database.
  const src = finalityIndexStore(flatFile)
  const verr = src.validate({ worldId, verifyCert })
  if (verr) throw new Error(`migration aborted: source log is invalid (${verr})`)
  const raw = fs.readFileSync(flatFile, 'utf8')
  const entries = []
  for (const line of raw.split('\n')) { if (line) entries.push(JSON.parse(line)) }

  // refuse to clobber an existing destination silently
  if (fs.existsSync(sqliteFile)) throw new Error(`migration aborted: destination ${sqliteFile} already exists — move it aside first`)

  const tmpFile = sqliteFile + '.migrating.' + process.pid
  // clean any leftover temp from a previous crashed attempt
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpFile + suffix) } catch { /* absent */ } }
  const store = sqliteFinalityStore(tmpFile, { worldId })
  let inserted = 0
  try {
    for (const e of entries) {
      const rec = e.cert ?? e
      store.append({ ...rec, worldId: rec.worldId ?? worldId, tick: e.tick, bundleHash: e.bundleHash, resultingStateHash: e.resultingStateHash })
      inserted++
    }
    // verify: distinct source ticks all present, content hashes verify, integrity ok
    const distinctSrc = new Set(entries.map(e => e.tick)).size
    if (store.latestTick() < 0 && distinctSrc > 0) throw new Error('migration produced an empty store')
    for (const e of entries) {
      const got = store.get(e.tick)
      if (!got || got.bundleHash !== e.bundleHash || got.resultingStateHash !== e.resultingStateHash)
        throw new Error(`migration content mismatch at tick ${e.tick}`)
    }
    // §4 verify migrated row count using SQLite ITSELF (not just our reads)
    const dbRows = store._db.prepare('SELECT COUNT(*) AS c FROM finality').get().c
    if (dbRows !== distinctSrc) throw new Error(`migration row-count mismatch: SQLite has ${dbRows}, source has ${distinctSrc} distinct ticks`)
    const finalErr = store.validate({ worldId, verifyCert })
    if (finalErr) throw new Error(`migrated store is invalid: ${finalErr}`)
    const integ = store.integrityCheck()
    if (integ) throw new Error(`migrated store failed integrity check: ${integ}`)
    // §4 durability: TRUNCATE-checkpoint folds the WAL into the main db file so
    // the single .db is self-contained (no data lost by dropping -wal), then
    // close flushes and releases it.
    store._db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    store.close()
    // fsync the temp db bytes before the rename makes it the destination
    try { const fd = fs.openSync(tmpFile, 'r'); fs.fsyncSync(fd); fs.closeSync(fd) } catch { /* best effort on platforms without fsync-on-read-fd */ }
    // the WAL/SHM are now empty (checkpointed); remove them so only .db moves
    for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(tmpFile + suffix) } catch { /* absent */ } }
    // atomic rename temp → destination, then fsync the destination directory
    // so the rename itself survives power loss
    fs.renameSync(tmpFile, sqliteFile)
    fsyncDir(path.dirname(sqliteFile), { strict: true })
  } catch (e) {
    try { store.close() } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpFile + suffix) } catch { /* absent */ } }
    throw e
  }
  // preserve the original as an immutable backup only AFTER a successful swap
  const backup = flatFile + '.migrated-backup'
  if (!fs.existsSync(backup)) { fs.copyFileSync(flatFile, backup); try { fs.chmodSync(backup, 0o400) } catch { /* best effort */ } }
  return { inserted, distinctTicks: new Set(entries.map(e => e.tick)).size, backup }
}

export class IntervalNode {
  /**
   * @param opts.genesis   genesis object (spec version + rules hash + seed)
   * @param opts.buildWorld  fn(genesis) -> initial world state (must be identical across peers)
   * @param opts.name      label for logs
   * @param opts.tamper    optional fn(state) -> state, simulates a rule-breaking node
   */
  constructor(opts) {
    this.genesis = opts.genesis
    // rev7 §3: the node validates its OWN founding boundary BEFORE any
    // world is built — never assume the caller (or an injected
    // buildWorld) already did
    {
      const gerr = E.validateGenesis(this.genesis)
      if (gerr) throwCoded(ERR.INVALID_GENESIS, `refusing to run on an invalid genesis: ${gerr}`)
    }
    this.name = opts.name
    this.tamper = opts.tamper || null
    // pre-freeze §6: EVERY builder result is validated the moment it
    // returns — never conditioned on tick, never assumed. A valid
    // checkpoint may replace this state afterward through the normal
    // checkpoint-verification path.
    this.state = opts.buildWorld(opts.genesis)
    {
      const serr = E.validateState(this.state)
      if (serr) throwCoded(ERR.INVALID_BUILT_STATE, `buildWorld produced an invalid state (${serr}) — refusing to run`)
      if (E.canonical(this.state.genesis) !== E.canonical(this.genesis))
        throwCoded(ERR.INVALID_BUILT_STATE, 'buildWorld embedded a DIFFERENT genesis than the one supplied — refusing to run on an ambiguous founding')
    }
    this.inputBuffer = new Map()        // tick -> Map(playerId -> input)
    this.peerHashes = new Map()         // tick -> Map(peerId -> hash)
    this.myHashes = new Map()           // tick -> hash
    this.divergent = new Map()          // peerId -> first divergent tick
    this.onTick = null                  // layer-2 hook: called after each tick
    this.log = []
    // fix brief §2.2: every network surface is namespaced by the COMPLETE
    // world ID (hash of the full canonical genesis). Same constitution +
    // different seed/anchor/dimensions = different world = different network.
    this.worldId = E.worldId(this.genesis)
    const wid = this.worldId
    this.topics = {
      inputs: `interval/${wid}/inputs`,
      hashes: `interval/${wid}/hashes`,
      bundles: `interval/${wid}/bundles`,
      attestations: `interval/${wid}/attestations`,
      finality: `interval/${wid}/finality`,
    }
    this.checkpointProto = `/interval/${wid}/checkpoint/2.0.0`
    this.chatTopic = `interval/${wid}/chat/2.0.0`
    this.onChat = null
    this._chatLast = new Map()          // playerId -> ms of last accepted message
    this.ticklogProto = `/interval/${wid}/ticklog/2.0.0`
    this.tickLog = new Map()            // tick -> inputs applied (recent history)
    this.checkpointFile = opts.checkpointFile || null
    // §1: checkpoints accelerate recovery; they need NOT be written every
    // finalized tick (finality certificates already preserve every
    // transition). Write at most every `checkpointInterval` ticks (default
    // 1000), plus once on clean shutdown. Set to 1 for the legacy
    // every-tick behavior. "Checkpoint frequency is not consensus."
    this.checkpointInterval = Math.max(1, opts.checkpointInterval ?? 1000)
    // §2: bounded startup verification is the GENERIC default. An omitted
    // value resolves to the shared bounded constant (not Infinity). Infinity
    // is an explicit audit opt-in; 0 disables cert re-verification (structure
    // is still checked on every row). `?? ` — not `||` — so an explicit 0 is
    // honored rather than falling back to the default.
    this.startupVerifyRecentN = opts.startupVerifyRecentN ?? DEFAULT_STARTUP_VERIFY_RECENT_N
    this._lastCheckpointTick = -1
    this.listen = opts.listen || null
    this.peerKeyFile = opts.peerKeyFile || null
    // serialized checkpoint writer state (fix brief §6.1)
    this._cpWriting = false
    this._cpPending = null
    this._cpSeq = 0
    this._cpIdle = null          // promise resolved when the writer goes idle
    this._cpIdleResolve = null
    this._cpFatal = null         // set if a shutdown-time write failed (fail closed)
    // resume from disk if a checkpoint exists (spec §9a: persistence),
    // but only after the envelope proves it belongs to THIS world (§2.5, §6.4)
    if (this.checkpointFile && fs.existsSync(this.checkpointFile)) {
      // rev4 brief §8: a MISSING checkpoint is a fresh boot; an EXISTING
      // one that is unreadable or invalid is evidence of trouble. A
      // witness must never silently recreate genesis over it — a fresh
      // tick-0 state under a durable frontier is precisely the rollback
      // the frontier exists to refuse, so fail here, with the better
      // message, and preserve the file. Observers may resynchronize.
      let cp = null, cperr = null
      try { cp = JSON.parse(fs.readFileSync(this.checkpointFile)) } catch (e) { cperr = 'unreadable: ' + e.message }
      if (!cperr) cperr = this.validateCheckpoint(cp)
      if (cperr) {
        if (opts.witnessKey) throwCoded(ERR.INVALID_CHECKPOINT, `witness checkpoint ${this.checkpointFile} is invalid (${cperr}) — refusing to recreate state over it; preserve the file, then restore a valid checkpoint or sync a certified one`)
        this.log.push(`[${this.name}] disk checkpoint rejected (${cperr}); founding fresh state (observer will re-sync)`)
      } else {
        this.state = cp.state
        this._resumedProof = cp.finalityProof ?? null
        this.log.push(`[${this.name}] resumed from disk checkpoint at tick ${cp.tick}`)
      }
    }


    // ---- certified interval bundles (fix brief Milestone 4) ----
    // A genesis WITH a witness set is an authoritative world: nothing
    // finalizes except through quorum-attested bundles, and the local
    // timer only paces proposals. A genesis WITHOUT one runs the legacy
    // optimistic mode (spec §9e) — kept for the early demos, never for
    // an authoritative network.
    this.agreement = null
    this.witnessKey = opts.witnessKey ?? null
    if (Array.isArray(this.genesis.witnesses)) {
      // CONSENSUS.md §4 / LOCK-1: the vote lock must be ON DISK before the
      // attestation is broadcast. The frontier file (CONSENSUS.md §6.3)
      // guards the other direction: a restart from a stale checkpoint —
      // which would re-sign already-finalized history — refuses to start.
      // rev5 §1: safety records live in a WORLD-NAMESPACED directory —
      //   <safetyDir>/<worldId>/{active-lock.json, frontier.json,
      //                          active-lock.json.history/}
      // so reusing a filesystem path across worlds cannot cross records.
      // (opts.lockFile/frontierFile remain for explicit paths and tests.)
      let safetyBase = null
      if (opts.safetyDir) {
        // brief §1 layout: witness-safety/<worldId>/<witnessId>/… so two
        // witnesses on one host, or one witness across worlds, never share a
        // safety directory. Observers (no witnessKey) keep the flat
        // world-namespaced layout.
        safetyBase = this.witnessKey
          ? path.join(opts.safetyDir, this.worldId, this.witnessKey.playerId)
          : path.join(opts.safetyDir, this.worldId)
        fs.mkdirSync(safetyBase, { recursive: true, mode: 0o700 })
        // §1: an exclusive process-lifetime lock for this (worldId,
        // witnessId). A second live process for the same identity is refused
        // BEFORE the agreement layer starts, so it can never emit an
        // attestation and race the first into a double-sign.
        // §1/§2: a TRUE kernel-held exclusive lock for this (worldId,
        // witnessId), acquired in start() BEFORE the agreement layer begins
        // driving — a second live process for the same identity is refused,
        // so it can never emit an attestation and race the first into a
        // double-sign. We only record the path here (acquisition is async).
        if (this.witnessKey && opts.exclusiveProcessLock !== false) {
          // NOT inside safetyBase: that path is far longer than a Unix socket
          // can carry, and the kernel would truncate it silently. The lock gets
          // a short hashed name; safetyBase still holds all the durable state.
          this._processLockPath = processLockPathFor(opts.safetyDir, this.worldId, this.witnessKey.playerId)
          this._processLockIdentity = { worldId: this.worldId, witnessId: this.witnessKey.playerId }
          // best effort: sweep the truncated lock files older builds left behind,
          // which no unlink could ever match and which blocked every restart.
          try {
            const stale = path.join(opts.safetyDir, this.worldId, this.witnessKey.playerId)
            for (const nm of fs.readdirSync(path.dirname(stale))) {
              const p2 = path.join(path.dirname(stale), nm)
              if (nm.length >= 20 && !nm.includes('.') && fs.statSync(p2).isSocket()) fs.unlinkSync(p2)
            }
          } catch { /* nothing to sweep */ }
        }
      }
      const lockStore = opts.lockStore
        ?? (safetyBase ? durableStore(path.join(safetyBase, 'active-lock.json'))
          : opts.lockFile ? durableStore(opts.lockFile) : null)
      const frontierStore = opts.frontierStore
        ?? (safetyBase ? durableStore(path.join(safetyBase, 'frontier.json'))
          : opts.frontierFile ? durableStore(opts.frontierFile)
            : opts.lockFile ? durableStore(opts.lockFile.replace(/\.lock$/, '') + '.frontier') : null)
      // append-only durable finality index (§2): forensic history for
      // conflicting-certificate detection beyond the in-memory window. The
      // backend is selectable behind one interface — "storage is not
      // consensus". SQLite is the default EVERYWHERE (production brief §2);
      // 'flatfile' is the explicit dev/compat option. Unknown values are
      // rejected rather than silently falling back.
      const backend = opts.finalityBackend ?? 'sqlite'
      if (backend !== 'sqlite' && backend !== 'flatfile')
        throwCoded(ERR.INVALID_BACKEND, `unknown finalityBackend '${backend}' — expected 'sqlite' (default) or 'flatfile'`)
      const finalityIndexStore_ = opts.finalityIndexStore
        ?? (safetyBase
          ? (backend === 'sqlite'
            ? sqliteFinalityStore(path.join(safetyBase, 'finality.db'), { worldId: this.worldId })
            : finalityIndexStore(path.join(safetyBase, 'finality-index.ndjson')))
          : opts.finalityIndexFile ? finalityIndexStore(opts.finalityIndexFile) : null)
      // §1 recovery: with sparse checkpoints the loaded snapshot can sit
      // BEHIND the durable frontier. Finality certificates preserve every
      // transition, so replay the certified records from (checkpoint+1) up to
      // the frontier — each verified and re-executed byte-for-byte — BEFORE
      // the agreement's frontier check runs. This turns "checkpoint behind
      // frontier" from a refusal into a fast, certified catch-up.
      if (this.witnessKey && frontierStore && finalityIndexStore_) {
        this._replayCheckpointToFrontier(frontierStore, finalityIndexStore_)
      }
      this.agreement = new IntervalAgreement({
        genesis: this.genesis, worldId: this.worldId, name: this.name,
        witnessKey: this.witnessKey, lockStore, frontierStore, finalityIndexStore: finalityIndexStore_,
        recoveryProof: this._resumedProof ?? null,        // certifies a state ahead of the frontier (rev4 §9)
        allowEphemeralStores: opts.allowEphemeralStores ?? false,
        startupVerifyRecentN: this.startupVerifyRecentN, // §2 bounded startup verification (resolved default)
        getState: () => this.state,
        setState: (next) => { this.state = next },
        publish: (kind, obj) => {
          const topic = kind === 'bundle' ? this.topics.bundles
            : kind === 'attestation' ? this.topics.attestations : this.topics.finality
          this.p2p?.services.pubsub.publish(topic, Buffer.from(JSON.stringify(obj))).catch(() => {})
        },
        onFinalized: (record) => this.afterFinalize(record),
        log: (line) => { this.log.push(`[${this.name}] ${line}`); if (opts.verbose) console.log(`[${this.name}] ${line}`) },
      })
    }
  }

  // Phase 10: two clocks, named apart. scheduledTick predicts where local
  // time says the world should be; finalizedTick is the highest interval
  // with a valid quorum proof. Windows act from the finalized one.
  get finalizedTick() { return this.state.tick }
  get scheduledTick() {
    return this.agreement ? this.agreement.scheduledTick()
      : Math.max(0, Math.floor((Date.now() - this.genesis.anchorMs) / E.TICK_MS))
  }

  // Every finalization: bookkeeping that legacy advanceTick used to do.
  afterFinalize(record) {
    const hash = record.resultingStateHash
    this.myHashes.set(record.tick + 1, hash)
    this.checkDivergence(record.tick + 1)
    const horizon = this.state.tick - LIMITS.MAX_HASH_HISTORY_TICKS
    for (const t of this.myHashes.keys()) if (t < horizon) this.myHashes.delete(t)
    for (const t of this.peerHashes.keys()) if (t < horizon) this.peerHashes.delete(t)
    for (const t of this.inputBuffer.keys()) if (t < this.state.tick) this.inputBuffer.delete(t)
    if (this.checkpointFile && this.state.tick - this._lastCheckpointTick >= this.checkpointInterval) {
      this._lastCheckpointTick = this.state.tick
      this.queueCheckpoint()
    }
    if (this.onTick) this.onTick(this.state)
    this.p2p?.services.pubsub.publish(
      this.topics.hashes,
      Buffer.from(JSON.stringify({ tick: record.tick + 1, hash, peer: this.peerId() })))
      .catch(() => {})
  }

  // Fix brief §2.5 / §6.4 / Phase 9: a checkpoint is adopted only if its
  // envelope is internally consistent, bound to this exact world, and —
  // in a witnessed world — carries a valid quorum finality proof for its
  // state. Returns an error string, or null when valid.
  validateCheckpoint(cp) {
    if (!cp || typeof cp !== 'object' || !cp.state) return 'malformed'
    if (cp.worldId !== this.worldId) return 'wrong world'
    if (E.canonical(cp.state.genesis) !== E.canonical(this.genesis)) return 'genesis mismatch'
    if (!Number.isInteger(cp.tick) || cp.state.tick !== cp.tick) return 'tick inconsistent'
    if (typeof cp.stateHash !== 'string' || !/^[0-9a-f]{64}$/.test(cp.stateHash)) return 'malformed state hash'
    if (E.stateHash(cp.state) !== cp.stateHash) return 'state hash mismatch'
    // Priority 5: never replay from a structurally hostile state — bounds,
    // shapes, and safe integers are checked before the state touches the engine
    const serr = E.validateState(cp.state)
    if (serr) return 'invalid state: ' + serr
    if (Array.isArray(this.genesis.witnesses) && cp.tick > 0) {
      // Phase 9: trust is the proof carried by the bytes, not the server
      // that sent them. Tick 0 needs no proof — genesis is reproducible.
      const proof = cp.finalityProof
      if (!proof) return 'no finality proof'
      const perr = P.verifyFinalityProof(this.genesis, this.worldId, proof)
      if (perr) return 'finality proof invalid: ' + perr
      if (proof.tick !== cp.tick - 1) return 'finality proof for wrong tick'
      if (proof.resultingStateHash !== cp.stateHash) return 'finality proof does not certify this state'
    }
    return null
  }

  // §1: advance the loaded checkpoint state up to the durable frontier by
  // replaying certified finalized records. Each record is verified against
  // genesis and re-executed deterministically; the resulting hash must match
  // the certificate. This is the "restart from checkpoint + replay" path that
  // makes sparse checkpoints safe — state reaches the frontier before the
  // agreement layer decides whether it may sign.
  _replayCheckpointToFrontier(frontierStore, finalityIndex) {
    let f
    try { f = frontierStore.load() } catch { return } // corrupt frontier handled by the agreement
    if (!f || typeof f.tick !== 'number') return
    // state.tick is the NEXT tick to run; the frontier records the last
    // finalized tick. If state is already at/after frontier+1, nothing to do.
    while (this.state.tick <= f.tick) {
      const tick = this.state.tick
      let entry
      try { entry = finalityIndex.get(tick) } catch (e) { throw new Error(`recovery: finality index unreadable at tick ${tick} (${e.message})`) }
      if (!entry) {
        // no certified record for a tick the frontier claims finalized: the
        // agreement's frontier check will refuse startup with a clear error
        return
      }
      const cert = entry.cert ?? entry
      const perr = P.verifyFinalityProof(this.genesis, this.worldId, cert)
      if (perr) throw new Error(`recovery: certified record at tick ${tick} does not verify (${perr})`)
      if (E.stateHash(this.state) !== cert.previousStateHash)
        throw new Error(`recovery: state hash at tick ${tick} does not match the certified previous-state hash — checkpoint and finality history disagree`)
      const next = E.nextState(this.state, cert.bundle.inputs)
      if (E.stateHash(next) !== cert.resultingStateHash)
        throw new Error(`recovery: replay at tick ${tick} produced a different state than certified — refusing to resume on divergent history`)
      this.state = next
      this._resumedProof = cert
    }
    if (this.state.tick > (this._lastCheckpointTick ?? -1)) this._lastCheckpointTick = this.state.tick - 1
  }

  async start() {
    // §2: acquire the exclusive kernel-held witness lock BEFORE anything
    // else — before networking, before the agreement drives — so a duplicate
    // process is rejected before it can touch the network or sign.
    if (this._processLockPath && !this._processLock) {
      this._processLock = await acquireProcessLock(this._processLockPath, this._processLockIdentity)
    }
    // §2 fail-safe startup: from here on, any failure must release EVERY
    // partially-initialized resource (lock, SQLite, libp2p) so a restart can
    // immediately re-acquire — a half-started witness must not linger holding
    // exclusivity or a socket.
    try {
      return await this._startInner()
    } catch (e) {
      try { await this.p2p?.stop() } catch { /* may not exist yet */ }
      try { this.agreement?.finalityIndex?.close?.() } catch { /* may be closed */ }
      this._processLock?.release()
      this._processLock = null
      throw e
    }
  }

  async _startInner() {
    // a node's peer identity persists across restarts: a witness that
    // changes its name every morning is not a stable witness
    let peerPriv = null
    if (this.peerKeyFile) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.peerKeyFile, 'utf8')).raw
        peerPriv = privateKeyFromRaw(Uint8Array.from(Buffer.from(raw, 'hex')))
      } catch {
        peerPriv = await generateKeyPair('Ed25519')
        fs.writeFileSync(this.peerKeyFile, JSON.stringify({ raw: Buffer.from(peerPriv.raw).toString('hex') }))
      }
    }
    this.p2p = await createLibp2p({
      ...(peerPriv ? { privateKey: peerPriv } : {}),
      addresses: { listen: [this.listen ?? '/ip4/0.0.0.0/tcp/0'] }, // dialable by default: a mesh of mutes is a star
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
        identify: identify(),
      },
    })
    const ps = this.p2p.services.pubsub
    ps.subscribe(this.topics.inputs)
    ps.subscribe(this.topics.hashes)
    ps.subscribe(this.chatTopic)
    if (this.agreement) {
      ps.subscribe(this.topics.bundles)
      ps.subscribe(this.topics.attestations)
      ps.subscribe(this.topics.finality)
    }
    this.p2p.addEventListener('peer:connect', (e) => {
      console.log(`[${this.name}] peer connected: ${e.detail.toString().slice(0, 24)}… (${this.p2p.getConnections().length} total)`)
    })
    this.p2p.addEventListener('peer:disconnect', (e) => {
      console.log(`[${this.name}] peer left: ${e.detail.toString().slice(0, 24)}… (${this.p2p.getConnections().length} total)`)
    })
    ps.addEventListener('message', (evt) => this.onMessage(evt))
    // serve recent input history for catch-up (spec §9b)
    await this.p2p.handle(this.ticklogProto, async ({ stream }) => {
      // remaining-fixes brief §8: a request may span many transport chunks
      // — and §7: it may also be hostile in size. Read fully, bounded.
      let reqBuf
      try { reqBuf = await readAll(stream.source, LIMITS.MAX_REQUEST_BYTES) } catch { return }
      let req; try { req = JSON.parse(reqBuf.toString()) } catch { return }
      // fix brief §5.4: a replay request cannot demand unbounded history
      if (!Number.isInteger(req.from) || !Number.isInteger(req.to) || req.to < req.from) return
      const to = Math.min(req.to, req.from + LIMITS.MAX_REPLAY_TICKS_PER_REQUEST)
      const out = []
      let bytes = 0
      if (this.agreement) {
        // Milestone 5: catch-up material is CERTIFIED bundles — each entry
        // carries its own quorum proof, so the server earns no trust
        for (let t = req.from; t < to && out.length < P.AGREEMENT.MAX_CATCHUP_RECORDS; t++) {
          const rec = this.agreement.finalizedLog.get(t)
          if (!rec) break // gap: serve what we contiguously have
          bytes += JSON.stringify(rec).length
          if (bytes > LIMITS.MAX_REPLAY_RESPONSE_BYTES) break
          out.push(rec)
        }
      } else {
        for (let t = req.from; t < to; t++) {
          if (!this.tickLog.has(t)) break // gap: serve what we contiguously have
          const entry = { tick: t, inputs: this.tickLog.get(t) }
          bytes += JSON.stringify(entry).length
          if (bytes > LIMITS.MAX_REPLAY_RESPONSE_BYTES) break
          out.push(entry)
        }
      }
      stream.sink([Buffer.from(JSON.stringify(out))]).catch(() => {})
    })

    // serve our latest checkpoint to joining peers (spec §9a)
    await this.p2p.handle(this.checkpointProto, ({ stream }) => {
      console.log(`[${this.name}] serving checkpoint at tick ${this.state.tick} to a joining peer`)
      const cp = Buffer.from(JSON.stringify(this.checkpointEnvelope()))
      stream.sink([cp]).catch(() => {})
    })
    return this
  }

  // Late join (spec §9a). In a witnessed world a checkpoint carries a
  // quorum finality proof, so ONE peer is enough: we verify the proof,
  // not the peer (fix brief Phase 9 — "verify a proof carried by bytes
  // from any server"). In legacy worlds, >=2 corroborating peers remain
  // required (allowSingle accepts founder-trust explicitly).
  async syncFromPeers(addrs, opts = {}) {
    const proven = Array.isArray(this.genesis.witnesses)
    if (!proven && addrs.length < 2 && !opts.allowSingle) throw new Error('need >=2 peers to corroborate a checkpoint')
    if (addrs.length < 1) throw new Error('no peers to sync from')
    const cps = []
    for (const addr of addrs) {
      const stream = await this.p2p.dialProtocol(addr, this.checkpointProto)
      const buf = await readAll(stream.source, LIMITS.MAX_CHECKPOINT_BYTES)
      cps.push(JSON.parse(buf.toString()))
    }
    // fix brief §2.5: matching bytes are not enough — every checkpoint must
    // be bound to THIS world (worldId, byte-identical genesis, consistent
    // envelope, quorum proof where the world has witnesses)
    for (const cp of cps) {
      const err = this.validateCheckpoint(cp)
      if (err) throwCoded(ERR.CHECKPOINT_REJECTED, 'checkpoint rejected: ' + err + ' — refusing to adopt')
    }
    const hashes = cps.map(cp => cp.stateHash)
    const ticks = cps.map(cp => cp.tick)
    if (new Set(hashes).size !== 1 || new Set(ticks).size !== 1) {
      throwCoded(ERR.CHECKPOINT_UNCORROBORATED, 'checkpoint corroboration failed: peers disagree — refusing to adopt')
    }
    this.adoptState(cps[0].state, cps[0].finalityProof)
    this.myHashes.set(this.state.tick, hashes[0])
    this.log.push(`[${this.name}] joined at tick ${this.state.tick}, checkpoint ${proven ? 'proof-verified' : 'corroborated by ' + cps.length + ' peers'} (${hashes[0].slice(0, 8)}…)`)
    return this.state.tick
  }

  // Adopting externally-verified state must also move the agreement
  // layer's lineage pointer, or every future bundle is 'wrong lineage'.
  adoptState(state, proof = null) {
    this.state = state
    this._resumedProof = proof
    if (this.agreement) {
      this.agreement.prevHash = E.stateHash(state)
      this.agreement.latestRecord = proof ?? this.agreement.latestRecord
      this.agreement.pending.clear()
      this.agreement.proposals.clear()
      this.agreement.atts.clear()
      this.agreement.proposedRounds.clear()
      this.agreement.seenProposals.clear()
      this.agreement.poisonedProposers.clear()
      // a vote lock for a tick now BEHIND the adopted frontier is spent;
      // a lock AT the frontier still binds (LOCK-2) and is kept
      if (this.agreement.lock && this.agreement.lock.tick < state.tick) this.agreement.lock = null
    }
  }

  addr() { return this.p2p.getMultiaddrs()[0] }
  async dial(addr) { await this.p2p.dial(addr) }
  peerId() { return this.p2p.peerId.toString() }
  listenPort() {
    for (const a of this.p2p.getMultiaddrs()) {
      const m = /\/tcp\/(\d+)/.exec(a.toString())
      if (m) return Number(m[1])
    }
    return null
  }

  acceptChat(msg) { // spec §9c: signed, short, one per interval per key
    if (!msg || typeof msg !== 'object') return false
    if (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > 80) return false
    if (msg.worldId !== this.worldId) return false // §2.3: chat is world-bound
    if (!E.verifyInputSig(msg, E.SIG_DOMAINS.chat)) return false // §2.3: chat domain, never replayable as an input
    const now = Date.now()
    if (now - (this._chatLast.get(msg.playerId) ?? 0) < E.TICK_MS) return false
    if (this._chatLast.size >= LIMITS.MAX_CHAT_SENDERS && !this._chatLast.has(msg.playerId)) {
      // §5.5: the rate table cannot grow without bound; drop the oldest entry
      this._chatLast.delete(this._chatLast.keys().next().value)
    }
    this._chatLast.set(msg.playerId, now)
    return true
  }

  async publishSignedChat(msg) { // browser-signed: validate, echo, publish
    if (!this.acceptChat(msg)) return false
    if (this.onChat) this.onChat(msg)
    await this.p2p.services.pubsub.publish(this.chatTopic, Buffer.from(JSON.stringify(msg)))
    return true
  }
  async publishChat(identity, text) {
    const msg = E.signInput(
      { type: 'chat', worldId: this.worldId, playerId: identity.playerId, tick: this.state.tick, text: String(text).slice(0, 80) },
      identity.privateKey, E.SIG_DOMAINS.chat)
    if (this.acceptChat(msg) && this.onChat) this.onChat(msg) // local echo
    await this.p2p.services.pubsub.publish(this.chatTopic, Buffer.from(JSON.stringify(msg)))
  }

  onMessage(evt) {
    const { topic, data } = evt.detail
    // fix brief §5.3: check size BEFORE parsing or allocating anything
    const cap = topic === this.chatTopic ? LIMITS.MAX_CHAT_BYTES
      : topic === this.topics.bundles ? P.AGREEMENT.MAX_BUNDLE_BYTES
      : topic === this.topics.attestations ? P.AGREEMENT.MAX_ATTESTATION_BYTES
      : topic === this.topics.finality ? P.AGREEMENT.MAX_FINALITY_BYTES
      : LIMITS.MAX_GOSSIP_BYTES
    if (data.length > cap) return
    let msg
    try { msg = JSON.parse(Buffer.from(data).toString()) } catch { return }
    if (!msg || typeof msg !== 'object') return

    if (topic === this.chatTopic) {
      if (this.acceptChat(msg) && this.onChat) this.onChat(msg)
      return
    }

    if (this.agreement) {
      if (topic === this.topics.bundles) return this.agreement.onBundle(msg)
      if (topic === this.topics.attestations) return this.agreement.onAttestation(msg)
      if (topic === this.topics.finality) { this.agreement.onFinality(msg); return }
      if (topic === this.topics.inputs) { this.agreement.addInput(msg); return }
    }

    if (topic === this.topics.inputs) {
      // Buffer inputs for current/near-future ticks only (§5.2). Signature
      // validity is re-checked by the state machine itself at application time.
      if (!Number.isInteger(msg.tick) || msg.tick < this.state.tick) return
      if (msg.tick > this.state.tick + LIMITS.MAX_FUTURE_TICKS) return
      if (msg.worldId !== this.worldId) return // §2.3: not our world
      if (typeof msg.playerId !== 'string' || !/^[0-9a-f]{64}$/.test(msg.playerId)) return
      if (!this.inputBuffer.has(msg.tick)) {
        if (this.inputBuffer.size >= LIMITS.MAX_BUFFERED_INTERVALS) return
        this.inputBuffer.set(msg.tick, new Map())
      }
      const bucket = this.inputBuffer.get(msg.tick)
      if (!bucket.has(msg.playerId) && bucket.size >= LIMITS.MAX_INPUTS_PER_INTERVAL) return
      // duplicate handling mirrors spec §5: second input poisons the bundle
      bucket.set(msg.playerId, bucket.has(msg.playerId) ? 'DUP' : msg)
    }

    if (topic === this.topics.hashes) {
      const { tick, hash } = msg
      // remaining-fixes brief §9: NEVER trust an identity supplied inside
      // the JSON — bind the announcement to the transport identity. Gossip
      // messages are StrictSign'd by libp2p, so evt.detail.from is the
      // authenticated ORIGINATOR, unforgeable by relays. These
      // announcements are DIAGNOSTICS ONLY (divergence flags in the UI):
      // finality comes exclusively from quorum certificates.
      const src = evt.detail.from?.toString?.()
      if (!src) return
      if (!Number.isInteger(tick) || typeof hash !== 'string' || hash.length > 64) return
      // §5.5: hash history is a window around the present, not an archive
      if (tick < this.state.tick - LIMITS.MAX_HASH_HISTORY_TICKS
        || tick > this.state.tick + LIMITS.MAX_FUTURE_TICKS) return
      if (!this.peerHashes.has(tick)) this.peerHashes.set(tick, new Map())
      this.peerHashes.get(tick).set(src, hash)
      this.checkDivergence(tick)
    }
  }

  checkDivergence(tick) {
    const mine = this.myHashes.get(tick)
    if (!mine) return
    for (const [peer, hash] of this.peerHashes.get(tick) || []) {
      if (hash !== mine && !this.divergent.has(peer)) {
        this.divergent.set(peer, tick)
        this.log.push(`[${this.name}] DIVERGENCE: peer ${peer.slice(0, 8)}… broke the rules at tick ${tick} — ignoring their world`)
      }
    }
  }

  // Submit a locally-authored (already signed) input: hand it to the
  // agreement layer (or the legacy buffer) AND gossip it to the mesh.
  async submitInput(input) {
    if (this.agreement) {
      this.agreement.addInput(input)
    } else {
      if (!this.inputBuffer.has(input.tick)) this.inputBuffer.set(input.tick, new Map())
      const bucket = this.inputBuffer.get(input.tick)
      bucket.set(input.playerId, bucket.has(input.playerId) ? 'DUP' : input)
    }
    await this.p2p.services.pubsub.publish(
      this.topics.inputs, Buffer.from(JSON.stringify(input)))
  }

  // LEGACY optimistic mode only (worlds without a witness set): advance
  // on the local timer. In an authoritative world nothing finalizes on a
  // timer — the agreement layer owns finalization, and this is a bug.
  async advanceTick() {
    if (this.agreement) throw new Error('advanceTick is forbidden in a witnessed world: finality comes from quorum, not the clock')
    const tick = this.state.tick
    const bucket = this.inputBuffer.get(tick) || new Map()
    const inputs = [...bucket.entries()]
      .filter(([, v]) => v !== 'DUP')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, v]) => v)
    const beacon = E.beaconValue(this.genesis.genesisSeed, tick)

    this.tickLog.set(tick, inputs)
    if (this.tickLog.size > 256) this.tickLog.delete(Math.min(...this.tickLog.keys()))
    this.state = E.nextState(this.state, inputs, beacon)
    if (this.tamper) this.state = this.tamper(this.state) // rule-breaker path

    const hash = E.stateHash(this.state)
    this.myHashes.set(tick + 1, hash)
    this.inputBuffer.delete(tick)
    this.checkDivergence(tick + 1)

    // §5.5: prune history maps by finalized tick — bounded memory forever
    const horizon = this.state.tick - LIMITS.MAX_HASH_HISTORY_TICKS
    for (const t of this.myHashes.keys()) if (t < horizon) this.myHashes.delete(t)
    for (const t of this.peerHashes.keys()) if (t < horizon) this.peerHashes.delete(t)
    for (const t of this.inputBuffer.keys()) if (t < this.state.tick) this.inputBuffer.delete(t)

    // persist checkpoint OFF the tick path, through the serialized writer
    // (fix brief §6): one write at a time, newest snapshot wins, crash-safe
    // rename, and failures are logged instead of swallowed. §1: only every
    // `checkpointInterval` finalized ticks — finality certificates already
    // record every transition, so checkpoints exist purely to speed recovery.
    if (this.checkpointFile && this.state.tick - this._lastCheckpointTick >= this.checkpointInterval) {
      this._lastCheckpointTick = this.state.tick
      this.queueCheckpoint()
    }

    // local windows hear the tick FIRST; the mesh hears it when it hears it.
    // Awaiting the gossip publish here fed libp2p's flush stalls straight
    // into browser broadcast timing: the second half of the walking stutter.
    if (this.onTick) this.onTick(this.state)
    this.p2p.services.pubsub.publish(
      this.topics.hashes,
      Buffer.from(JSON.stringify({ tick: tick + 1, hash, peer: this.peerId() })))
      .catch(() => {})
    return hash
  }

  // The checkpoint envelope (fix brief §6.4): integrity metadata that
  // validateCheckpoint() verifies before any state is adopted.
  checkpointEnvelope() {
    return {
      formatVersion: 3,
      worldId: this.worldId,
      tick: this.state.tick,
      stateHash: E.stateHash(this.state),
      state: this.state,
      // the record whose quorum certifies exactly this state (Phase 9)
      finalityProof: this.agreement?.latestRecord ?? this._resumedProof ?? null,
    }
  }

  // Serialized checkpoint writer (fix brief §6.1–6.3, §6.5):
  //  - never two writes in flight; a newer snapshot REPLACES the pending one
  //  - uniquely named temp file, fsync, then atomic rename
  //  - errors surface in the log instead of vanishing
  queueCheckpoint() {
    // §1: once shutdown begins, no NEW checkpoint may be queued by normal
    // operation — the only checkpoint after that point is the single final
    // one written via _queueCheckpointInternal() before exclusivity releases.
    if (this._shuttingDown) return
    this._queueCheckpointInternal()
  }

  _queueCheckpointInternal() {
    this._cpPending = this.checkpointEnvelope()
    if (this._cpWriting) return // the in-flight write will pick this up after
    this._cpWriting = true
    // a promise that resolves when the writer goes idle (no in-flight write,
    // nothing pending). The drain awaits THIS rather than polling a deadline,
    // so shutdown blocks on genuine completion, never on a timer.
    this._cpIdle = new Promise((resolve) => { this._cpIdleResolve = resolve })
    const writeLoop = async () => {
      let fatal = null
      while (this._cpPending) {
        const snap = JSON.stringify(this._cpPending)
        this._cpPending = null
        const tmp = `${this.checkpointFile}.tmp-${process.pid}-${this._cpSeq++}`
        try {
          const fh = await fs.promises.open(tmp, 'w')
          try {
            await fh.writeFile(snap)
            await fh.sync() // flushed before the rename makes it official
          } finally {
            await fh.close()
          }
          await fs.promises.rename(tmp, this.checkpointFile)
          // Checkpoint persistence is BEST-EFFORT operational state
          // (rev5 §7, documented policy): consensus safety depends only
          // on the durable vote lock and frontier; a lost checkpoint
          // costs a re-sync, never a double-sign. Hence non-strict fsync.
          fsyncDir(path.dirname(this.checkpointFile))
        } catch (e) {
          this._cpFailures = (this._cpFailures ?? 0) + 1
          if (this._cpFailures <= 3 || this._cpFailures % 100 === 0) {
            console.error(`[${this.name}] checkpoint write FAILED (${this._cpFailures}x): ${e.message}`)
          }
          await fs.promises.rm(tmp, { force: true }).catch(() => {})
          // during shutdown a write failure must FAIL CLOSED — the drain
          // needs to see it, not have it swallowed as best-effort.
          if (this._shuttingDown) { fatal = e; break }
        }
      }
      this._cpWriting = false
      this._cpFatal = fatal
      const resolve = this._cpIdleResolve
      this._cpIdleResolve = null
      this._cpIdle = null
      if (resolve) resolve()
    }
    writeLoop()
  }

  // Catch-up (spec §9b): a stalled node fetches what it missed and REPLAYS
  // it deterministically. In a witnessed world each fetched entry is a
  // certified finality record: the proof is verified, the bundle is
  // replayed locally, and the certified result is demanded byte-for-byte
  // (fix brief §3.4 — never adopt raw state).
  async catchUpFrom(addr, targetTick) {
    while (this.state.tick < targetTick) {
      const before = this.state.tick
      const stream = await this.p2p.dialProtocol(addr, this.ticklogProto)
      await stream.sink([Buffer.from(JSON.stringify({ from: this.state.tick, to: targetTick }))])
      const log = JSON.parse((await readAll(stream.source, LIMITS.MAX_REPLAY_RESPONSE_BYTES)).toString())
      if (!log.length) throw new Error('peer log does not reach back to tick ' + this.state.tick + ' — re-sync from checkpoint instead')
      if (this.agreement) {
        for (const rec of log) {
          if (rec.tick !== this.state.tick) continue
          const err = this.agreement.onFinality(rec)
          if (err) throw new Error(`certified replay refused at tick ${rec.tick}: ${err}`)
        }
      } else {
        for (const entry of log) {
          if (entry.tick !== this.state.tick) continue
          const beacon = E.beaconValue(this.genesis.genesisSeed, entry.tick)
          this.state = E.nextState(this.state, entry.inputs, beacon)
          this.tickLog.set(entry.tick, entry.inputs)
          this.myHashes.set(entry.tick + 1, E.stateHash(this.state))
        }
      }
      if (this.state.tick === before) throw new Error('catch-up made no progress at tick ' + before)
    }
    this.log.push(`[${this.name}] caught up to tick ${this.state.tick} by ${this.agreement ? 'certified' : ''} replay`)
  }

  // The shared clock (spec §2). In a witnessed world the schedule only
  // PACES proposals — finalization is quorum evidence (Milestone 4). In
  // legacy mode it finalizes locally (spec §9e, prototype only).
  startTicking() {
    if (this.agreement) { this.agreement.start(); return }
    this._ticking = true
    const loop = async () => {
      if (!this._ticking) return
      const due = this.genesis.anchorMs + (this.state.tick + 1) * E.TICK_MS
      const wait = due - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      if (!this._ticking) return
      await this.advanceTick()
      loop()
    }
    loop()
  }

  stopTicking() { this._ticking = false; this.agreement?.stop() }

  // §6 clean shutdown order: stop the agreement (no more signing), write a
  // final checkpoint, flush and close the finality store, release the process
  // lock, then stop networking.
  // §1 shutdown lifecycle: the witness must NEVER write into its safety
  // directory after it has released exclusivity. Strict order:
  //   1. stop the agreement (no more signing / finalization)
  //   2. mark shutting-down so no NEW checkpoint can be queued
  //   3. queue a final checkpoint if the state moved since the last one
  //   4. DRAIN all checkpoint I/O (in-flight AND pending) to genuine
  //      completion — no timeout, no continue-anyway
  //   5. close SQLite (flush + release the db)
  //   6. release the process lock (exclusivity ends here)
  //   7. stop networking
  // Steps 1-5 all happen while exclusivity is still held; nothing writes the
  // witness directory after step 6. If the final checkpoint cannot be
  // completed, shutdown FAILS CLOSED: it throws with the lock still held,
  // rather than releasing exclusivity behind an incomplete write.
  async stop() {
    if (this._stopped) return
    this._stopped = true
    this._cpFatal = null // clear any fatal from a prior failed shutdown attempt
    this._ticking = false
    this.agreement?.stop()
    this._shuttingDown = true // gate: queueCheckpoint() becomes a no-op past here
    // a final checkpoint at the current tick makes the next restart fast
    if (this.checkpointFile && this.state && this.state.tick !== this._lastCheckpointTick) {
      this._lastCheckpointTick = this.state.tick
      this._queueCheckpointInternal()
    }
    // wait for ALL checkpoint work to genuinely finish (in-flight + pending).
    // No deadline: releasing the lock while a writer can still touch the
    // witness directory is exactly what we must never do.
    await this._drainCheckpoint()
    if (this._cpFatal) {
      // fail closed: do NOT release exclusivity or close storage behind a
      // checkpoint that could not be persisted. The lock stays held (this
      // process still owns the directory); the operator must resolve the
      // disk fault. Consensus records (lock, frontier, finality index) are
      // already durable, so no safety invariant is violated by halting here.
      this._stopped = false        // allow a retry after the fault is fixed
      this._lastCheckpointTick = -1 // so the retry re-queues the final checkpoint
      const msg = this._cpFatal.message
      this._cpFatal = null
      const err = new Error(`[${this.name}] shutdown aborted: final checkpoint could not be written (${msg}); process lock retained. Fix storage and retry stop().`)
      err.code = 'ERR_SHUTDOWN_CHECKPOINT_FAILED'
      throw err
    }
    try { this.agreement?.finalityIndex?.close?.() } catch { /* already closed */ }
    // only now, with all storage quiesced, release exclusivity
    this._processLock?.release()
    this._processLock = null
    await this.p2p.stop()
  }

  // Wait for all checkpoint work (in-flight write AND any pending snapshot)
  // to finish, by awaiting the writer's completion signal — never a timer.
  // If the writer starts again while we wait (a race with a late queue), we
  // loop until it is genuinely idle.
  async _drainCheckpoint() {
    while (this._cpWriting || this._cpPending) {
      if (this._cpIdle) await this._cpIdle
      else await new Promise(r => setImmediate(r)) // writer between iterations; yield and re-check
    }
  }
}
