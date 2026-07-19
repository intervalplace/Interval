// THE BOARD
//
// Coordination that does not belong inside the world. Public chat is for what
// is happening now, where you are standing; this is for what is happening
// later, to someone who is not here. Selling four hundred logs, asking how
// smithing works, arranging to meet.
//
// It has no accounts, because the world already gave everyone an identity. A
// post is signed with the same key that swings an axe, and the node checks
// that signature against the same public key the hiscores rank. Nobody can
// post as someone else, and nobody has to be trusted for that to be true.
//
// Spam is answered by the one thing this world has that cannot be forged in
// bulk: TIME. Posting asks for a standing, and standing is minutes of real
// work per identity, charged at 600ms an action with no way to hurry it. Above
// that line there is a FLAT daily allowance. Flat, not scaled by standing: a
// newcomer with a question needs the board more than a master does, and
// rationing speech by rank is how a forum turns into a hierarchy.
//
// This module is Class C. It knows nothing about the rules of the world and
// the world knows nothing about it: it reads standing, and that is all.
import fs from 'node:fs'
import { webcrypto } from 'node:crypto'

export const BOARD_DEFAULTS = {
  file: 'board/posts.json',
  moderators: [],       // citizen keys allowed to remove and silence
  minStanding: 50,      // roughly a quarter hour of actually being here
  perDay: 10,
  max: 5000,            // the file is bounded; the oldest fall off the end
  page: 200,
  subjectMax: 80,
  bodyMax: 2000,
  skewMs: 600000,       // ten minutes either side of now
}
const DAY_MS = 86400000

// The exact bytes a citizen signs. The browser builds this same string; if the
// two ever disagree, every post fails to verify loudly rather than something
// subtler going wrong quietly.
export const boardSigned = (p) =>
  JSON.stringify({ body: p.body, key: p.key, subject: p.subject, ts: p.ts })

// Moderation is signed the same way an ordinary post is. There is no password
// and no admin session: a moderator is a citizen key named in the config, and
// their instruction carries their signature exactly as their words would. So
// the board has no secret to leak, and every removal has an author.
export const modSigned = (m) =>
  JSON.stringify({ act: m.act, key: m.key, target: m.target, ts: m.ts, why: m.why ?? '' })

export async function verifySigned(bytes, keyHex, sigHex) {
  try {
    const raw = Buffer.from(String(keyHex), 'hex')
    if (raw.length !== 32) return false
    const pub = await webcrypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
    return await webcrypto.subtle.verify({ name: 'Ed25519' }, pub,
      Buffer.from(String(sigHex), 'hex'), Buffer.from(bytes, 'utf8'))
  } catch { return false }
}

export const verifyPost = (post) => verifySigned(boardSigned(post), post.key, post.sig)

// A post's name is the hash of its own signature: unique, deterministic, and
// derived from something nobody but its author could have produced.
async function postId(sig) {
  const h = await webcrypto.subtle.digest('SHA-256', Buffer.from(String(sig), 'hex'))
  return Buffer.from(h).toString('hex').slice(0, 16)
}

export function makeBoard(opts = {}) {
  const C = { ...BOARD_DEFAULTS, ...opts }
  // how the board learns who someone is. Injected, so this module never
  // reaches into the world's state itself.
  const lookup = opts.lookup ?? (() => null)
  const now = opts.now ?? (() => Date.now())

  const load = () => {
    try {
      const j = JSON.parse(fs.readFileSync(C.file))
      return {
        posts: Array.isArray(j.posts) ? j.posts : [],
        silenced: j.silenced && typeof j.silenced === 'object' ? j.silenced : {},
        removals: Array.isArray(j.removals) ? j.removals : [],
      }
    } catch { return { posts: [], silenced: {}, removals: [] } }
  }
  const save = (d) => {
    fs.mkdirSync(C.file.replace(/\/[^/]*$/, '') || '.', { recursive: true })
    const tmp = C.file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify({
      posts: d.posts.slice(-C.max),
      silenced: d.silenced,
      // the removal log is kept, and kept longer than the posts: a board whose
      // moderator can quietly unmake things is worse than one with no moderator
      removals: d.removals.slice(-C.max),
    }))
    fs.renameSync(tmp, C.file)   // atomic: a crash never leaves half a board
  }
  const read = () => load().posts
  const isMod = (k) => C.moderators.includes(String(k))

  async function accept(post) {
    for (const k of ['key', 'subject', 'body', 'ts', 'sig']) {
      if (typeof post?.[k] === 'undefined') return { code: 400, why: 'a post needs ' + k }
    }
    if (!/^[0-9a-f]{64}$/.test(String(post.key))) return { code: 400, why: 'that is not a citizen key' }
    if (!/^[0-9a-f]{128}$/.test(String(post.sig))) return { code: 400, why: 'that is not a signature' }
    const subject = String(post.subject).trim(), body = String(post.body).trim()
    if (!subject) return { code: 400, why: 'say what it is about' }
    if (subject.length > C.subjectMax) return { code: 400, why: 'the subject is too long' }
    if (!body) return { code: 400, why: 'the post is empty' }
    if (body.length > C.bodyMax) return { code: 400, why: 'the post is too long (' + C.bodyMax + ' characters)' }

    // an old timestamp is a replay; a future one is a clock that cannot be
    // trusted to order anything
    const ts = Number(post.ts)
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > C.skewMs)
      return { code: 400, why: 'that post is not from now (check your clock)' }

    // the signature is checked over the TRIMMED text, which is what gets
    // stored: otherwise a post could be signed as one thing and kept as another
    if (!(await verifyPost({ ...post, subject, body })))
      return { code: 403, why: 'that signature does not belong to that key' }

    const d = load()
    const sil = d.silenced[String(post.key)]
    if (sil && (!sil.until || sil.until > now())) {
      return { code: 403, why: 'this key is silenced on the board' + (sil.why ? ': ' + sil.why : '') }
    }

    const who = lookup(String(post.key))
    if (!who) return { code: 403, why: 'no such citizen in this world. Enter it first, then post.' }
    if (who.standing < C.minStanding) {
      return { code: 403, why: 'the board asks for a standing of ' + C.minStanding
        + '. Yours is ' + who.standing + '. Spend a little time in the world and come back.' }
    }
    // removals count against the day's allowance too: deleting a post must not
    // hand its author a fresh one to replace it with
    const spent = d.posts.filter(p => p.key === post.key && now() - p.ts < DAY_MS).length
      + d.removals.filter(r => r.author === post.key && now() - r.ts < DAY_MS).length
    if (spent >= C.perDay) {
      return { code: 429, why: 'that is ' + C.perDay + ' posts today. The board keeps its own pace.' }
    }
    d.posts.push({ id: await postId(post.sig), key: String(post.key), subject, body, ts,
                   name: who.name ?? null, standing: who.standing, calling: who.calling ?? null })
    save(d)
    return { ok: true }
  }

  // ---- moderation ----
  // Signed like any other post, by a key named in the config. No password, no
  // session, nothing to leak. Every removal is recorded with its author, and
  // the record outlives the thing removed.
  async function moderate(m) {
    for (const k of ['key', 'act', 'target', 'ts', 'sig']) {
      if (typeof m?.[k] === 'undefined') return { code: 400, why: 'that instruction needs ' + k }
    }
    if (!/^[0-9a-f]{64}$/.test(String(m.key))) return { code: 400, why: 'that is not a citizen key' }
    if (!/^[0-9a-f]{128}$/.test(String(m.sig))) return { code: 400, why: 'that is not a signature' }
    const ts = Number(m.ts)
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > C.skewMs)
      return { code: 400, why: 'that instruction is not from now' }
    if (!isMod(m.key)) return { code: 403, why: 'that key does not keep this board' }
    if (!(await verifySigned(modSigned(m), m.key, m.sig)))
      return { code: 403, why: 'that signature does not belong to that key' }

    const d = load()
    const why = String(m.why ?? '').slice(0, 200)
    if (m.act === 'remove') {
      const i = d.posts.findIndex(p => p.id === String(m.target))
      if (i === -1) return { code: 404, why: 'no such post' }
      const [gone] = d.posts.splice(i, 1)
      d.removals.push({ id: gone.id, author: gone.key, subject: gone.subject,
                        by: String(m.key), ts: now(), why })
      save(d)
      return { ok: true, removed: gone.id }
    }
    if (m.act === 'silence' || m.act === 'unsilence') {
      const target = String(m.target)
      if (!/^[0-9a-f]{64}$/.test(target)) return { code: 400, why: 'silence names a citizen key' }
      if (m.act === 'unsilence') delete d.silenced[target]
      else d.silenced[target] = { by: String(m.key), ts: now(), why,
                                  until: Number(m.until) || null }
      save(d)
      return { ok: true }
    }
    return { code: 400, why: 'no such instruction' }
  }

  return {
    config: C,
    read,
    silenced: () => load().silenced,
    removals: () => load().removals,
    latest: () => read().slice(-C.page).reverse(),
    isMod,
    accept,
    moderate,
  }
}
