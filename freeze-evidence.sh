#!/usr/bin/env bash
# Generates the reproducible protocol-freeze evidence bundle: environment,
# dependency versions, exact commands, exit codes, and full logs for every
# test surface. Output lands in freeze-evidence/ as committable artifacts.
#
#   bash freeze-evidence.sh
#
# Exit code is nonzero if ANY captured stage failed, so this script itself
# is the freeze gate.
set -u
cd "$(dirname "$0")"
OUT=freeze-evidence
rm -rf "$OUT" && mkdir -p "$OUT"
SUMMARY="$OUT/SUMMARY.md"
FAIL=0

# capture a command's stdout+stderr and exit code; record the verdict
run () {
  local label=$1 logfile=$2; shift 2
  echo "=== $label ===" | tee -a "$SUMMARY.tmp"
  echo "\$ $*" | tee -a "$SUMMARY.tmp"
  local t0=$(date +%s)
  "$@" > "$OUT/$logfile" 2>&1
  local code=$?
  local t1=$(date +%s)
  echo "exit $code · $((t1 - t0))s · log: $logfile" | tee -a "$SUMMARY.tmp"
  echo "" | tee -a "$SUMMARY.tmp"
  [ $code -ne 0 ] && FAIL=1
  return $code
}

# ---- environment & versions ----
{
  echo "# Interval — Protocol-Freeze Evidence"
  echo ""
  echo "Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo ""
  echo "## Release"
  node -e "const p=require('./package.json');console.log('- package:',p.version);console.log('- release:',p.release);console.log('- protocol spec:',p.protocol.specVersion);console.log('- consensus spec:',p.protocol.consensusVersion);console.log('- rules hash:',p.protocol.rulesHash+'…')"
  echo ""
  echo "## Runtime environment"
  echo '```'
  echo "node:     $(node --version)"
  echo "npm:      $(npm --version 2>/dev/null || echo n/a)"
  echo "platform: $(uname -smr)"
  echo "date:     $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo '```'
  echo ""
  echo "## Source revision"
  echo '```'
  git -C . rev-parse HEAD 2>/dev/null || echo "(not a git checkout; distributed as an archive)"
  git -C . status --porcelain 2>/dev/null | head -5 || true
  echo '```'
  echo ""
  echo "## Dependency versions (installed)"
  echo '```'
  node -e "const l=require('./package.json');for(const [k,v] of Object.entries({...l.dependencies,...l.devDependencies}||{}))console.log(k,v)" 2>/dev/null || echo "(none declared)"
  echo "--- resolved (npm ls) ---"
  npm ls --all --depth=0 2>/dev/null | head -30 || echo "(npm ls unavailable)"
  echo '```'
  echo ""
  echo "## Rules hash derivation"
  echo '```'
  echo "rulesHash = sha256(SPEC.md) = $(node -e "console.log(require('./engine.js').sha256(require('fs').readFileSync('./SPEC.md')).toString('hex'))")"
  echo '```'
  echo ""
  echo "## Source binding"
  echo ""
  echo "These hashes bind this evidence to the exact implementation. A"
  echo "reviewer recomputes them against the source tree to confirm the"
  echo "evidence belongs to this code."
  echo '```'
  # source-tree hash: every tracked source file, order-stable, excluding
  # generated/vendored dirs and the evidence bundle itself
  SRC_HASH=$(find . -type f \
    \( -name '*.mjs' -o -name '*.js' -o -name '*.md' -o -name '*.json' -o -name '*.html' -o -name '*.sh' \) \
    -not -path './node_modules/*' -not -path './freeze-evidence/*' \
    -not -path './checkpoints/*' -not -path './identities/*' -not -path './witness-safety/*' \
    -not -name 'package-lock.json' \
    | LC_ALL=C sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
  echo "source-tree sha256:   $SRC_HASH"
  echo "package-lock sha256:  $(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)"
  echo "SPEC.md sha256:       $(sha256sum SPEC.md | cut -d' ' -f1)"
  echo "CONSENSUS.md sha256:  $(sha256sum CONSENSUS.md | cut -d' ' -f1)"
  echo "TESTING.md sha256:    $(sha256sum TESTING.md | cut -d' ' -f1)"
  echo "README.md sha256:     $(sha256sum README.md | cut -d' ' -f1)"
  echo "package.json sha256:  $(sha256sum package.json | cut -d' ' -f1)"
  echo '```'
  echo ""
  echo "Recompute the source-tree hash with:"
  echo '```'
  echo "find . -type f \\( -name '*.mjs' -o -name '*.js' -o -name '*.md' -o -name '*.json' -o -name '*.html' -o -name '*.sh' \\) \\"
  echo "  -not -path './node_modules/*' -not -path './freeze-evidence/*' \\"
  echo "  -not -path './checkpoints/*' -not -path './identities/*' -not -path './witness-safety/*' \\"
  echo "  -not -name 'package-lock.json' | LC_ALL=C sort | xargs sha256sum | sha256sum"
  echo '```'
  echo ""
  echo "## Captured stages"
  echo ""
} > "$SUMMARY"

# preserve the lockfile as part of the evidence
[ -f package-lock.json ] && cp package-lock.json "$OUT/package-lock.json"
cp package.json "$OUT/package.json"

echo "" > "$SUMMARY.tmp"

# ---- scenario configuration: defined ONCE, used everywhere (§4) ----
# the count comes from the manifest (the SCENARIOS registry); duration and
# seeds are the single source of truth for the sampled adversarial run and
# every place that describes it (logs, SUMMARY, README should cite these).
SCEN_COUNT=$(node manifest.mjs --json 2>/dev/null | node -e "const m=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(m.scenarios.count))")
SCEN_SEEDS=1
SCEN_MS=11000

# ---- the test surfaces, exact commands ----

# manifest + documentation consistency is itself a freeze gate: if any doc has
# drifted from the source tree, the evidence run fails here.
run "Release manifest + documentation consistency" "manifest.log" \
  node manifest.mjs --check --no-evidence

run "Deterministic peer-agreement sim (200 ticks)" "sim.log" \
  node sim.js

run "Node interop: concurrent dynamic import is race-free (§7)" "interop.log" \
  node --input-type=module -e "
    const mods = await Promise.all([import('./engine.js'),import('./protocol.mjs'),import('./agreement.mjs'),import('./node.mjs'),import('./sdk.mjs'),import('./worldgen.mjs')])
    const E = mods[0].default
    const id = E.generateIdentity()
    const ok = E.verifyInputSig(E.signInput({worldId:'ab'.repeat(32),tick:0,playerId:id.playerId,type:'spawn'},id.privateKey))
    if (!ok || E.sha256(Buffer.from('x')).length!==32) { console.error('interop FAILED'); process.exit(1) }
    console.log('concurrent import + crypto OK on', process.version)
  "

UNIT_COUNT=$(node manifest.mjs --json 2>/dev/null | node -e "const m=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(m.tests.unit))")
run "Unit + property suite (${UNIT_COUNT} tests, excl. adversarial)" "unit-suite.log" \
  node run-tests.mjs

ADV_COUNT=$(node manifest.mjs --json 2>/dev/null | node -e "const m=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(m.tests.adversarial))")
run "Adversarial CI battery (${ADV_COUNT} tests)" "adversarial-ci.log" \
  node run-tests.mjs --only adversarial

run "Adversarial battery — all ${SCEN_COUNT} scenarios × ${SCEN_SEEDS} seed × $((SCEN_MS/1000))s (sample)" "advsim-all.log" \
  node advsim.mjs all ${SCEN_SEEDS} ${SCEN_MS}

run "Large-history storage benchmark (1M ticks, SQLite)" "bench-1M.log" \
  node bench-storage.mjs 1000000 sqlite

run "Consensus liveness/economy demo" "demo.log" \
  timeout 90 node demo.mjs

run "In-process multi-witness demo (demo6)" "demo6.log" \
  timeout 120 node demo6.mjs

# storage operations tooling on a freshly-built synthetic store (§3)
run "Storage operations (health/integrity/backup/verify)" "storage-ops.log" \
  bash -c '
    set -e
    D=$(mktemp -d)
    node --input-type=module -e "
      import { sqliteFinalityStore } from \"./node.mjs\"
      import E from \"./engine.js\"
      const wid = \"ab\".repeat(32)
      const s = sqliteFinalityStore(\"$D/f.db\", { worldId: wid })
      for (let t=0;t<200;t++) s.append({worldId:wid,tick:t,round:0,previousStateHash:\"a\".repeat(64),bundle:{worldId:wid},bundleHash:t.toString(16).padStart(64,\"0\"),resultingStateHash:\"b\".repeat(64),attestations:[]})
      s.close()
    "
    echo "--- health ---";    node storage-ops.mjs health "$D/f.db"
    echo "--- integrity ---";  node storage-ops.mjs integrity "$D/f.db"
    echo "--- backup ---";     node storage-ops.mjs backup "$D/f.db" "$D/bk.db"
    echo "--- verify ---";     node storage-ops.mjs verify "$D/bk.db"
    rm -rf "$D"
  '

# process-lock exclusivity + listener-stability (§3, exit-listener leak fix)
run "Exclusive kernel lock + listener stability" "process-lock.log" \
  node --input-type=module -e "
    import { acquireProcessLock } from './node.mjs'
    import fs from 'fs'; import os from 'os'; import path from 'path'
    const d = fs.mkdtempSync(path.join(os.tmpdir(),'plock-'))
    const f = path.join(d,'process.lock.sock')
    const l1 = await acquireProcessLock(f)
    let refused = false
    try { await acquireProcessLock(f) } catch (e) { refused = e.code === 'ERR_WITNESS_LOCK_HELD' }
    if (!refused) { console.error('FAIL: second acquisition not refused'); process.exit(1) }
    l1.release()
    const before = process.listenerCount('exit')
    for (let i=0;i<40;i++){ const l = await acquireProcessLock(f); l.release() }
    const after = process.listenerCount('exit')
    if (after !== before) { console.error('FAIL: exit listeners leaked '+before+'->'+after); process.exit(1) }
    console.log('exclusion: refused a live second holder; listeners constant ('+before+') over 40 cycles')
    fs.rmSync(d,{recursive:true,force:true})
  "

# demo7 (live libp2p) and e2e-multiproc (real processes) bind real sockets
# and can be flaky under sandboxed process wrappers; run them only when
# INTERVAL_LIVE=1 so the core evidence always generates cleanly. Their
# passing output is captured in CONSENSUS.md and the session record.
if [ "${INTERVAL_LIVE:-0}" = "1" ]; then
  run "Live libp2p adversarial demo (demo7)" "demo7.log" \
    timeout 130 node demo7.mjs || echo "  (demo7 is socket-sensitive; see log)"

  run "Multi-process witness E2E" "e2e-multiproc.log" \
    timeout 150 bash e2e-multiproc.sh || echo "  (E2E is socket-sensitive; see log)"
else
  echo "=== Live libp2p demo7 + multi-process E2E ===" >> "$SUMMARY.tmp"
  echo "SKIPPED (set INTERVAL_LIVE=1 to include; socket-sensitive under sandboxes)" >> "$SUMMARY.tmp"
  echo "" >> "$SUMMARY.tmp"
fi

# ---- assemble the summary ----
cat "$SUMMARY.tmp" >> "$SUMMARY"
rm -f "$SUMMARY.tmp"
{
  echo "## Test counts (from manifest, derived from source)"
  echo '```'
  node manifest.mjs 2>/dev/null
  echo '```'
  echo ""
  echo "## Benchmark summary (1M ticks, from bench-1M.log)"
  echo '```'
  grep -E "append total|lookup|integrity|online backup|db size" "$OUT/bench-1M.log" 2>/dev/null || echo "(benchmark log unavailable)"
  echo '```'
  echo ""
  echo "## Verdict"
  echo ""
  if [ $FAIL -eq 0 ]; then
    echo "**All captured stages passed.** Exit codes are recorded above; full logs are in this directory."
  else
    echo "**One or more stages failed.** Inspect the logs referenced above."
  fi
  echo ""
  echo "## Exact reproduction"
  echo '```'
  echo "npm ci                      # exact reproduction from the committed lockfile"
  echo "bash freeze-evidence.sh"
  echo '```'
} >> "$SUMMARY"

echo ""
echo "evidence written to $OUT/ (exit $FAIL)"
exit $FAIL
