/**
 * test/engine.test.js — M0 Deterministic Core unit tests (node:test, no deps).
 * Run: npm test   (node --test test/)
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { segment, segmentWords, similarity } = require("../lib/engine/segment");
const { selectUnits, bruteForceSelect } = require("../lib/engine/select");
const { craftBoundaries, snapTime, silenceGaps, spanIsSilent } = require("../lib/engine/boundary");
const { lint, lintRepairLoop } = require("../lib/engine/lint");
const { rng, buildFixture, compile, interviewSentences } = require("../bench/fixtures");

/* ------------------------------ helpers ------------------------------ */

function wordsFrom(sentences, gap = 0.9) {
  return compile(sentences.map((t) => (typeof t === "string" ? { sp: "A", ch: "X", t } : t))).words;
}

/* ============================== Segmenter ============================== */

test("segmenter: splits on sentence punctuation + pause", () => {
  const words = wordsFrom(["This is the first thought.", "And here comes the second one."]);
  const units = segmentWords(words);
  assert.equal(units.length, 2);
  assert.match(units[0].text, /first thought\.$/);
  assert.match(units[1].text, /second one\.$/);
});

test("segmenter: splits on speaker change without punctuation", () => {
  const words = [
    { w: "so", s: 0, e: 0.2, speaker: "A" },
    { w: "then", s: 0.25, e: 0.45, speaker: "A" },
    { w: "really", s: 0.5, e: 0.7, speaker: "B" },
    { w: "yes", s: 0.75, e: 0.95, speaker: "B" },
  ];
  const units = segmentWords(words);
  assert.equal(units.length, 2);
  assert.equal(units[0].speaker, "A");
  assert.equal(units[1].speaker, "B");
});

test("segmenter: abbreviation guard — early period with tiny pause doesn't split", () => {
  const words = [
    { w: "Dr.", s: 0, e: 0.25 },
    { w: "Rao", s: 0.27, e: 0.5 },
    { w: "arrived", s: 0.52, e: 0.8 },
    { w: "today.", s: 0.82, e: 1.1 },
  ];
  const units = segmentWords(words);
  assert.equal(units.length, 1);
});

test("segmenter: force-splits oversized units at the biggest pause", () => {
  const words = [];
  let t = 0;
  for (let i = 0; i < 40; i++) {
    words.push({ w: "word" + i, s: t, e: t + 0.6 });
    t += i === 19 ? 1.4 : 0.62; // no punctuation; only one biggish gap — but below pauseSplit? 1.4 > 0.8 splits anyway
  }
  const units = segmentWords(words, { pauseSplit: 2.0, maxUnitDur: 15 });
  assert.ok(units.length >= 2, "should force split");
  for (const u of units) assert.ok(u.dur <= 16, `unit too long: ${u.dur}`);
});

test("segmenter: flags filler, false starts, retakes", () => {
  const words = wordsFrom([
    "Um, you know, like, honestly, yeah.",
    "Wait — let me redo that whole answer.",
    "We grew forty percent every month, right.",
    "We grew forty percent every month.",
    "Your customers never forgive silence.",
  ]);
  const units = segment(words);
  assert.ok(units[0].flags.includes("filler"), "filler flagged");
  assert.ok(units[1].flags.includes("falseStart"), "false start flagged");
  assert.ok(units[2].flags.includes("retake"), "earlier near-dup flagged as retake");
  assert.ok(!units[4].flags.includes("retake"), "clean line unflagged");
});

test("segmenter: pause map marks rambling next to disfluencies", () => {
  const words = wordsFrom(["Um, uh, you know, like, yeah.", "Here is the real content of the show."]);
  const units = segment(words);
  assert.equal(units[1].pauseBefore.kind, "rambling");
});

test("similarity: near-duplicates high, unrelated low", () => {
  assert.ok(similarity("we grew forty percent every month", "we grew forty percent every month right") > 0.8);
  assert.ok(similarity("we grew forty percent", "the database melted during the demo") < 0.2);
});

/* ============================== DP Selector ============================ */

function randomUnits(R, n) {
  const units = [];
  for (let i = 0; i < n; i++) {
    units.push({
      id: i,
      dur: 0.6 + R() * 6,
      score: Math.round(R() * 100),
      chapter: R() < 0.5 ? "C" + Math.floor(R() * 3) : undefined,
      mustKeep: R() < 0.1,
      hook: false,
      closing: false,
    });
  }
  return units;
}

test("DP selector matches brute force on random small cases (tighten)", () => {
  const R = rng(42);
  for (let trial = 0; trial < 25; trial++) {
    const n = 6 + Math.floor(R() * 8); // 6..13
    const units = randomUnits(R, n);
    const keepCount = 2 + Math.floor(R() * (n - 2));
    const opts = { mode: "tighten", keepCount, lambda: Math.floor(R() * 15) };
    const dp = selectUnits(units, opts);
    const bf = bruteForceSelect(units, opts);
    assert.ok(bf, "brute force found a feasible solution");
    assert.ok(
      Math.abs(dp.objective - bf.objective) < 1e-6,
      `trial ${trial}: dp=${dp.objective} bf=${bf.objective}`,
    );
  }
});

test("DP selector matches brute force on random small cases (condense)", () => {
  const R = rng(1337);
  for (let trial = 0; trial < 15; trial++) {
    const n = 6 + Math.floor(R() * 6);
    const units = randomUnits(R, n);
    const total = units.reduce((a, u) => a + u.dur, 0);
    const opts = {
      mode: "condense",
      targetDuration: total * (0.4 + R() * 0.5),
      lambda: Math.floor(R() * 12),
    };
    const dp = selectUnits(units, opts);
    const bf = bruteForceSelect(units, opts);
    assert.ok(bf, "feasible");
    assert.ok(
      Math.abs(dp.objective - bf.objective) < 1e-6,
      `trial ${trial}: dp=${dp.objective} bf=${bf.objective}`,
    );
  }
});

test("DP selector: locks always kept, coverage keeps chapter best", () => {
  const units = [
    { id: 0, dur: 5, score: 10, chapter: "A", mustKeep: true },
    { id: 1, dur: 5, score: 5, chapter: "A" },
    { id: 2, dur: 5, score: 90, chapter: "B" },
    { id: 3, dur: 5, score: 2, chapter: "C" }, // best (only) unit of C
    { id: 4, dur: 5, score: 80, chapter: "B" },
  ];
  const sel = selectUnits(units, { mode: "tighten", keepCount: 2, lambda: 0 });
  assert.ok(sel.keep[0], "locked unit kept");
  assert.ok(sel.keep[3], "chapter C's best kept despite low score (coverage)");
});

test("DP selector: lambda kills the keep/cut stutter", () => {
  // alternating high/low scores — with big lambda the optimizer prefers runs
  const units = [];
  for (let i = 0; i < 10; i++) units.push({ id: i, dur: 4, score: i % 2 ? 40 : 60 });
  const loose = selectUnits(units, { mode: "tighten", keepCount: 5, lambda: 0 });
  const tight = selectUnits(units, { mode: "tighten", keepCount: 5, lambda: 100 });
  assert.ok(tight.cuts <= loose.cuts, "high lambda produces fewer splices");
  assert.ok(tight.cuts <= 2, `expected contiguous keeps, got ${tight.cuts} cuts`);
});

test("DP selector: hook and closing are deliberate keeps", () => {
  const units = [
    { id: 0, dur: 4, score: 1, hook: true },
    { id: 1, dur: 4, score: 99 },
    { id: 2, dur: 4, score: 99 },
    { id: 3, dur: 4, score: 1, closing: true },
  ];
  const sel = selectUnits(units, { mode: "tighten", keepCount: 2, lambda: 0 });
  assert.ok(sel.keep[0] && sel.keep[3], "hook and closing kept even at low score");
});

/* ============================== Boundary craft ========================== */

test("boundary: snaps into silence, never inside a word", () => {
  const words = [];
  let t = 0;
  for (let i = 0; i < 20; i++) {
    words.push({ w: "w" + i, s: t, e: t + 0.28 });
    t += i % 5 === 4 ? 1.0 : 0.3; // silence every 5 words
  }
  const segs = [{ start: 1.55, end: 4.0 }]; // start lands mid-word
  const out = craftBoundaries(segs, words, { duration: t });
  for (const s of out) {
    for (const b of [s.start, s.end]) {
      for (const w of words) {
        assert.ok(!(w.s + 0.01 < b && b < w.e - 0.01), `boundary ${b} inside word ${w.s}-${w.e}`);
      }
    }
  }
});

test("boundary: J/L extensions never cover speech", () => {
  const words = [
    { w: "a", s: 1.0, e: 1.3 },
    { w: "b", s: 1.35, e: 1.6 },
    { w: "c", s: 3.0, e: 3.3 },
  ];
  const segs = [{ start: 2.0, end: 2.8 }];
  const [s] = craftBoundaries(segs, words, { duration: 5 });
  assert.ok(spanIsSilent(s.audioStart, s.start, words), "J region silent");
  assert.ok(spanIsSilent(s.end, s.audioEnd, words), "L region silent");
  assert.ok(s.audioStart <= s.start && s.audioEnd >= s.end);
});

test("boundary: prefers a scene cut inside the snap window", () => {
  const words = [
    { w: "a", s: 0, e: 0.3 },
    { w: "b", s: 2.0, e: 2.3 },
  ];
  const gaps = silenceGaps(words, 5);
  const snapped = snapTime(1.0, gaps, { minSilence: 0.12, snapWindow: 0.6, edgePad: 0.02 }, [1.2]);
  assert.ok(Math.abs(snapped - 1.2) < 1e-9, `snapped to scene cut, got ${snapped}`);
});

/* ============================== Edit Linter ============================= */

function unitsFromFixture(seed = 3) {
  const fx = buildFixture("interview", seed);
  const units = segment(fx.words);
  const { labelUnits } = require("../bench/fixtures");
  for (const { unit, meta } of labelUnits(units, fx.spans)) {
    unit.chapter = meta ? meta.ch : undefined;
    unit.hook = !!(meta && meta.hook);
    unit.closing = !!(meta && meta.closing);
    unit.score = meta && meta.junk ? 5 : 70;
    unit.truthJunk = !!(meta && meta.junk);
  }
  return units;
}

test("linter: clean edit produces zero repairable findings", () => {
  const units = unitsFromFixture();
  const keep = units.map((u) => !u.truthJunk); // the perfect edit
  const findings = lint(units, keep);
  const repairable = findings.filter((f) => f.repair);
  assert.equal(repairable.length, 0, JSON.stringify(findings, null, 2));
});

test("linter: detects injected orphaned reference and repairs it", () => {
  const units = unitsFromFixture();
  const keep = units.map((u) => !u.truthJunk);
  // cut the setup right before the "That's why..." line
  const orphanIdx = units.findIndex((u) => /^that'?s why/i.test(u.text));
  assert.ok(orphanIdx > 0, "fixture has a That's-why line");
  // find previous speech unit and cut it
  keep[orphanIdx - 1] = false;
  const findings = lint(units, keep);
  assert.ok(findings.some((f) => f.rule === "orphanedReference"), "orphan detected");
  const loop = lintRepairLoop(units, keep);
  assert.ok(loop.keep[orphanIdx - 1], "repair restored the antecedent");
  assert.ok(!loop.findings.some((f) => f.rule === "orphanedReference"), "re-lint clean");
});

test("linter: detects a coverage gap and restores the chapter's best unit", () => {
  const units = unitsFromFixture();
  const keep = units.map((u) => !u.truthJunk);
  for (let i = 0; i < units.length; i++) if (units[i].chapter === "CRISIS") keep[i] = false;
  const findings = lint(units, keep);
  assert.ok(findings.some((f) => f.rule === "coverageGap"), "gap detected");
  const loop = lintRepairLoop(units, keep);
  const criIdx = units.map((u, i) => i).filter((i) => units[i].chapter === "CRISIS");
  assert.ok(criIdx.some((i) => loop.keep[i]), "one CRISIS unit restored");
});

test("linter: detects cut hook / cut closer and repairs both", () => {
  const units = unitsFromFixture();
  const keep = units.map((u) => !u.truthJunk);
  const hi = units.findIndex((u) => u.hook);
  const ci = units.findIndex((u) => u.closing);
  keep[hi] = false;
  keep[ci] = false;
  const loop = lintRepairLoop(units, keep);
  assert.ok(loop.keep[hi], "hook restored");
  assert.ok(loop.keep[ci], "closer restored");
});

test("linter: kept question with cut answer is a dropped payoff", () => {
  const units = unitsFromFixture();
  const keep = units.map((u) => !u.truthJunk);
  const qIdx = units.findIndex((u) => /\?$/.test(u.text.trim()) && keep[units.indexOf(u)]);
  assert.ok(qIdx >= 0);
  // cut the answer (next speech unit from the other speaker)
  keep[qIdx + 1] = false;
  const findings = lint(units, keep);
  assert.ok(findings.some((f) => f.rule === "droppedPayoff"), "dropped payoff detected");
});

test("linter: repair is monotone — never cuts, terminates ≤ maxPasses", () => {
  const units = unitsFromFixture();
  const keep = units.map((u) => !u.truthJunk);
  keep[0] = false; // cut hook
  const before = keep.filter(Boolean).length;
  const loop = lintRepairLoop(units, keep);
  const after = loop.keep.filter(Boolean).length;
  assert.ok(after >= before, "restore-only");
  assert.ok(loop.passes <= 2, "fixpoint within 2 passes");
});

/* ============================== Decision loop =========================== */

const { decide } = require("../lib/engine");

test("decide: condense repairs narrative findings AND holds the duration target", () => {
  const fx = buildFixture("interview", 11);
  const units = segment(fx.words);
  const { labelUnits } = require("../bench/fixtures");
  const R2 = rng(11 * 7919 + 13);
  for (const { unit, meta } of labelUnits(units, fx.spans)) {
    unit.chapter = meta ? meta.ch : undefined;
    unit.hook = !!(meta && meta.hook);
    unit.closing = !!(meta && meta.closing);
    unit.truthJunk = !!(meta && meta.junk);
  }
  for (const u of units) u.score = u.flags.length ? 5 : 55 + R2() * 40;
  const target = units.filter((u) => !u.truthJunk).reduce((a, u) => a + u.dur, 0) * 0.8;
  const out = decide(units, { mode: "condense", targetDuration: target, lambda: 6, duration: fx.duration });
  assert.ok(out.keptDur <= target * 1.1, `kept ${out.keptDur} vs target ${target}`);
  assert.ok(!out.findings.some((f) => f.repair), "no repairable findings remain");
});
