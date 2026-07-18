// brew-sim: Brewing has TWO clocks. This models the interaction so we pick a
// target that's honest about both. Pots ferment on world-ticks (offline too),
// so the binding constraint is how often you TEND, not raw fermentation.
const XP99 = 13034431, POTS = 4, TICK_S = 0.6;
const TEND_SECONDS = 60; // collect+restart 4 clustered pots at the brewhouse (~1 min)

console.log("KEY DYNAMIC: a pot ferments ONCE, then sits ready until you collect+restart it.");
console.log("So batches/day = (tends/day) x pots — as long as ferment < your tending gap.\n");

console.log("=== batches/day by tending cadence (ferment must be < the gap) ===");
for (const tends of [2, 3, 4, 6]) {
  const gapH = 24 / tends;
  console.log(`  tend ${tends}x/day (every ${gapH}h): ${tends * POTS} batches/day  (needs ferment < ${gapH}h — our 30-60min qualifies)`);
}

console.log("\n=== if we chase '70 ACTIVE hours' (tending time only) ===");
const activeHrsTarget = 70;
const tendsNeeded = activeHrsTarget * 3600 / TEND_SECONDS;      // sessions to accumulate 70h of tending
const batches = tendsNeeded * POTS;
const xpPerBatch_active = XP99 / batches;
console.log(`  70h of tending @ ${TEND_SECONDS}s/session = ${Math.round(tendsNeeded).toLocaleString()} sessions = ${Math.round(batches).toLocaleString()} batches`);
console.log(`  => XP/batch would be ${Math.round(xpPerBatch_active)} (tiny), and at 4 tends/day that's ${Math.round(tendsNeeded/4).toLocaleString()} DAYS wall-clock. Absurd.`);
console.log("  Lesson: tending is ~seconds/batch, so 'active hours' forces thousands of wall-clock days.\n");

console.log("=== the honest target: WALL-CLOCK days to 99 (at a realistic 4 tends/day => 16 batches/day) ===");
const perDay = 4 * POTS;
console.log("  days | XP/batch needed | active tending h | total batches");
for (const days of [20, 30, 45, 60, 90]) {
  const totalBatches = perDay * days;
  const xpBatch = XP99 / totalBatches;
  const activeH = (totalBatches * TEND_SECONDS) / 3600;
  console.log(`  ${String(days).padStart(4)} | ${String(Math.round(xpBatch)).padStart(15)} | ${activeH.toFixed(1).padStart(16)} | ${totalBatches}`);
}
console.log("\n  read: at 16 batches/day, mastery is a matter of WEEKS of regular brewing,");
console.log("  the active tending totals only a handful of hours, and XP/batch is the dial.");
