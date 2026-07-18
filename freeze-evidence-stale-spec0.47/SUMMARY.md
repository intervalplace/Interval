# Interval — Protocol-Freeze Evidence

Generated: 2026-07-16T19:58:28Z

## Release
- package: 0.23.0
- release: phase-1-freeze
- protocol spec: 0.47
- consensus spec: 1.9
- rules hash: 7b3cab5e576bae3f…

## Runtime environment
```
node:     v22.22.2
platform: Linux 6.18.5 x86_64
date:     2026-07-16T19:58:28Z
```

## Source binding
```
source-tree sha256:   6c41383b49b1afc53d7572d7198f2c73a9862423e3ac420ef374898ac2a08290
package-lock sha256:  ab2ecb13707443ac4f8f5c8521c16761a45524428350e69be543040e3d3003c2
SPEC.md sha256:       7b3cab5e576bae3f2753e204e551c84d0e918482fa2d0808753eeb8f6b635da4
CONSENSUS.md sha256:  09b9b4923cbc187562853b78489fb715dffb44692af16a4ed96c598ea5ab6017
TESTING.md sha256:    aeb1f516ce58a317b39893cc92cf42720c562f05a3ff71aaf81d8453b70eb9c1
README.md sha256:     c1243f304e0ab18c131ff5abb8330d10ab92596fecd959fc19f021237fd8b93b
package.json sha256:  676eac8d441a4330c3b655fcb12ffbb7ee573039e70551919d6cea3ef6eaec4d
```

## Captured stages

| stage | exit | log |
|---|---|---|
| Release manifest + doc consistency | 0 | manifest.log |
| Deterministic peer-agreement sim | 0 | sim.log |
| Node interop (race-free import) | 0 | interop.log |
| Unit + property suite (auto-discovered) | 0 | unit-suite.log |
| Adversarial CI battery | 0 | adversarial-ci.log |
| Adversarial battery — 11 scenarios × 1 seed × 11s | 0 | advsim-all.log |
| Large-history benchmark (1M ticks) | 0 | bench-1M.log |
| Consensus liveness/economy demo | 0 | demo.log |
| In-process multi-witness demo (demo6) | 0 | demo6.log |
| Storage ops (health/integrity/backup/verify) | 0 | storage-ops.log |
| Exclusive kernel lock + listener stability | 0 | process-lock.log |
| Live libp2p adversarial (demo7) | 0 | demo7-live.log |
| Multi-process witness E2E | 0 | e2e-multiproc-live.log |

## Test counts (from manifest, derived from source)
```
release          0.23.0 (phase-1-freeze)
spec / consensus 0.47 / 1.9
rules hash       7b3cab5e576bae3f…
node engine      >=22.5.0
unit tests       157
adversarial      15
total tests      172
scenarios        11 (benign, lossy, crashes, partitions, equivocator, liar, replayer, garbage, chaos, heal, byzantine-max)
benchmarks       1 (bench-storage.mjs)
```

## Benchmark summary (1M ticks, from bench-1M.log)
```
  append total: 5420 ms  (184.5k rows/s, 5.4 µs/row batched)
  db size: 401.8 MB  (402 bytes/row)
  lookup: 10,000 random gets in 141.6 ms (14.2 µs/get; first-get warm 0.2 ms)
  integrity quick_check: 274 ms
  online backup: 1481 ms  (372.1 MB)
```

## Phase 1 freeze criterion — met
- shutdown drains checkpoint I/O to completion before releasing exclusivity (no timeout; fails closed)
- bounded startup verification is the generic default (shared constant everywhere)
- official test command runs every suite (auto-discovering runner)
- documentation matches implementation (manifest --check + version.test.mjs)
- process lock does not leak exit listeners across acquire/release
- evidence matches the exact release tree (source hash above)
- no known consensus or recovery defect remains

## Verdict

**All captured stages passed. Phase 1 freeze criterion met.**

## Exact reproduction
```
npm ci
bash freeze-evidence.sh
```
