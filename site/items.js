const ICON_CV = {}
// The marks beside each tenet are not decoration drawn for a website. They are
// the same sprites the flat window paints into a citizen's pack, lifted from
// window-web.html unchanged, so the things promised here are the things you
// will actually be holding. Art is the one layer this world does not make law,
// which is exactly why it can be shared freely between the two.
function itemSprite(item) {
  if (ICON_CV[item]) return ICON_CV[item]
  const c = document.createElement('canvas'); c.width = 32; c.height = 32
  const g = c.getContext('2d')
  const pl = (pts, fill, stroke) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
    g.closePath(); g.fillStyle = fill; g.fill()
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.4; g.stroke() } }
  const fishBody = (belly, back) => {
    pl([[4,16],[10,10],[20,9],[26,14],[26,18],[20,23],[10,22]], belly, back)
    pl([[26,14],[31,9],[31,23],[26,18]], back)
    g.fillStyle = '#10100c'; g.fillRect(9, 14, 2, 2)
  }
  switch (item) {
    case 'logs':
      pl([[4,20],[26,12],[29,17],[7,25]], '#8a5a2a', '#4a2f14')
      g.fillStyle = '#c9a86a'; g.beginPath(); g.ellipse(27.4, 14.5, 2.8, 3.6, -0.35, 0, 7); g.fill()
      g.strokeStyle = '#8a5a2a'; g.lineWidth = 1; g.beginPath(); g.ellipse(27.4, 14.5, 1.3, 1.8, -0.35, 0, 7); g.stroke()
      g.strokeStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.moveTo(8, 21); g.lineTo(24, 15); g.stroke(); break
    case 'sigil':
      g.fillStyle = '#1c2233'; g.beginPath(); g.arc(16, 16, 11, 0, 7); g.fill()
      g.strokeStyle = '#8ce0ff'; g.lineWidth = 1.6
      g.beginPath(); g.arc(16, 16, 7, 0.6, 5.2); g.stroke()
      g.fillStyle = '#8ce0ff'; g.fillRect(14.6, 8, 2.8, 2.8); break
    default:
      g.fillStyle = '#6e5433'; g.fillRect(8, 8, 16, 16)
    case 'magic-stone':
      pl([[16,3],[26,16],[16,29],[6,16]], '#8ce0ff', '#2a7d9e')
      pl([[16,3],[16,29],[6,16]], 'rgba(255,255,255,.28)')
      g.fillStyle = '#e0f6ff'; g.fillRect(14, 12, 3, 3); break
    case 'bronze-hatchet':
      g.fillStyle = '#5c4023'; g.save(); g.translate(16, 16); g.rotate(0.7); g.fillRect(-1.8, -3, 3.6, 17); g.restore()
      pl([[16,4],[25,7],[24,15],[14,12]], '#c9862a', '#6b4515'); break
    case 'ale':
      g.fillStyle = '#6b5a3a'; g.fillRect(11, 12, 12, 15) // tankard
      g.fillStyle = '#caa23e'; g.fillRect(12, 14, 10, 12)  // ale
      g.fillStyle = '#f2ead2'; g.fillRect(12, 12, 10, 3)   // foam
      g.strokeStyle = '#4a3f28'; g.lineWidth = 2; g.strokeRect(11, 12, 12, 15)
      g.fillStyle = '#6b5a3a'; g.fillRect(23, 15, 3, 8); break // handle
    case 'bronze-dagger': case 'star-dagger': {
      const star = item.startsWith('star-')
      const blade = star ? '#c8f0ff' : '#e4ddc9', edge = star ? '#54a8cc' : '#9a927e'
      pl([[15,26],[17,26],[18,12],[16,5],[14,12]], blade, edge)   // short leaf blade
      g.fillStyle = '#5c4023'; g.fillRect(13.5, 25.5, 5, 2.4)      // guard
      g.fillStyle = '#3b2a16'; g.fillRect(15, 27.6, 2, 3.4)        // stub grip
      if (star) { g.fillStyle = 'rgba(120,220,255,.35)'; g.fillRect(15.4, 8, 1.2, 16) }
      break }
    case 'bronze-spear': case 'star-spear': {
      const star = item.startsWith('star-')
      const head = star ? '#c8f0ff' : '#e4ddc9', edge = star ? '#54a8cc' : '#9a927e'
      g.strokeStyle = '#7a5124'; g.lineWidth = 2.6                 // the long haft
      g.beginPath(); g.moveTo(9, 30); g.lineTo(21, 8); g.stroke()
      g.strokeStyle = '#5c3d1b'; g.lineWidth = 1
      g.beginPath(); g.moveTo(9, 30); g.lineTo(21, 8); g.stroke()
      pl([[21,8],[24,1],[26,9],[22,11]], head, edge)               // narrow point
      g.fillStyle = '#4a4a52'; g.fillRect(18.5, 10.5, 4.6, 2.2)    // collar
      if (star) { g.fillStyle = 'rgba(120,220,255,.4)'; g.fillRect(22.6, 3, 1, 6) }
      break }
    case 'bronze-maul': case 'star-maul': {
      const star = item.startsWith('star-')
      const head = star ? '#bfe6f5' : '#d8d1bc', edge = star ? '#4c98bb' : '#8b846f'
      g.strokeStyle = '#6b4720'; g.lineWidth = 3                   // heavy haft
      g.beginPath(); g.moveTo(11, 30); g.lineTo(18, 14); g.stroke()
      pl([[9,15],[20,9],[25,15],[23,20],[12,21]], head, edge)      // the great block
      g.fillStyle = edge; g.fillRect(12.5, 12.5, 3, 7)             // banded face
      if (star) { g.fillStyle = 'rgba(140,225,255,.4)'; g.fillRect(19, 11, 2, 8) }
      g.fillStyle = '#3b2a16'; g.fillRect(9.5, 28, 3.4, 3.4)       // butt
      break }
    case 'horn-bow': {
      g.strokeStyle = '#6b5238'; g.lineWidth = 3.4                 // recurved horn limbs
      g.beginPath(); g.arc(13, 16, 11.5, -1.35, 1.35); g.stroke()
      g.strokeStyle = '#3f3020'; g.lineWidth = 1.2
      g.beginPath(); g.arc(13, 16, 11.5, -1.35, 1.35); g.stroke()
      g.strokeStyle = '#c9a86a'; g.lineWidth = 2.4                 // horn tips, paler
      for (const a of [-1.35, 1.35]) {
        g.beginPath(); g.arc(13, 16, 11.5, a - 0.28, a); g.stroke()
      }
      g.strokeStyle = '#efe7cf'; g.lineWidth = 1                   // the string
      g.beginPath(); g.moveTo(13 + Math.cos(-1.35) * 11.5, 16 + Math.sin(-1.35) * 11.5)
      g.lineTo(13 + Math.cos(1.35) * 11.5, 16 + Math.sin(1.35) * 11.5); g.stroke()
      g.fillStyle = '#8a6a3a'; g.fillRect(23, 14, 3, 4)            // the grip
      break }
    case 'old-chain': {
      g.strokeStyle = '#8a8a82'; g.lineWidth = 2
      for (let li = 0; li < 5; li++) {
        const lx = 8 + li * 4.2, ly = 24 - li * 4.2
        g.beginPath(); g.ellipse(lx, ly, 2.6, 3.4, -0.78, 0, 7); g.stroke()
      }
      g.strokeStyle = '#6b6b62'; g.lineWidth = 1
      g.beginPath(); g.ellipse(8, 24, 2.6, 3.4, -0.78, 0, 7); g.stroke()
      break }
    case 'cooked-fish': fishBody('#d9a05e', '#96622a'); break
  }
  ICON_CV[item] = c
  return c
}

// paint every <i data-item="..."> on the page
document.addEventListener('DOMContentLoaded', () => {
  for (const el of document.querySelectorAll('[data-item]')) {
    try {
      const c = itemSprite(el.dataset.item)
      const shown = c.cloneNode(true)
      shown.getContext('2d').drawImage(c, 0, 0)
      shown.className = 'itemicon'
      el.replaceWith(shown)
    } catch { el.replaceWith(document.createTextNode('')) }
  }
})
