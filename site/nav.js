// shared header: wordmark + nav, marks the current page
document.body.insertAdjacentHTML('afterbegin', `
<div class="page">
  <nav class="stone">
    <a href="/">Interval</a>
    <a href="/play">Play</a>
    <a href="/quickstart">New Player Guide</a>
    <a href="/manual">The Manual</a>
    <a href="/hiscores">Hiscores</a>
    <a href="https://github.com/intervalplace/interval" id="ghlink">Source</a>
  </nav>
</div>`)
const here = location.pathname.replace(/\/$/, '') || '/'
document.querySelectorAll('nav a').forEach(a => {
  if (a.getAttribute('href') === here) a.classList.add('here')
})
