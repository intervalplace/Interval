// Interval SDK v0.5 — Layer 2: the window-maker.
// A clean client library between the node (layer 1: constitution +
// consensus) and any renderer (layer 3: terminal, web, spreadsheet…).
// The SDK knows nothing about pixels; renderers know nothing about
// gossip. Humans and bots use this exact same interface — that is the
// bot-indifference doctrine made concrete.

import E from './engine.js'

export class IntervalClient {
  constructor({ node, identity }) {
    this.node = node
    this.identity = identity        // { playerId, privateKey } — your key IS your character
  }

  // ---- reading the world (all state is public and verifiable) ----
  get world() { return this.node.state }
  get tick() { return this.node.state.tick }
  get me() { return this.node.state.players[this.identity.playerId] ?? null }
  get peers() { return this.node.p2p.getConnections().length }
  get worldId() { return this.node.genesis.rulesHash.slice(0, 12) }

  players() {
    return Object.entries(this.world.players).map(([pid, p]) => ({
      pid, ...p, display: p.name ?? pid.slice(0, 6) + '…',
    }))
  }
  nodesAt() { return Object.entries(this.world.nodes).map(([id, n]) => ({ id, ...n })) }
  displayName(pid) { return this.world.players[pid]?.name ?? pid.slice(0, 6) + '…' }
  level(skill) { return this.me ? E.levelForXp(this.me.skills[skill]) : 0 }
  inventoryCount() { return this.me ? this.me.inventory.filter(Boolean).length : 0 }

  // ---- acting in the world (signed inputs, one per tick) ----
  #send(fields) {
    const input = E.signInput(
      { tick: this.tick, playerId: this.identity.playerId, ...fields },
      this.identity.privateKey)
    return this.node.submitInput(input)
  }
  move(dx, dy) { return this.#send({ type: 'move', dx, dy }) }
  gather(nodeId) { return this.#send({ type: 'gather', nodeId }) }
  stop() { return this.#send({ type: 'stop' }) }
  claimName(name) { return this.#send({ type: 'claim_name', name }) }
  spawn() { return this.#send({ type: 'spawn' }) }
  offerTrade(to, giveSlot, wantItem) { return this.#send({ type: 'offer_trade', to, giveSlot, wantItem }) }
  acceptTrade(from) { return this.#send({ type: 'accept_trade', from }) }
  cancelTrade() { return this.#send({ type: 'cancel_trade' }) }
  cook(slot) { return this.#send({ type: 'cook', slot }) }
  attack(mobId) { return this.#send({ type: 'attack', mobId }) }
  eat(slot) { return this.#send({ type: 'eat', slot }) }
  drop(slot) { return this.#send({ type: 'drop', slot }) }
  pickup(groundId) { return this.#send({ type: 'pickup', groundId }) }
  light(slot) { return this.#send({ type: 'light', slot }) }
  bury(slot) { return this.#send({ type: 'bury', slot }) }
  fletch(slot, make) { return this.#send({ type: 'fletch', slot, make }) }
  invoke() { return this.#send({ type: 'invoke' }) }
  cast(spell) { return this.#send({ type: 'cast', spell }) }
  unequip(gear) { return this.#send({ type: 'unwield', gear }) }
  deposit(slot) { return this.#send({ type: 'deposit', slot }) }
  withdraw(item) { return this.#send({ type: 'withdraw', item }) }
  smith(recipe) { return this.#send({ type: 'smith', recipe }) }
  wield(slot) { return this.#send({ type: 'wield', slot }) }
  unwield() { return this.#send({ type: 'unwield' }) }
  chat(text) { return this.node.publishChat(this.identity, text) }
  onChat(cb) { this.node.onChat = cb }

  // ---- the heartbeat ----
  onTick(cb) { this.node.onTick = cb }
}
