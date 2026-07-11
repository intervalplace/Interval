// Interval node v0.3 — the networked constitution.
// Wraps the deterministic engine in a libp2p gossipsub mesh:
//   - signed inputs are gossiped on the world's input topic
//   - every node advances the world in lockstep on the tick schedule
//   - every node publishes its state hash after each tick
//   - hashes are compared; divergent peers are flagged and ignored
// Topics are namespaced by rules hash: a different constitution is
// literally a different network. Forks are separate worlds by construction.

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { identify } from '@libp2p/identify'
import fs from 'fs'
import E from './engine.js'

export class IntervalNode {
  /**
   * @param opts.genesis   genesis object (spec version + rules hash + seed)
   * @param opts.buildWorld  fn(genesis) -> initial world state (must be identical across peers)
   * @param opts.name      label for logs
   * @param opts.tamper    optional fn(state) -> state, simulates a rule-breaking node
   */
  constructor(opts) {
    this.genesis = opts.genesis
    this.name = opts.name
    this.tamper = opts.tamper || null
    this.state = opts.buildWorld(opts.genesis)
    this.inputBuffer = new Map()        // tick -> Map(playerId -> input)
    this.peerHashes = new Map()         // tick -> Map(peerId -> hash)
    this.myHashes = new Map()           // tick -> hash
    this.divergent = new Map()          // peerId -> first divergent tick
    this.onTick = null                  // layer-2 hook: called after each tick
    this.log = []
    const ns = this.genesis.rulesHash.slice(0, 12)
    this.topics = {
      inputs: `interval/${this.genesis.specVersion}/${ns}/inputs`,
      hashes: `interval/${this.genesis.specVersion}/${ns}/hashes`,
    }
    this.checkpointProto = `/interval/${this.genesis.specVersion}/${ns}/checkpoint/1.0.0`
    this.chatTopic = `interval/${this.genesis.specVersion}/${ns}/chat/1.0.0`
    this.onChat = null
    this._chatLast = new Map()          // playerId -> ms of last accepted message
    this.ticklogProto = `/interval/${this.genesis.specVersion}/${ns}/ticklog/1.0.0`
    this.tickLog = new Map()            // tick -> inputs applied (recent history)
    this.checkpointFile = opts.checkpointFile || null
    this.listen = opts.listen || null
    // resume from disk if a checkpoint exists (spec §9a: persistence)
    if (this.checkpointFile && fs.existsSync(this.checkpointFile)) {
      const cp = JSON.parse(fs.readFileSync(this.checkpointFile))
      this.state = cp.state
      this.log.push(`[${this.name}] resumed from disk checkpoint at tick ${cp.tick}`)
    }
  }

  async start() {
    this.p2p = await createLibp2p({
      addresses: { listen: [this.listen ?? '/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
        identify: identify(),
      },
    })
    const ps = this.p2p.services.pubsub
    ps.subscribe(this.topics.inputs)
    ps.subscribe(this.topics.hashes)
    ps.subscribe(this.chatTopic)
    ps.addEventListener('message', (evt) => this.onMessage(evt))
    // serve recent input history for catch-up (spec §9b)
    await this.p2p.handle(this.ticklogProto, async ({ stream }) => {
      const chunks = []
      for await (const c of stream.source) { chunks.push(c.subarray()); break }
      let req; try { req = JSON.parse(Buffer.concat(chunks).toString()) } catch { return }
      const out = []
      for (let t = req.from; t < req.to; t++) {
        if (!this.tickLog.has(t)) break // gap: serve what we contiguously have
        out.push({ tick: t, inputs: this.tickLog.get(t) })
      }
      stream.sink([Buffer.from(JSON.stringify(out))]).catch(() => {})
    })

    // serve our latest checkpoint to joining peers (spec §9a)
    await this.p2p.handle(this.checkpointProto, ({ stream }) => {
      const cp = Buffer.from(JSON.stringify({ tick: this.state.tick, state: this.state }))
      stream.sink([cp]).catch(() => {})
    })
    return this
  }

  // Late join (spec §9a): fetch checkpoints from >=2 peers, verify the
  // state hashes agree, adopt. One peer is never enough.
  async syncFromPeers(addrs, opts = {}) {
    // spec §9a wants >=2 corroborating peers. A world's FIRST joiner has
    // only the founder to ask: allowSingle accepts that trust explicitly,
    // and hash gossip still judges every tick afterward.
    if (addrs.length < 2 && !opts.allowSingle) throw new Error('need >=2 peers to corroborate a checkpoint')
    const cps = []
    for (const addr of addrs) {
      const stream = await this.p2p.dialProtocol(addr, this.checkpointProto)
      const chunks = []
      for await (const chunk of stream.source) chunks.push(chunk.subarray())
      cps.push(JSON.parse(Buffer.concat(chunks).toString()))
    }
    const hashes = cps.map(cp => E.stateHash(cp.state))
    const ticks = cps.map(cp => cp.tick)
    if (new Set(hashes).size !== 1 || new Set(ticks).size !== 1) {
      throw new Error('checkpoint corroboration failed: peers disagree — refusing to adopt')
    }
    this.state = cps[0].state
    this.myHashes.set(this.state.tick, hashes[0])
    this.log.push(`[${this.name}] joined at tick ${this.state.tick}, checkpoint corroborated by ${cps.length} peers (${hashes[0].slice(0, 8)}…)`)
    return this.state.tick
  }

  addr() { return this.p2p.getMultiaddrs()[0] }
  async dial(addr) { await this.p2p.dial(addr) }
  peerId() { return this.p2p.peerId.toString() }

  acceptChat(msg) { // spec §9c: signed, short, one per interval per key
    if (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > 80) return false
    if (!E.verifyInputSig(msg)) return false
    const now = Date.now()
    if (now - (this._chatLast.get(msg.playerId) ?? 0) < E.TICK_MS) return false
    this._chatLast.set(msg.playerId, now)
    return true
  }

  async publishChat(identity, text) {
    const msg = E.signInput(
      { type: 'chat', playerId: identity.playerId, tick: this.state.tick, text: String(text).slice(0, 80) },
      identity.privateKey)
    if (this.acceptChat(msg) && this.onChat) this.onChat(msg) // local echo
    await this.p2p.services.pubsub.publish(this.chatTopic, Buffer.from(JSON.stringify(msg)))
  }

  onMessage(evt) {
    const { topic, data } = evt.detail
    let msg
    try { msg = JSON.parse(Buffer.from(data).toString()) } catch { return }

    if (topic === this.chatTopic) {
      if (this.acceptChat(msg) && this.onChat) this.onChat(msg)
      return
    }

    if (topic === this.topics.inputs) {
      // Buffer inputs for current/future ticks. Signature validity is
      // re-checked by the state machine itself at application time.
      if (typeof msg.tick !== 'number' || msg.tick < this.state.tick) return
      if (!this.inputBuffer.has(msg.tick)) this.inputBuffer.set(msg.tick, new Map())
      const bucket = this.inputBuffer.get(msg.tick)
      // duplicate handling mirrors spec §5: second input poisons the bundle
      bucket.set(msg.playerId, bucket.has(msg.playerId) ? 'DUP' : msg)
    }

    if (topic === this.topics.hashes) {
      const { tick, hash, peer } = msg
      if (typeof tick !== 'number' || typeof hash !== 'string') return
      if (!this.peerHashes.has(tick)) this.peerHashes.set(tick, new Map())
      this.peerHashes.get(tick).set(peer, hash)
      this.checkDivergence(tick)
    }
  }

  checkDivergence(tick) {
    const mine = this.myHashes.get(tick)
    if (!mine) return
    for (const [peer, hash] of this.peerHashes.get(tick) || []) {
      if (hash !== mine && !this.divergent.has(peer)) {
        this.divergent.set(peer, tick)
        this.log.push(`[${this.name}] DIVERGENCE: peer ${peer.slice(0, 8)}… broke the rules at tick ${tick} — ignoring their world`)
      }
    }
  }

  // Submit a locally-authored (already signed) input: apply locally via
  // buffer AND gossip to the mesh.
  async submitInput(input) {
    if (!this.inputBuffer.has(input.tick)) this.inputBuffer.set(input.tick, new Map())
    const bucket = this.inputBuffer.get(input.tick)
    bucket.set(input.playerId, bucket.has(input.playerId) ? 'DUP' : input)
    await this.p2p.services.pubsub.publish(
      this.topics.inputs, Buffer.from(JSON.stringify(input)))
  }

  // Advance one tick: everyone does this at the same scheduled moment.
  async advanceTick() {
    const tick = this.state.tick
    const bucket = this.inputBuffer.get(tick) || new Map()
    const inputs = [...bucket.entries()]
      .filter(([, v]) => v !== 'DUP')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, v]) => v)
    const beacon = E.beaconValue(this.genesis.genesisSeed, tick)

    this.tickLog.set(tick, inputs)
    if (this.tickLog.size > 256) this.tickLog.delete(Math.min(...this.tickLog.keys()))
    this.state = E.nextState(this.state, inputs, beacon)
    if (this.tamper) this.state = this.tamper(this.state) // rule-breaker path

    const hash = E.stateHash(this.state)
    this.myHashes.set(tick + 1, hash)
    this.inputBuffer.delete(tick)
    this.checkDivergence(tick + 1)

    // persist checkpoint every tick (spec §9a)
    if (this.checkpointFile) {
      fs.writeFileSync(this.checkpointFile,
        JSON.stringify({ tick: this.state.tick, state: this.state }))
    }

    await this.p2p.services.pubsub.publish(
      this.topics.hashes,
      Buffer.from(JSON.stringify({ tick: tick + 1, hash, peer: this.peerId() })))
    if (this.onTick) this.onTick(this.state)
    return hash
  }

  // Catch-up (spec §9b): a stalled node fetches the ticks it missed from
  // a peer's input log and REPLAYS them deterministically. No trust is
  // extended — replay recomputes every state, and hash gossip judges it.
  async catchUpFrom(addr, targetTick) {
    while (this.state.tick < targetTick) {
      const stream = await this.p2p.dialProtocol(addr, this.ticklogProto)
      await stream.sink([Buffer.from(JSON.stringify({ from: this.state.tick, to: targetTick }))])
      const chunks = []
      for await (const c of stream.source) chunks.push(c.subarray())
      const log = JSON.parse(Buffer.concat(chunks).toString())
      if (!log.length) throw new Error('peer log does not reach back to tick ' + this.state.tick + ' — re-sync from checkpoint instead')
      for (const entry of log) {
        if (entry.tick !== this.state.tick) continue
        const beacon = E.beaconValue(this.genesis.genesisSeed, entry.tick)
        this.state = E.nextState(this.state, entry.inputs, beacon)
        this.tickLog.set(entry.tick, entry.inputs)
        this.myHashes.set(entry.tick + 1, E.stateHash(this.state))
      }
    }
    this.log.push(`[${this.name}] caught up to tick ${this.state.tick} by replay`)
  }

  // The shared clock (spec §2): tick N finalizes at anchorMs + (N+1)*600.
  // Every node computes the same schedule from genesis — no coordinator.
  startTicking() {
    this._ticking = true
    const loop = async () => {
      if (!this._ticking) return
      const due = this.genesis.anchorMs + (this.state.tick + 1) * E.TICK_MS
      const wait = due - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      if (!this._ticking) return
      await this.advanceTick()
      loop()
    }
    loop()
  }

  stopTicking() { this._ticking = false }

  async stop() { this._ticking = false; await this.p2p.stop() }
}
