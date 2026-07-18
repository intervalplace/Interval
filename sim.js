// Interval v0.2: determinism + identity proof.
// Two peers independently replay the same *signed* inputs and must agree
// on every state hash. Plus: forged signatures, replayed inputs, and
// wrong-world genesis are all rejected.

'use strict';
const fs = require('fs');
const E = require('./engine');

const TICKS = 200;
const SEED = 'interval-genesis-0001';

// The rules hash: SHA-256 of the constitution itself (spec §9).
const RULES_HASH = E.sha256(fs.readFileSync('./SPEC.md')).toString('hex');
const GENESIS = E.makeGenesis(SEED, RULES_HASH, 0);
const WID = E.worldId(GENESIS);

// real ed25519 identities
const alice = E.generateIdentity();
const bob = E.generateIdentity();

function buildWorld() {
  const w = E.newWorld(GENESIS);
  E.addPlayer(w, alice.playerId, 5, 5);
  E.addPlayer(w, bob.playerId, 8, 5);
  E.addNode(w, 'tree-1', 'tree', 6, 5);
  E.addNode(w, 'rock-1', 'rock', 8, 6);
  return w;
}

// Pre-sign the full input log once: both peers replay the SAME signed log,
// exactly as they would receive it from the network.
function buildInputLog() {
  const log = [];
  let state = buildWorld();
  for (let t = 0; t < TICKS; t++) {
    const inputs = [];
    const a = state.players[alice.playerId];
    const b = state.players[bob.playerId];
    if (!a.action) inputs.push(E.signInput(
      { worldId: WID, tick: state.tick, playerId: alice.playerId, type: 'gather', nodeId: 'tree-1' },
      alice.privateKey));
    if (!b.action) inputs.push(E.signInput(
      { worldId: WID, tick: state.tick, playerId: bob.playerId, type: 'gather', nodeId: 'rock-1' },
      bob.privateKey));
    log.push(inputs);
    state = E.nextState(state, inputs, E.beaconValue(SEED, state.tick));
  }
  return log;
}

function replay(inputLog) {
  let state = buildWorld();
  const hashes = [];
  for (let t = 0; t < TICKS; t++) {
    state = E.nextState(state, inputLog[t], E.beaconValue(SEED, state.tick));
    hashes.push(E.stateHash(state));
  }
  return { state, hashes };
}

const inputLog = buildInputLog();
const peer1 = replay(inputLog);
const peer2 = replay(inputLog);

const agree = peer1.hashes.every((h, i) => h === peer2.hashes[i]);

const a = peer1.state.players[alice.playerId];
const b = peer1.state.players[bob.playerId];
const count = inv => inv.filter(Boolean).length;

console.log(`Interval spec v${E.SPEC_VERSION}: ${TICKS} ticks`);
console.log(`Rules hash: ${RULES_HASH.slice(0, 16)}…`);
console.log(`Peers agree on all ${TICKS} state hashes: ${agree ? 'YES ✓' : 'NO ✗'}`);
console.log(`alice (${alice.playerId.slice(0, 8)}…) woodcutting lvl ${E.levelForXp(a.skills.woodcutting)}, ${count(a.inventory)} logs`);
console.log(`bob   (${bob.playerId.slice(0, 8)}…) mining      lvl ${E.levelForXp(b.skills.mining)}, ${count(b.inventory)} ore`);
console.log('');

// --- adversarial tests ---
let pass = agree;

// 1. Forged input: mallory signs an input claiming to be alice
const mallory = E.generateIdentity();
const forged = E.signInput(
  { worldId: WID, tick: 0, playerId: alice.playerId, type: 'move', dx: 1, dy: 0 },
  mallory.privateKey);
const forgedOk = E.verifyInputSig(forged);
console.log(`Forged signature (mallory as alice): ${forgedOk ? 'ACCEPTED (bad!)' : 'rejected ✓'}`);
pass = pass && !forgedOk;

// 2. Tampered input: valid signature, then payload altered
const legit = E.signInput(
  { worldId: WID, tick: 0, playerId: alice.playerId, type: 'move', dx: 1, dy: 0 },
  alice.privateKey);
const tampered = { ...legit, dx: -1 };
const tamperedOk = E.verifyInputSig(tampered);
console.log(`Tampered payload after signing: ${tamperedOk ? 'ACCEPTED (bad!)' : 'rejected ✓'}`);
pass = pass && !tamperedOk;

// 3. Replay attack: alice's valid tick-0 input resubmitted at a later tick
const w = buildWorld();
const later = E.nextState(w, [], E.beaconValue(SEED, 0)); // now tick 1
const replayed = E.nextState(later, [legit], E.beaconValue(SEED, 1));
const moved = replayed.players[alice.playerId].x !== 5;
console.log(`Replayed old input at wrong tick: ${moved ? 'APPLIED (bad!)' : 'ignored ✓'}`);
pass = pass && !moved;

// 4. Different constitution = different world
const forkGenesis = E.makeGenesis(SEED, 'f'.repeat(64));
const forkWorld = E.newWorld(forkGenesis);
const same = E.sameWorld(buildWorld(), forkWorld);
console.log(`Peer with different rules hash: ${same ? 'same world (bad!)' : 'different world → not peers ✓'}`);
pass = pass && !same;

// 5. State tamper (from v0.1): self-awarded XP diverges the hash
const cheat = JSON.parse(JSON.stringify(peer1.state));
cheat.players[alice.playerId].skills.woodcutting += 9999;
const cheatHidden = E.stateHash(cheat) === peer1.hashes[TICKS - 1];
console.log(`Self-awarded XP: ${cheatHidden ? 'undetected (bad!)' : 'hash diverges → rejected ✓'}`);
pass = pass && !cheatHidden;

// 6. Names (spec §5a): conflict resolution, one-name rule, validity
const nw = buildWorld();
const claimA = E.signInput({ worldId: WID, tick: 0, playerId: alice.playerId, type: 'claim_name', name: 'zezima' }, alice.privateKey);
const claimB = E.signInput({ worldId: WID, tick: 0, playerId: bob.playerId, type: 'claim_name', name: 'zezima' }, bob.privateKey);
const ns = E.nextState(nw, [claimA, claimB], E.beaconValue(SEED, 0));
const oneOwner = Object.values(ns.names).length === 1 && 'zezima' in ns.names;
console.log(`Simultaneous name claims resolve to one owner: ${oneOwner ? '✓' : '✗ (bad!)'}`);
pass = pass && oneOwner;

const owner = ns.names['zezima'];
const ownerKey = owner === alice.playerId ? alice.privateKey : bob.privateKey;
const second = E.nextState(ns, [E.signInput({ worldId: WID, tick: 1, playerId: owner, type: 'claim_name', name: 'other' }, ownerKey)], E.beaconValue(SEED, 1));
const oneNameRule = !('other' in second.names);
console.log(`Second name for same player refused: ${oneNameRule ? '✓' : '✗ (bad!)'}`);
pass = pass && oneNameRule;

console.log('');
console.log(pass ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT');
process.exit(pass ? 0 : 1);
