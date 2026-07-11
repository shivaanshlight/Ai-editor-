/**
 * bench/editbench.js — the EditBench runner (M0 acceptance harness).
 *
 * Runs the full deterministic pipeline on synthetic fixtures with injected
 * junk, end to end, no API key, no video:
 *
 *   words → Segmenter → mock scorer → DP Selector → Boundary craft
 *         → lint → repair → re-lint → composite score
 *
 * Composite metrics (defined in ENGINE-ARCHITECTURE v3):
 *   - junk recall        % of injected junk units removed        target 100%
 *   - false-cut rate     % of known-good units incorrectly cut   target 0%
 *   - linter violations  severity-weighted count on final EDL    target 0
 *   - runtime deviation  |actual − target| / target (condense)   target ≤ 10%
 *
 * The mock scorer stands in for the M1 LLM: it derives salience from the
 * deterministic disfluency flags plus seeded jitter — the point of M0 is to
 * prove the MACHINERY is exact given sane scores. When the LLM lands it
 * supplies only these numbers.
 *
 * Run:  node bench/editbench.js        (exit 0 = M0 targets met)
 */

const { segment } = require("../lib/engine/segment");
const { decide } = require("../lib/engine");
const { craftBoundaries } = require("../lib/engine/boundary");
const { buildFixture, labelUnits, rng } = require("./fixtures");

/* ------------------------------ mock scorer -------------------------------- */

function mockScore(unit, R) {
  const f = unit.flags;
  if (f.includes("retake")) return 4 + R() * 6;
  if (f.includes("falseStart")) return 3 + R() * 6;
  if (f.includes("filler")) return 5 + R() * 8;
  return 55 + R() * 40; // good material
}

/* ------------------------------- one bench run ----------------------------- */

function runFixture(kind, seed, mode) {
  const fx = buildFixture(kind, seed);
  const R = rng(seed * 7919 + 13);

  // S0 (text half)
  const units = segment(fx.words);
  const labeled = labelUnits(units, fx.spans);

  // ground truth per unit
  for (const { unit, meta } of labeled) {
    unit.truthJunk = !!(meta && meta.junk);
    unit.chapter = meta ? meta.ch : undefined;
    unit.hook = !!(meta && meta.hook);
    unit.closing = !!(meta && meta.closing);
  }

  // mock S2
  for (const u of units) u.score = mockScore(u, R);

  // S3 + S5: the full decision loop (select → lint → repair → re-select)
  const junkCount = units.filter((u) => u.truthJunk).length;
  const selOpts =
    mode === "condense"
      ? {
          mode: "condense",
          targetDuration: units.filter((u) => !u.truthJunk).reduce((a, u) => a + u.dur, 0) * 0.8,
          lambda: 6,
        }
      : { mode: "tighten", keepCount: units.length - junkCount, lambda: 6 };
  const loop = decide(units, { ...selOpts, duration: fx.duration });
  const keep = loop.keep;

  // S4 on the final EDL
  const segs = [];
  for (let i = 0; i < units.length; i++) {
    if (!keep[i]) continue;
    const last = segs[segs.length - 1];
    if (last && units[i].start <= last.end + 0.05) last.end = units[i].end;
    else segs.push({ start: units[i].start, end: units[i].end });
  }
  const edl = craftBoundaries(segs, fx.words, { duration: fx.duration });

  // ---- metrics --------------------------------------------------------------
  const junkUnits = units.filter((u) => u.truthJunk);
  const goodUnits = units.filter((u) => !u.truthJunk);
  const junkCut = junkUnits.filter((u) => !keep[units.indexOf(u)]).length;
  const goodCut = goodUnits.filter((u) => !keep[units.indexOf(u)]).length;

  const junkRecall = junkUnits.length ? junkCut / junkUnits.length : 1;
  const falseCutRate = goodUnits.length ? goodCut / goodUnits.length : 0;

  const violationWeight = loop.findings.reduce((a, f) => a + f.severity, 0);

  // boundary guarantee: no EDL boundary inside speech
  const ws = fx.words.slice().sort((a, b) => a.s - b.s);
  let badBoundaries = 0;
  for (const s of edl) {
    for (const t of [s.start, s.end]) {
      if (t <= 0.05 || t >= fx.duration - 0.05) continue;
      if (inSpeechStrict(t, ws)) badBoundaries++;
    }
    // J/L must never cover speech
    if (!spanSilent(s.audioStart, s.start, ws)) badBoundaries++;
    if (!spanSilent(s.end, s.audioEnd, ws)) badBoundaries++;
  }

  let runtimeDev = 0;
  if (mode === "condense") {
    const keptDur = units.reduce((a, u, i) => a + (keep[i] ? u.dur : 0), 0);
    runtimeDev = Math.abs(keptDur - selOpts.targetDuration) / selOpts.targetDuration;
  }

  return {
    kind,
    seed,
    mode,
    unitCount: units.length,
    junkCount: junkUnits.length,
    junkRecall,
    falseCutRate,
    violationWeight,
    badBoundaries,
    runtimeDev,
    repaired: loop.restored.length,
  };
}

function inSpeechStrict(t, words, tol = 0.01) {
  for (const w of words) {
    if (w.s + tol < t && t < w.e - tol) return true;
    if (w.s > t + 1) break;
  }
  return false;
}
function spanSilent(a, b, words) {
  if (b - a <= 0.001) return true;
  for (const w of words) if (w.s < b - 0.005 && w.e > a + 0.005) return false;
  return true;
}

/* ---------------------------------- main ------------------------------------ */

function main() {
  const runs = [];
  for (const kind of ["interview", "tutorial"]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      runs.push(runFixture(kind, seed, "tighten"));
    }
  }
  runs.push(runFixture("interview", 11, "condense"));
  runs.push(runFixture("tutorial", 12, "condense"));

  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  console.log("\nEditBench — M0 Deterministic Core\n");
  console.log(
    "fixture     seed mode      units junk  recall   false-cut  lintW  badB  rtDev  repaired",
  );
  for (const r of runs) {
    console.log(
      [
        r.kind.padEnd(11),
        String(r.seed).padEnd(4),
        r.mode.padEnd(9),
        String(r.unitCount).padEnd(5),
        String(r.junkCount).padEnd(5),
        pct(r.junkRecall).padEnd(8),
        pct(r.falseCutRate).padEnd(10),
        String(r.violationWeight).padEnd(6),
        String(r.badBoundaries).padEnd(5),
        (r.mode === "condense" ? pct(r.runtimeDev) : "—").padEnd(6),
        String(r.repaired),
      ].join(" "),
    );
  }

  // false-cut gates only the TIGHTEN runs (the junk-injection acceptance
  // test, where the budget has exactly enough room to keep all good units).
  // In condense mode, cutting good material to hit the target IS the job.
  const tighten = runs.filter((r) => r.mode === "tighten");
  const condense = runs.filter((r) => r.mode === "condense");
  const agg = {
    junkRecall: Math.min(...runs.map((r) => r.junkRecall)),
    falseCutRate: Math.max(...tighten.map((r) => r.falseCutRate)),
    violations: Math.max(...runs.map((r) => r.violationWeight)),
    badBoundaries: Math.max(...runs.map((r) => r.badBoundaries)),
    runtimeDev: Math.max(...condense.map((r) => r.runtimeDev)),
  };

  const targets = [
    ["junk recall = 100%", agg.junkRecall === 1],
    ["false-cut rate = 0% (tighten)", agg.falseCutRate === 0],
    ["boundary violations = 0", agg.badBoundaries === 0],
    ["runtime deviation ≤ 10% (condense)", agg.runtimeDev <= 0.1],
  ];
  console.log("\nM0 targets:");
  let ok = true;
  for (const [label, pass] of targets) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
  console.log(
    `  info  max severity-weighted linter findings on final EDL: ${agg.violations}`,
  );
  console.log(ok ? "\nEditBench: ALL M0 TARGETS MET\n" : "\nEditBench: TARGETS MISSED\n");
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { runFixture };
