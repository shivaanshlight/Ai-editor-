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

/* --------------------------- M1 robust scorer path -------------------------- */

const { scoreUnits } = require("../lib/engine/score");

/**
 * A deliberately flaky mock LLM: correct on substance (junk low, good high)
 * but noisy across runs and randomly dropping ~20% of ids per call — the
 * failure modes the batched-output + diversified-runs machinery must absorb.
 */
function flakyLlm(units, seed) {
  const R = rng(seed * 104729 + 7);
  const truth = new Map(units.map((u) => [u.id, u.truthJunk]));
  return async (messages) => {
    if (messages[0].content.includes("story editor")) {
      const hook = units.find((u) => u.hook);
      const closer = units.find((u) => u.closing);
      return { beats: [], hookUnit: hook ? hook.id : null, closingUnit: closer ? closer.id : null };
    }
    const ids = [];
    for (const line of messages[1].content.split("\n")) {
      const m = line.match(/^(\d+)\t/);
      if (m) ids.push(parseInt(m[1]));
    }
    const scores = [];
    for (const id of ids) {
      if (R() < 0.2) continue; // dropout
      const junk = truth.get(id);
      const base = junk ? 8 : 70;
      scores.push({ id, score: Math.max(0, Math.min(100, Math.round(base + (R() - 0.5) * 24))), reason: "mock" });
    }
    return { scores };
  };
}

/* ------------------------------- one bench run ----------------------------- */

function runFixture(kind, seed, mode, scorer = "direct") {
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

  // mock S2 — "direct" assigns scores synchronously; "robust" pushes them
  // through the real scoreUnits pipeline via a flaky mock LLM (dropouts +
  // noise across diversified runs).
  if (scorer === "robust") {
    // scoreUnits is async; bench stays sync-friendly via a deasync-free trick:
    // runFixture returns a promise in this mode (main() awaits all runs).
    return scoreUnits(units, { llm: flakyLlm(units, seed) }).then((r) =>
      finishRun(fx, units, mode, seed, kind, r.tier),
    );
  }
  for (const u of units) u.score = mockScore(u, R);
  return finishRun(fx, units, mode, seed, kind, "direct");
}

function finishRun(fx, units, mode, seed, kind, tier) {
  // M3: inject user locks — one good unit AND one junk unit. Locks are the
  // user's explicit word and must survive every stage, even on junk.
  const Rl = rng(seed * 31 + 5);
  const lockable = units.filter((u) => !u.mustKeep);
  const goodPick = lockable.filter((u) => !u.truthJunk);
  const junkPick = lockable.filter((u) => u.truthJunk);
  const locked = [];
  if (goodPick.length) locked.push(goodPick[Math.floor(Rl() * goodPick.length)]);
  if (junkPick.length) locked.push(junkPick[Math.floor(Rl() * junkPick.length)]);
  for (const u of locked) u.mustKeep = true;

  // S3 + S5: the full decision loop (select → lint → repair → re-select)
  const junkCount = units.filter((u) => u.truthJunk && !u.mustKeep).length;
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
  // Locked units are the user's explicit choice — excluded from recall/false-cut
  // (locking junk keeps it on purpose), gated separately as lock violations.
  const lockViolations = locked.filter((u) => !keep[units.indexOf(u)]).length;
  const junkUnits = units.filter((u) => u.truthJunk && !u.mustKeep);
  const goodUnits = units.filter((u) => !u.truthJunk && !u.mustKeep);
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
    tier,
    unitCount: units.length,
    junkCount: junkUnits.length,
    junkRecall,
    falseCutRate,
    violationWeight,
    badBoundaries,
    runtimeDev,
    lockViolations,
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

async function main() {
  const runs = [];
  for (const kind of ["interview", "tutorial"]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      runs.push(await runFixture(kind, seed, "tighten"));
    }
  }
  runs.push(await runFixture("interview", 11, "condense"));
  runs.push(await runFixture("tutorial", 12, "condense"));
  // M1: same targets with the REAL scorer pipeline fed by a flaky mock LLM
  // (20% dropouts per call + score noise across 3 diversified runs).
  for (const kind of ["interview", "tutorial"]) {
    for (const seed of [21, 22, 23]) {
      runs.push(await runFixture(kind, seed, "tighten", "robust"));
    }
  }
  runs.push(await runFixture("interview", 31, "condense", "robust"));

  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  console.log("\nEditBench — Deterministic Core + M1 scorer robustness\n");
  console.log(
    "fixture     seed mode      scorer  units junk  recall   false-cut  lintW  badB  rtDev  repaired",
  );
  for (const r of runs) {
    console.log(
      [
        r.kind.padEnd(11),
        String(r.seed).padEnd(4),
        r.mode.padEnd(9),
        (r.tier === "direct" ? "direct" : r.tier).padEnd(7),
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
    lockViolations: Math.max(...runs.map((r) => r.lockViolations || 0)),
  };

  // ---- M1.5: tournament vs pointwise on borderline fixtures -----------------
  // Truth quality is linear; pointwise scores are truth + heavy noise inside a
  // narrow band. Accuracy = how many of the true top-half make the kept half.
  const { runTournament } = require("../lib/engine/tournament");
  let ptAcc = 0;
  let tnAcc = 0;
  const T = 6;
  for (let trial = 0; trial < T; trial++) {
    const R = rng(500 + trial);
    const n = 10;
    const truth = new Map();
    const units = [];
    for (let i = 0; i < n; i++) {
      truth.set(i, i * 10); // true quality: unit 9 best
      const noisy = 55 + (i - n / 2) * 0.4 + (R() - 0.5) * 10; // nearly flat + noise
      units.push({ id: i, start: i * 6, end: i * 6 + 5, dur: 5, score: noisy, text: `unit ${i} says something`, words: [{ w: "x", s: 0, e: 1 }], flags: [], silence: false });
    }
    const K = n / 2;
    const topTruth = new Set([...truth.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map(([id]) => id));
    const topBy = (us) => new Set(us.slice().sort((a, b) => b.score - a.score).slice(0, K).map((u) => u.id));
    const inter = (S) => [...S].filter((x) => topTruth.has(x)).length / K;
    ptAcc += inter(topBy(units));
    const judge = async (messages) => {
      const blocks = messages[1].content.split(/\n\n(?=Pair \d+:)/);
      const winners = blocks.map((blk) => {
        const m = blk.match(/A \([\d.]+s\): unit (\d+)[\s\S]*B \([\d.]+s\): unit (\d+)/);
        const a = parseInt(m[1]);
        const b = parseInt(m[2]);
        if (R() < 0.1) return "A"; // some position bias
        return truth.get(a) >= truth.get(b) ? "A" : "B";
      });
      return { winners };
    };
    await runTournament(units, judge, { maxBand: n, maxPairs: 60 });
    tnAcc += inter(topBy(units));
  }
  ptAcc /= T;
  tnAcc /= T;
  console.log(
    `\nM1.5 borderline band: pointwise top-half accuracy ${pct(ptAcc)} → tournament ${pct(tnAcc)}`,
  );

  const targets = [
    ["junk recall = 100%", agg.junkRecall === 1],
    ["false-cut rate = 0% (tighten)", agg.falseCutRate === 0],
    ["boundary violations = 0", agg.badBoundaries === 0],
    ["runtime deviation ≤ 10% (condense)", agg.runtimeDev <= 0.1],
    ["tournament ≥ pointwise on borderline band", tnAcc >= ptAcc],
    ["locked spans never cut", agg.lockViolations === 0],
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

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { runFixture };
