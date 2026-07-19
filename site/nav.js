// Shared header: nav, marking the current page.
//
// Five doors, not six, and short words. "New Player Guide" was the widest
// thing on the bar by a distance and the file behind it is called quickstart;
// Source moved to the foot of every page, where the same link already lived.
// Six long labels wrapped to three rows on a phone and took a third of the
// screen before the world's own name appeared.
document.body.insertAdjacentHTML('afterbegin', `
<div class="page">
  <nav class="stone">
    <a href="/">Interval</a>
    <a href="/play">Play</a>
    <a href="/quickstart">Guide</a>
    <a href="/manual">Manual</a>
    <a href="/hiscores">Hiscores</a>
  </nav>
</div>`)
const here = location.pathname.replace(/\/$/, '') || '/'
document.querySelectorAll('nav a').forEach(a => {
  if (a.getAttribute('href') === here) a.classList.add('here')
})

// the source belongs at the end of the reading, not at the top of it
document.body.insertAdjacentHTML('beforeend', `
<div class="page">
  <p class="footlink">the world's constitution and every line that runs it:
    <a href="https://github.com/intervalplace/interval" id="ghlink">github.com/intervalplace/interval</a></p>
</div>`)
