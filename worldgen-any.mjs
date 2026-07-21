// Which landscape does this founding record describe?
//
// A world names its generator in its genesis, and a node that cannot build
// that generator's country must refuse rather than grow a different one and
// call it the same world. This is the one place that mapping lives, so adding
// a world to a node is adding a line here rather than editing every tool.
import * as classic from './worldgen.mjs'
import * as expanse from './worldgen-expanse.mjs'
import * as expanse2 from './worldgen-expanse2.mjs'
import * as expanse3 from './worldgen-expanse3.mjs'

const GENERATORS = {
  [classic.GENERATOR_ID]: classic,
  [expanse.GENERATOR_ID]: expanse,
  [expanse2.GENERATOR_ID]: expanse2,
  [expanse3.GENERATOR_ID]: expanse3,
}

// the founding, dispatched: each generator founds at its own calibrated
// scale unless the founder names one. The expanse's own founding also
// seals its geography, watchfire, and survey retunes into the genesis.
export function foundGenesis(genId, seed, rulesHash, anchorMs, W = 0, H = 0) {
  if (genId === expanse3.GENERATOR_ID)
    return expanse3.makeExpanse3Genesis(seed, rulesHash, anchorMs, W || 896, H || 512)
  if (genId === expanse2.GENERATOR_ID)
    return expanse2.makeExpanse2Genesis(seed, rulesHash, anchorMs, W || 640, H || 400)
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
