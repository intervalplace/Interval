// found-witnesses.mjs — prepare the witness set for a world, BEFORE founding it.
//
//   node found-witnesses.mjs 3
//
// Writes one identity file per witness into ./witness-keys/ and prints the
// exact environment each machine needs. Run this ONCE, on a machine you trust,
// then distribute one private key to each node and keep every key backed up
// somewhere that is not those machines.
//
// WHY THIS IS A ONE-WAY DOOR
//
// The witness set is written into genesis and hashed into the worldId. It can
// never be added to, rotated, or repaired. A world founded with one witness
// whose key is later lost is a world that has stopped forever, with no appeal
// and no fix, and every citizen's work inside it frozen at the last tick that
// was signed. This is not a recoverable mistake, so it is worth ten minutes
// now.
//
// HOW MANY
//
//   1  the world stops when that one machine stops. Fine for a test, and only
//      for a test.
//   2  WORSE THAN ONE. The quorum becomes 2, so both must be online: you have
//      doubled the ways to halt and gained nothing.
//   3  the first honest choice. Quorum 2, so any single machine can die, be
//      rebooted, run out of disk or fall off the network and the world keeps
//      its clock. Tolerates no LIAR, which is fine when all three are yours.
//   4  the first that survives a witness that lies rather than merely stops.
//      This is the number if anyone else is to hold a key, because then the
//      threat is no longer only crashes.
//
import fs from 'node:fs'
import path from 'node:path'
import E from './engine.js'

const n = Math.max(1, Math.min(15, Number(process.argv[2]) || 3))
const dir = 'witness-keys'

const f = E.maxByzantine(n)
const q = E.minQuorumFor(n, f)

if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
  console.error(`${dir}/ already has files in it. Refusing to overwrite witness keys.`)
  console.error('Move it aside first if you really mean to mint a new set.')
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })

const made = []
for (let i = 0; i < n; i++) {
  const id = E.generateIdentity()
  const file = path.join(dir, `witness-${i + 1}.json`)
  fs.writeFileSync(file, JSON.stringify(E.exportIdentity(id), null, 2) + '\n', { mode: 0o600 })
  made.push({ i: i + 1, file, pub: id.playerId })
}

const line = '-'.repeat(72)
console.log(line)
console.log(`${n} witness ${n === 1 ? 'key' : 'keys'}, quorum ${q}`)
console.log(line)
console.log()
console.log(`  the world advances while any ${q} of the ${n} are running`)
console.log(`  it survives ${n - q} witness${n - q === 1 ? '' : 'es'} being offline at once`)
console.log(`  it tolerates ${f} witness${f === 1 ? '' : 'es'} that actively lie`)
if (n === 2) {
  console.log()
  console.log('  WARNING: two witnesses is worse than one. The quorum is 2, so BOTH')
  console.log('  must be running. You have doubled the ways this world can halt.')
  console.log('  Use 1 for a test, or 3 for a world meant to last.')
}
if (n >= 3 && f === 0) {
  console.log()
  console.log('  Note: this tolerates crashes, not liars. Safe while every witness')
  console.log('  is yours. If someone else is to hold a key, use 4.')
}
console.log()
console.log(line)
console.log('ON EACH MACHINE')
console.log(line)
for (const m of made) {
  const others = made.filter(o => o.i !== m.i).map(o => o.pub)
  console.log()
  console.log(`  machine ${m.i}`)
  console.log(`    cp ${m.file} <node-dir>/identities/witness-pillar.json`)
  console.log(`    export INTERVAL_WITNESSES=${others.join(',')}`)
  console.log(`    node serve.mjs`)
}
console.log()
console.log(line)
console.log('BEFORE YOU FOUND')
console.log(line)
console.log()
console.log('  1. Back up all of witness-keys/ somewhere that is NOT these machines.')
console.log('     A lost key cannot be replaced: the set is sealed at founding.')
console.log('  2. Start every witness before the first tick. A witness missing at')
console.log('     founding is not a founding witness, and can never become one.')
console.log('  3. Check the log says the number you expect:')
console.log(`       witnessed world <id> - ${n} witness(es), quorum ${q}`)
console.log('  4. Then delete nothing. Not the keys, not the checkpoints.')
console.log()
