#!/usr/bin/env node
// Auto-discovering test runner (Phase-1 final freeze §1). The official test
// command must execute EVERY non-adversarial suite — a manually maintained
// file list silently drops new suites (as it did for lifecycle and
// startupverify). This runner discovers all `test/*.test.mjs` files at run
// time, so adding a test file cannot bypass CI.
//
// Usage:
//   node run-tests.mjs            # all non-adversarial suites (the unit set)
//   node run-tests.mjs --all      # every suite including adversarial
//   node run-tests.mjs --only adversarial   # just the adversarial battery
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.join(root, 'test')
const all = fs.readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort()

const args = process.argv.slice(2)
let files
if (args.includes('--all')) {
  files = all
} else if (args.includes('--only')) {
  const name = args[args.indexOf('--only') + 1]
  files = all.filter(f => f.includes(name))
} else {
  // default: the unit set = everything except the adversarial battery
  files = all.filter(f => f !== 'adversarial.test.mjs')
}

if (files.length === 0) { console.error('no test files matched'); process.exit(1) }

const r = spawnSync(process.execPath, ['--test', ...files.map(f => path.join('test', f))], {
  cwd: root, stdio: 'inherit',
})
process.exit(r.status ?? 1)
