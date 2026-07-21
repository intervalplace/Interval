// Which landscape does this founding record describe?
//
// A world names its generator in its genesis, and a node that cannot build
// that generator's country must refuse rather than grow a different one and
// call it the same world. This is the one place that mapping lives, so adding
// a world to a node is adding a line here rather than editing every tool.
import * as classic from './worldgen.mjs'
import * as expanse from './worldgen-expanse.mjs'

const GENERATORS = {
  [classic.GENERATOR_ID]: classic,
  [expanse.GENERATOR_ID]: expanse,
}

// the founding, dispatched: each generator founds at its own calibrated
// scale unless the founder names one. The expanse's own founding also
// seals its geography, watchfire, and survey retunes into the genesis.
export function foundGenesis(genId, seed, rulesHash, anchorMs, W = 0, H = 0) {
  if (genId === expanse.GENERATOR_ID)
    return expanse.makeExpanseGenesis(seed, rulesHash, anchorMs, W || 640, H || 400)
  return classicE().makeGenesis(seed, rulesHash, anchorMs, W || 320, H || 200, genId)
}
import E from './engine.js'
const classicE = () => E

export function generatorFor(genesis) {
  const g = GENERATORS[genesis.worldGenerator]
  if (!g) throw new Error(
    `this genesis names generator ${JSON.stringify(genesis.worldGenerator)}, which this node does not implement `
    + `(it knows: ${Object.keys(GENERATORS).join(', ')}) — refusing to guess at another world's landscape`)
  return g
}

// Build the world a founding record describes, whichever country that is.
export function buildWorld(genesis) {
  return generatorFor(genesis).buildWorld(genesis)
}
