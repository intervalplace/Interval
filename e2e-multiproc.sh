#!/usr/bin/env bash
# End-to-end over REAL PROCESSES and REAL SOCKETS.
#
# serve.mjs founds a 3-witness world (quorum 2): the pillar plus two
# pregenerated witness keys. Two `node join.mjs --witness=…` processes run
# from isolated /tmp working copies with their own durable stores. Then:
#   - all three live         → the world advances
#   - kill one witness       → 2 of 3 still reaches quorum, advances
#   - kill the second        → quorum unreachable, the world HALTS (no fork)
#   - restart one            → quorum returns, the world resumes
set -u
cd "$(dirname "$0")"
ROOT=$(pwd)
PORT=8799
P2P=4699
LOG=/tmp/e2e-logs
rm -rf "$LOG" && mkdir -p "$LOG"
rm -rf checkpoints witness-safety

# pregenerate the two extra witness identities (self-contained)
mkdir -p identities
for w in w2 w3; do
  [ -f "identities/$w.json" ] || node -e "const E=require('./engine.js'),fs=require('fs');fs.writeFileSync('identities/$w.json',JSON.stringify(E.exportIdentity(E.generateIdentity())))"
done

W2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('identities/w2.json')).playerId)")
W3=$(node -e "console.log(JSON.parse(require('fs').readFileSync('identities/w3.json')).playerId)")
echo "founding witnesses: pillar + ${W2:0:12}… + ${W3:0:12}…  (quorum 2)"

# ---- found the world (serve = pillar witness) ----
INTERVAL_HTTP_PORT=$PORT INTERVAL_P2P_PORT=$P2P INTERVAL_WITNESSES="$W2,$W3" INTERVAL_QUORUM=2 \
  node serve.mjs >"$LOG/pillar.log" 2>&1 &
PILLAR=$!
sleep 7
if ! curl -sf localhost:$PORT/api/world >/dev/null; then echo "pillar failed to start"; cat "$LOG/pillar.log"; kill $PILLAR 2>/dev/null; exit 1; fi
echo "pillar up: $(curl -s localhost:$PORT/api/world | node -e 'process.stdin.on("data",d=>{const j=JSON.parse(d);console.log("tick",j.tick)})')"

# ---- witness working copies in /tmp (isolated stores) ----
setup_witness () {
  local name=$1 port=$2
  local dir=/tmp/e2e-$name
  rm -rf "$dir" && mkdir -p "$dir/identities"
  ln -s "$ROOT/node_modules" "$dir/node_modules"
  for f in engine.js node.mjs sdk.mjs join.mjs worldgen.mjs protocol.mjs agreement.mjs errors.mjs SPEC.md package.json; do cp "$ROOT/$f" "$dir/"; done
  cp "$ROOT/identities/$name.json" "$dir/identities/$name.json"
  echo "$dir"
}
D2=$(setup_witness w2 4701)
D3=$(setup_witness w3 4702)

start_w2 () { (cd "$D2" && INTERVAL_P2P_PORT=4701 node join.mjs http://localhost:$PORT w2node --witness=identities/w2.json --port=4701 >"$LOG/w2.log" 2>&1 &) ; }
start_w3 () { (cd "$D3" && INTERVAL_P2P_PORT=4702 node join.mjs http://localhost:$PORT w3node --witness=identities/w3.json --port=4702 >"$LOG/w3.log" 2>&1 &) ; }

start_w2; start_w3
sleep 9
grep -q "witness key accepted" "$D2/../e2e-logs/w2.log" 2>/dev/null || grep -q "witness key accepted" "$LOG/w2.log" && echo "w2 joined as witness" || echo "w2 join status unclear"
grep -q "witness key accepted" "$LOG/w3.log" && echo "w3 joined as witness" || echo "w3 join status unclear"

tick_now () { curl -s localhost:$PORT/api/world | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).tick)}catch{console.log("?")}})'; }
halted_now () { curl -s localhost:$PORT/api/world | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).halted)}catch{console.log("?")}})'; }

# ---- phase 1: all three witnesses live ----
T1=$(tick_now); sleep 6; T2=$(tick_now)
echo "— phase 1 (3 witnesses): tick $T1 → $T2  $([ "$T2" -gt "$T1" ] 2>/dev/null && echo ADVANCING || echo STALLED)"
P1=$([ "$T2" -gt "$T1" ] 2>/dev/null && echo ok || echo fail)

# ---- phase 2: kill w3; 2 of 3 still makes quorum 2 ----
pkill -f "join.mjs http://localhost:$PORT w3node" 2>/dev/null
sleep 16; T3=$(tick_now)  # generous window: lock-split convergence under load (documented H2 latency)
echo "— phase 2 (killed w3, 2 live): tick $T2 → $T3  $([ "$T3" -gt "$T2" ] 2>/dev/null && echo ADVANCING || echo STALLED)"
P2=$([ "$T3" -gt "$T2" ] 2>/dev/null && echo ok || echo fail)

# ---- phase 3: restart w3 INTO the live world; it re-syncs and resumes ----
# (a witness rejoining a still-advancing world: certified checkpoint sync
# carries it to the frontier, then it attests again)
start_w3
sleep 18; T4=$(tick_now)
echo "— phase 3 (restarted w3 into live world): tick $T3 → $T4  $([ "$T4" -gt "$T3" ] 2>/dev/null && echo RESUMED || echo STALLED)"
P3=$([ "$T4" -gt "$T3" ] 2>/dev/null && echo ok || echo fail)

# ---- phase 4: kill w2 AND w3; quorum 2 unreachable with 1 → HALT, no fork ----
pkill -f "join.mjs http://localhost:$PORT w2node" 2>/dev/null
pkill -f "join.mjs http://localhost:$PORT w3node" 2>/dev/null
sleep 8; T5=$(tick_now)
echo "— phase 4 (killed both, 1 live): tick $T4 → $T5  $([ "$T5" -le "$((T4+2))" ] 2>/dev/null && echo HALTED || echo "still moving?")"
HALTFLAG=$(halted_now)
echo "    pillar reports halted=$HALTFLAG (a stopped world, never a forked one)"
P4=$([ "$T5" -le "$((T4+2))" ] 2>/dev/null && echo ok || echo fail)

# ---- teardown ----
pkill -f "join.mjs http://localhost:$PORT" 2>/dev/null
kill $PILLAR 2>/dev/null
wait 2>/dev/null
rm -rf "$D2" "$D3"

echo ""
echo "phase 1 (advance, 3 witnesses):   $P1"
echo "phase 2 (advance, 2 of 3 quorum): $P2"
echo "phase 3 (witness restart resumes): $P3"
echo "phase 4 (halt when quorum lost):   $P4"
if [ "$P1" = ok ] && [ "$P2" = ok ] && [ "$P3" = ok ] && [ "$P4" = ok ]; then
  echo "ALL CHECKS PASSED"; exit 0
else
  echo "CHECKS FAILED"; exit 1
fi
