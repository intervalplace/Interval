// Interval terminal window v0.5 — Layer 3: the first of many windows.
// Renders the world as ASCII tiles from an IntervalClient. Built ONLY on
// the SDK: it imports nothing from the node or engine. Any other window
// (web, pixel-art, spreadsheet) sits at exactly this layer.

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', gray: '\x1b[90m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
}

const W = 14, H = 8

export function renderFrame(client) {
  const grid = Array.from({ length: H }, () => Array(W).fill(`${C.dim}·${C.reset}`))

  for (const n of client.nodesAt()) {
    if (n.x < 0 || n.x >= W || n.y < 0 || n.y >= H) continue
    const depleted = n.depletedUntil > client.tick
    const glyphs = {
      'tree': depleted ? `${C.gray}t${C.reset}` : `${C.green}T${C.reset}`,
      'rock': depleted ? `${C.gray}.${C.reset}` : `${C.gray}▲${C.reset}`,
      'fishing-spot': depleted ? `${C.gray},${C.reset}` : `${C.cyan}≈${C.reset}`,
      'campfire': `\x1b[31m♨${C.reset}`,
    }
    const glyph = glyphs[n.type] ?? '?'
    grid[n.y][n.x] = glyph
  }

  for (const [id, m] of Object.entries(client.world.mobs ?? {})) {
    if (m.hp > 0 && m.x >= 0 && m.x < W && m.y >= 0 && m.y < H) grid[m.y][m.x] = `\x1b[31mg${C.reset}`
  }

  const legends = []
  for (const p of client.players()) {
    if (p.x < 0 || p.x >= W || p.y < 0 || p.y >= H) continue
    const isMe = p.pid === client.identity.playerId
    grid[p.y][p.x] = `${isMe ? C.yellow : C.cyan}@${C.reset}`
    const doing = p.action?.type === 'gather' ? ' (gathering)' : ''
    legends.push(`  ${isMe ? C.yellow : C.cyan}@${C.reset} ${p.display}${doing}`)
  }

  const me = client.me
  const lines = []
  lines.push(`${C.bold}INTERVAL${C.reset}  world ${client.worldId}…  tick ${client.tick}  peers ${client.peers}`)
  lines.push('┌' + '─'.repeat(W * 2 + 1) + '┐')
  for (const row of grid) lines.push('│ ' + row.join(' ') + ' │')
  lines.push('└' + '─'.repeat(W * 2 + 1) + '┘')
  lines.push(...legends)
  if (me) {
    lines.push(`  you: ${me.name ?? '(unnamed)'}  hp ${me.hp}/${client.level('hitpoints')}  atk ${client.level('attack')} def ${client.level('defence')} wc ${client.level('woodcutting')} min ${client.level('mining')} fish ${client.level('fishing')} cook ${client.level('cooking')}  inv ${client.inventoryCount()}/28`)
  }
  return lines.join('\n')
}
