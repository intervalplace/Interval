#!/usr/bin/env node
// Release manifest (Phase-1 freeze §3). Derives the release facts and test
// counts DIRECTLY FROM THE SOURCE TREE so documentation and the freeze
// evidence cannot silently drift from reality. Counts are computed by static
// analysis (counting `test(...)` declarations per file) rather than by running
// the suite, so this is fast and deterministic. `--check` compares the
// published docs against the manifest and exits non-zero on any mismatch.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

// --- versions (single source of truth: package.json) ---
const pkg = JSON.parse(read('package.json'))
const versions = {
  release: pkg.version,
  releaseName: pkg.release,
  specVersion: pkg.protocol.specVersion,
  consensusVersion: pkg.protocol.consensusVersion,
  rulesHashPrefix: pkg.protocol.rulesHash,
  nodeEngine: pkg.engines.node,
}

// --- test counts (static: count top-level test() calls per file) ---
// A test is a line beginning (after whitespace) with `test('` or `test("`.
function countTests(file) {
  const src = fs.readFileSync(file, 'utf8')
  let n = 0
  for (const line of src.split('\n')) if (/^\s*test\(\s*['"`]/.test(line)) n++
  return n
}
// The adversarial file drives one test() from inside a `for (… of runs)` loop,
// so a static test() count undercounts it. Count the `runs` array entries plus
// the standalone test() calls to match the runtime total.
function countAdversarial(file) {
  const src = fs.readFileSync(file, 'utf8')
  const standalone = countTests(file) // includes the 1 inside the loop
  const start = src.indexOf('const runs = [')
  let runsEntries = 0
  if (start >= 0) {
    const end = src.indexOf('\n]', start)
    const block = src.slice(start, end)
    runsEntries = (block.match(/^\s*\[\s*['"`]/gm) || []).length
  }
  // the loop's single test() call is counted once in `standalone`; it actually
  // expands to runsEntries tests, so add (runsEntries - 1)
  return standalone + Math.max(0, runsEntries - 1)
}
const testDir = path.join(root, 'test')
const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort()
const perFile = {}
let unit = 0, adversarial = 0
for (const f of testFiles) {
  const isAdv = f === 'adversarial.test.mjs'
  const n = isAdv ? countAdversarial(path.join(testDir, f)) : countTests(path.join(testDir, f))
  perFile[f] = n
  if (isAdv) adversarial += n
  else unit += n
}

// --- scenario count (authoritative: the SCENARIOS registry) ---
// static parse to avoid importing libp2p transitively
const advsimSrc = read('advsim.mjs')
const scenBlock = advsimSrc.slice(advsimSrc.indexOf('export const SCENARIOS = {'))
const scenBody = scenBlock.slice(0, scenBlock.indexOf('\n}\n') + 1)
const scenarioNames = [...scenBody.matchAll(/^\s{2}'?([a-zA-Z][a-zA-Z0-9-]*)'?\s*:\s*\{/gm)].map(m => m[1])

// --- benchmark count ---
const benchmarks = fs.readdirSync(root).filter(f => /^bench.*\.mjs$/.test(f)).sort()

const manifest = {
  ...versions,
  tests: { unit, adversarial, total: unit + adversarial, files: perFile },
  scenarios: { count: scenarioNames.length, names: scenarioNames },
  benchmarks: { count: benchmarks.length, files: benchmarks },
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(manifest, null, 2))
  process.exit(0)
}

// default: human-readable
if (!process.argv.includes('--check')) {
  console.log(`release          ${manifest.release} (${manifest.releaseName})`)
  console.log(`spec / consensus ${manifest.specVersion} / ${manifest.consensusVersion}`)
  console.log(`rules hash       ${manifest.rulesHashPrefix}…`)
  console.log(`node engine      ${manifest.nodeEngine}`)
  console.log(`unit tests       ${manifest.tests.unit}`)
  console.log(`adversarial      ${manifest.tests.adversarial}`)
  console.log(`total tests      ${manifest.tests.total}`)
  console.log(`scenarios        ${manifest.scenarios.count} (${manifest.scenarios.names.join(', ')})`)
  console.log(`benchmarks       ${manifest.benchmarks.count} (${manifest.benchmarks.files.join(', ')})`)
  process.exit(0)
}

// --check: verify docs match the manifest
const problems = []
const expect = (file, needle, label) => {
  let src
  try { src = read(file) } catch { problems.push(`${file}: missing`); return }
  if (!src.includes(needle)) problems.push(`${file}: expected ${label} (“${needle}”) not found`)
}
// version banners
for (const f of ['README.md', 'CONSENSUS.md']) expect(f, `Release ${manifest.release}`, 'release banner')
expect('README.md', `spec v${manifest.specVersion}`, 'spec version')
expect('CONSENSUS.md', `Consensus Specification v${manifest.consensusVersion}`, 'consensus version')
// the separate "Implementation release" line (this drifted: it said 0.22.7
// while the banner said 0.23.0 — banner-only checks missed it)
expect('CONSENSUS.md', `version \`${manifest.release}\``, 'CONSENSUS implementation-release line')
expect('SPEC.md', `Specification v${manifest.specVersion}`, 'spec version')
// TESTING.md header banner (previously drifted unchecked)
expect('TESTING.md', `Release ${manifest.release}`, 'TESTING release banner')
expect('TESTING.md', `consensus spec v${manifest.consensusVersion}`, 'TESTING consensus banner')
// test counts in TESTING.md
expect('TESTING.md', `${manifest.tests.total} tests`, 'total test count')
expect('TESTING.md', `${manifest.tests.adversarial} tests`, 'adversarial CI count')
// every scenario name appears in TESTING.md
for (const name of manifest.scenarios.names) {
  if (!read('TESTING.md').includes(name)) problems.push(`TESTING.md: scenario “${name}” not documented`)
}
// node runtime
expect('TESTING.md', manifest.nodeEngine, 'node engine requirement')
// README adversarial + scenario counts (these drifted: 14→15 tests, 10→11 scenarios)
expect('README.md', `${manifest.tests.adversarial} tests`, 'README adversarial CI count')
expect('README.md', `${manifest.scenarios.count} scenarios`, 'README scenario count')
// §4 scenario-config consistency: the "N scenarios × S seed × Ds" phrasing in
// README and SUMMARY must match the seed/duration the evidence script uses, so
// there are no manually edited values that can drift from the actual run.
{
  const script = read('freeze-evidence.sh')
  const seeds = (script.match(/SCEN_SEEDS=(\d+)/) || [])[1]
  const ms = (script.match(/SCEN_MS=(\d+)/) || [])[1]
  if (seeds && ms) {
    const secs = Math.round(Number(ms) / 1000)
    const phrase = `${manifest.scenarios.count} scenarios × ${seeds} seed × ${secs}s`
    for (const doc of ['README.md', path.join('freeze-evidence', 'SUMMARY.md')]) {
      const full = path.join(root, doc)
      if (fs.existsSync(full) && !fs.readFileSync(full, 'utf8').includes(phrase)) {
        problems.push(`${doc}: scenario sample phrasing should be "${phrase}" (matching freeze-evidence.sh)`)
      }
    }
  }
}
// evidence summary, when present, must cite the current release + counts.
// Skipped with --no-evidence (used while the evidence script is mid-build,
// when SUMMARY.md exists only as a partial header).
if (!process.argv.includes('--no-evidence')) {
  const p = path.join(root, 'freeze-evidence', 'SUMMARY.md')
  if (fs.existsSync(p)) {
    const sum = fs.readFileSync(p, 'utf8')
    if (!sum.includes(manifest.release)) problems.push('freeze-evidence/SUMMARY.md: stale release version')
    // match an explicit "= N ·" or "N tests" phrasing, not a bare digit run
    // (which could coincidentally appear inside a hash)
    const totalRe = new RegExp(`(=\\s*${manifest.tests.total}\\b|\\b${manifest.tests.total}\\s*tests|${manifest.tests.total}\\s*·|total tests\\s+${manifest.tests.total}\\b)`)
    if (!totalRe.test(sum)) problems.push('freeze-evidence/SUMMARY.md: stale total test count')
  }
}

// automatic stale-version sweep: no doc may reference a release/consensus/spec
// version OTHER than the current one (outside historical changelog sections).
// This is the backstop that catches drift the targeted checks above don't name
// explicitly — e.g. the CONSENSUS "Implementation release" line that slipped.
{
  // known prior versions that must not appear as current references
  const staleReleases = ['0.22.7', '0.22.6', '0.22.5', '0.21.0', '0.20.0']
  const staleConsensus = ['v1.8', 'v1.7', 'v1.6']
  for (const doc of ['README.md', 'CONSENSUS.md', 'TESTING.md']) {
    let src
    try { src = read(doc) } catch { continue }
    const lines = src.split('\n')
    let inChangelog = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // README's "## New in vX" sections are historical; skip them
      if (/^##\s+New in v/.test(line)) { inChangelog = true; continue }
      if (/^##\s/.test(line) && !/New in v/.test(line)) inChangelog = false
      if (inChangelog) continue
      for (const s of staleReleases) if (line.includes(`\`${s}\``) || line.includes(`Release ${s}`) || line.includes(`version ${s}`)) problems.push(`${doc}:${i + 1}: stale release version ${s}`)
      for (const s of staleConsensus) if (line.includes(`consensus spec ${s}`) || line.includes(`Specification ${s}`) || line.includes(`consensus ${s}`)) problems.push(`${doc}:${i + 1}: stale consensus version ${s}`)
    }
  }
}

if (problems.length) {
  console.error('manifest --check FAILED:')
  for (const p of problems) console.error('  • ' + p)
  process.exit(1)
}
console.log('manifest --check: docs match the source tree')
