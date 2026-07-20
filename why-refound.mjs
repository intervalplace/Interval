// why-refound.mjs — run this in the node's directory to learn why the world
// started over. It reads the saved founding record and checkpoint and reports
// each resume condition separately, because "tick 0 again" has several causes
// and they have very different consequences.
//
//   node why-refound.mjs
import fs from 'node:fs'
import crypto from 'node:crypto'
import E from './engine.js'

const WORLD_FILE = 'checkpoints/world.json'
const CP_FILE = 'checkpoints/web.json'
// these must track serve.mjs; a diagnostic reporting different limits from the
// node it is diagnosing is worse than none (this tool has made that mistake)
const REFOUND_GAP = Math.max(1, Number(process.env.INTERVAL_REFOUND_GAP) || 144000)
const CP_INTERVAL = Number(process.env.INTERVAL_CHECKPOINT_INTERVAL) || 200

// These must match serve.mjs EXACTLY. They did not, on the first version of
// this tool, and it accused a perfectly healthy world of two failures it did
// not have: it truncated the hash serve.mjs keeps whole, and invented a seed.
// A diagnostic that guesses at the thing it is checking is worse than none.
const RULES_HASH = E.sha256(fs.readFileSync(new URL('./SPEC.md', import.meta.url))).toString('hex')
const SEED = 'solo-' + (process.env.INTERVAL_SEED || 'world')

const saved = fs.existsSync(WORLD_FILE) ? JSON.parse(fs.readFileSync(WORLD_FILE)) : null
// "missing" and "corrupt" are very different diagnoses and the first version of
// this tool reported both as "no checkpoint saved yet", which sent the reader
// looking for a deleted file that was never deleted.
let cp = null, cpState = 'missing', cpErr = null
if (fs.existsSync(CP_FILE)) {
  const sz = fs.statSync(CP_FILE).size
  try { cp = JSON.parse(fs.readFileSync(CP_FILE)); cpState = 'ok' }
  catch (e) { cpState = sz === 0 ? 'empty' : 'corrupt'; cpErr = e.message }
}
const strays = fs.existsSync('checkpoints')
  ? fs.readdirSync('checkpoints').filter(n => n.includes('.tmp-')) : []

if (!saved) {
  console.log('No founding record at ' + WORLD_FILE + '.')
  console.log('This node has never founded a world, so tick 0 is simply the beginning.')
  process.exit(0)
}

const ok = (b) => b ? '  ok  ' : ' FAIL '
const g = saved.genesis
const cpTick = Number.isInteger(cp?.tick) ? cp.tick : 0
const gap = Math.floor((Date.now() - g.anchorMs) / E.TICK_MS) - cpTick

// The founding record is REWRITTEN when a world refounds, so by the time
// anyone runs this, the evidence of the old world may already be gone. Say so
// rather than reporting confidently on a record that describes the new world.
const alreadyCurrent = g.rulesHash === RULES_HASH && g.genesisSeed === SEED
console.log('saved world   : ' + (saved.worldId ?? E.worldId(g)).slice(0, 16) + '\u2026')
console.log('founded       : ' + new Date(g.anchorMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  + '  (' + ((Date.now() - g.anchorMs) / 60000).toFixed(0) + ' minutes ago)')
if (alreadyCurrent && (Date.now() - g.anchorMs) < 3600000) {
  console.log()
  console.log('NOTE: this founding record already matches the current build and was')
  console.log('written recently, which means it is almost certainly the NEW world,')
  console.log('written when the old one was replaced. The record that would explain')
  console.log('the refound is gone: refounding overwrites it. What follows therefore')
  console.log('describes the world you have now, not the one you lost.')
}
console.log('last checkpoint at tick ' + cpTick.toLocaleString()
  + '  (' + (cpTick * E.TICK_MS / 3600000).toFixed(1) + ' hours of world time)')
console.log()
console.log('the resume conditions, one at a time:')
console.log()

const rules = g.rulesHash === RULES_HASH
console.log(ok(rules) + 'rules unchanged')
if (!rules) {
  console.log('        the saved world was founded under rulesHash ' + g.rulesHash)
  console.log('        this build\u2019s SPEC.md hashes to      ' + RULES_HASH)
  console.log('        A different constitution is a DIFFERENT WORLD by design')
  console.log('        (SPEC.md is hashed into the worldId). The old world is not')
  console.log('        lost: it is simply not this one. Run the matching release')
  console.log('        to continue it.')
}

const seedOk = g.genesisSeed === SEED
console.log(ok(seedOk) + 'seed unchanged' + (seedOk ? '' : '   saved=' + g.genesisSeed + ' now=' + SEED))

const wit = Array.isArray(g.witnesses)
console.log(ok(wit) + 'founding record names witnesses')

let keyOk = false
try {
  const W = JSON.parse(fs.readFileSync('identities/witness-pillar.json'))
  keyOk = wit && g.witnesses.includes(W.playerId)
  console.log(ok(keyOk) + 'this node\u2019s witness key is a founding witness')
  if (!keyOk && wit) {
    console.log('        this witness: ' + String(W.playerId).slice(0, 16) + '\u2026')
    console.log('        founding set: ' + g.witnesses.map(w => w.slice(0, 12) + '\u2026').join(', '))
    console.log('        A world cannot be continued by a witness it never named.')
    console.log('        If identities/witness-pillar.json was lost or regenerated,')
    console.log('        the old world can no longer be advanced by this node.')
  }
} catch { console.log(' FAIL  witness identity file missing (identities/witness-pillar.json)') }

let cpOk = true
if (cp) {
  const idMatch = cp.worldId === E.worldId(g)
  const genMatch = E.canonical(cp.state?.genesis) === E.canonical(g)
  let hashMatch = false
  try { hashMatch = E.stateHash(cp.state) === cp.stateHash } catch {}
  cpOk = idMatch && genMatch && hashMatch
  console.log(ok(cpOk) + 'checkpoint belongs to this world and is intact')
  if (!cpOk) console.log('        worldId ' + (idMatch ? 'ok' : 'MISMATCH')
    + ', genesis ' + (genMatch ? 'ok' : 'MISMATCH') + ', stateHash ' + (hashMatch ? 'ok' : 'MISMATCH'))
} else if (cpState === 'missing') {
  console.log('  --   no checkpoint file at ' + CP_FILE)
  console.log('        If this world is young this is normal: one is written every')
  console.log('        1000 ticks (about 10 minutes) and on a clean shutdown. If the')
  console.log('        world is older than that, the file was lost.')
} else {
  console.log(' FAIL  the checkpoint file is ' + cpState + (cpErr ? ': ' + cpErr : ''))
  console.log('        The file exists but cannot be read, so the node treated it as')
  console.log('        absent and measured the gap from tick 0. Preserve a copy before')
  console.log('        restarting: it is the only record of where the world had got to.')
}
if (strays.length) {
  console.log()
  console.log('  NOTE: ' + strays.length + ' unfinished checkpoint file(s) in checkpoints/:')
  for (const n of strays.slice(0, 4)) console.log('        ' + n)
  console.log('        These are written-but-not-renamed temporaries. Their presence')
  console.log('        means a write was interrupted, which dates the crash.')
}

const gapOk = gap <= REFOUND_GAP
console.log(ok(gapOk) + 'the node was not down too long')
if (!gapOk) {
  console.log('        the world clock has run ' + gap.toLocaleString() + ' ticks past the last')
  console.log('        checkpoint (' + (gap * E.TICK_MS / 60000).toFixed(0) + ' minutes). The limit is '
    + REFOUND_GAP.toLocaleString() + ' ticks (~30 min).')
  console.log('        THIS IS THE CAUSE MOST WORTH KNOWING ABOUT: it means the world')
  console.log('        refounded not because anything changed, but because nobody was')
  console.log('        running it. An outage longer than half an hour ends the world\u2019s')
  console.log('        continuity even when every rule is identical.')
}

console.log()
console.log('how much downtime this world can survive:')
{
  const worst = REFOUND_GAP - CP_INTERVAL
  console.log('  checkpoints are written every ' + CP_INTERVAL.toLocaleString() + ' ticks ('
    + (CP_INTERVAL * E.TICK_MS / 60000).toFixed(0) + ' min), and on a clean shutdown.')
  const dur = (t) => { const m = t * E.TICK_MS / 60000
    return m >= 120 ? (m / 60).toFixed(1) + ' hours' : m.toFixed(0) + ' min' }
  console.log('  after a CLEAN stop, ' + dur(REFOUND_GAP) + ' of downtime.')
  console.log('  after a CRASH the newest checkpoint is up to ' + dur(CP_INTERVAL) + ' stale,')
  console.log('    so ' + dur(worst) + ' before it refounds.')
  console.log('  replaying that much would take about ' + dur(Math.round(worst * 68 / E.TICK_MS))
    + ', checkpointed as it goes.')
}

console.log()
const all = rules && seedOk && wit && keyOk && cpOk && gapOk
if (!all) {
  console.log('The world refounded. Citizens are imported into the new genesis, so nobody')
  console.log('lost their skills, but the tick count and the worldId start again.')
} else if (cpState === 'corrupt' || cpState === 'empty') {
  // a damaged checkpoint does not fail canResume directly: the node treats it
  // as absent, measures the gap from tick 0, and THAT is what refounds an
  // established world. Saying "all conditions hold" here would be a lie by
  // omission on the one finding that matters.
  console.log('Every named condition holds, but the checkpoint is ' + cpState + '. The node')
  console.log('treats an unreadable checkpoint as no checkpoint, measures the gap from')
  console.log('tick 0, and refounds any world older than ' + REFOUND_GAP.toLocaleString() + ' ticks. Repair or')
  console.log('remove the file deliberately rather than leaving it to be rediscovered.')
} else {
  console.log('All conditions hold: this node should have resumed. If it did not, the')
  console.log('failure is elsewhere and worth reporting.')
}
