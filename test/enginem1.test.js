/**
 * test/engine-m1.test.js — M1 tests: S0 audio signals + S2 scorer + plan glue.
 * Run: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const {
  zScorePerSpeaker,
  energyPerUnit,
  snrPerUnit,
  sceneMap,
  markShotBoundaries,
  upgradePauses,
} = require("../lib/engine/analyze");
const { scoreUnits, mergeRuns, applyScores, heuristicScores } = require("../lib/engine/score");
const { enginePlan } = require("../lib/engine/plan");
const { buildFixture } = require("../bench/fixtures");

/* ------------------------------ S0 signals ------------------------------- */

function mkUnit(id, start, end, speaker, flags = []) {
  return { id, start, end, dur: end - start, speaker, text: "unit " + id, words: [{ w: "x", s: start, e: end }], flags: flags.slice(), pauseBefore: { s: 0, kind: "neutral" }, pauseAfter: { s: 0, kind: "neutral" } };
}

test("energy: z-scored per speaker — a quiet guest is not globally penalized", () => {
  const units = [
    mkUnit(0, 0, 10, "A"), mkUnit(1, 10, 20, "A"), mkUnit(2, 20, 30, "A"),
    mkUnit(3, 30, 40, "B"), mkUnit(4, 40, 50, "B"), mkUnit(5, 50, 60, "B"),
  ];
  const frames = [];
  // A is loud (0.5 base, 0.9 peak on unit 2); B is quiet (0.05 base, 0.09 peak on unit 5)
  const rmsFor = (t) => {
    if (t < 20) return 0.5;
    if (t < 30) return 0.9;
    if (t < 50) return 0.05;
    return 0.09;
  };
  for (let t = 0; t < 60; t += 0.5) frames.push({ t, rms: rmsFor(t) });
  energyPerUnit(units, frames);
  zScorePerSpeaker(units);
  assert.ok(units[2].highEnergy, "A's peak flagged");
  assert.ok(units[5].highEnergy, "B's peak flagged despite low absolute loudness");
  assert.ok(!units[0].highEnergy && !units[3].highEnergy, "baselines not flagged");
});

test("snr: units barely above the noise floor get lowQuality", () => {
  const units = [mkUnit(0, 0, 10, "A"), mkUnit(1, 10, 20, "A")];
  const frames = [];
  for (let t = 0; t < 10; t += 0.5) frames.push({ t, rms: -35 }); // 25dB over floor
  for (let t = 10; t < 20; t += 0.5) frames.push({ t, rms: -55 }); // 5dB over floor
  for (let t = 20; t < 40; t += 0.5) frames.push({ t, rms: -60 }); // the floor
  snrPerUnit(units, frames);
  assert.ok(!units[0].lowQuality, "clear unit not flagged");
  assert.ok(units[1].lowQuality, "near-floor unit flagged lowQuality");
});

test("scene map: multicam signature detected; shot boundaries marked", () => {
  const auto = [];
  for (let t = 4; t < 120; t += 4) auto.push(t);
  assert.equal(sceneMap(auto, 120).multicam, true, "regular fast switching = multicam");
  assert.equal(sceneMap([10, 55, 90], 120).multicam, false, "sparse cuts = single-cam");
  const units = [mkUnit(0, 0, 9.8, "A"), mkUnit(1, 9.8, 30, "A")];
  markShotBoundaries(units, { times: [10] });
  assert.ok(units[0].shotBoundaryNear && units[1].shotBoundaryNear);
});

test("pauses: a pause after a high-energy unit becomes dramatic", () => {
  const a = mkUnit(0, 0, 5, "A");
  const b = mkUnit(1, 6, 10, "A");
  a.highEnergy = true;
  a.pauseAfter = { s: 1.0, kind: "neutral" };
  b.pauseBefore = { s: 1.0, kind: "neutral" };
  upgradePauses([a, b]);
  assert.equal(a.pauseAfter.kind, "dramatic");
  assert.equal(b.pauseBefore.kind, "dramatic");
});

/* ------------------------------ S2 scorer -------------------------------- */

test("mergeRuns: per-unit median across diversified runs", () => {
  const merged = mergeRuns([
    [{ id: 0, score: 50 }, { id: 1, score: 20 }],
    [{ id: 0, score: 80 }, { id: 1, score: 25 }],
    [{ id: 0, score: 90 }], // run 3 dropped unit 1
  ]);
  assert.equal(merged.get(0).score, 80, "median of 50/80/90");
  assert.equal(merged.get(1).score, 25, "median of 20/25 (upper-mid)");
});

test("applyScores: units missing from every run are KEPT by default", () => {
  const units = [mkUnit(0, 0, 5, "A"), mkUnit(1, 5, 10, "A")];
  const missing = applyScores(units, new Map([[0, { score: 90, reason: "great" }]]));
  assert.equal(missing, 1);
  assert.equal(units[1].score, 65);
  assert.match(units[1].reason, /kept by default/);
});

function mockLlm(scoreOf, { dropEvery = 0, hookId = null, closingId = null } = {}) {
  let call = 0;
  return async (messages) => {
    if (messages[0].content.includes("story editor")) {
      return { beats: [], hookUnit: hookId, closingUnit: closingId };
    }
    call++;
    const ids = [];
    for (const line of messages[1].content.split("\n")) {
      const m = line.match(/^(\d+)\t/);
      if (m) ids.push(parseInt(m[1]));
    }
    const scores = [];
    for (const id of ids) {
      if (dropEvery && (id + call) % dropEvery === 0) continue; // flaky truncation
      scores.push({ id, score: scoreOf(id), reason: "mock" });
    }
    return { scores };
  };
}

test("scoreUnits: llm tier with dropouts — every unit still ends up scored", async () => {
  const units = [];
  for (let i = 0; i < 12; i++) units.push(mkUnit(i, i * 5, i * 5 + 4, "A"));
  const res = await scoreUnits(units, {
    llm: mockLlm((id) => (id % 3 === 0 ? 15 : 75), { dropEvery: 4, hookId: 0, closingId: 11 }),
  });
  assert.equal(res.tier, "llm");
  for (const u of units) assert.ok(typeof u.score === "number", `unit ${u.id} scored`);
  assert.ok(units[0].hook, "hook marked from outline");
  assert.ok(units[11].closing, "closing marked from outline");
});

test("scoreUnits: llm failure falls back to the deterministic tier", async () => {
  const units = [mkUnit(0, 0, 5, "A", ["filler"]), mkUnit(1, 5, 10, "A")];
  const res = await scoreUnits(units, {
    llm: async () => {
      throw new Error("429 you shall not pass");
    },
  });
  assert.equal(res.tier, "deterministic");
  assert.ok(units[0].score < 30, "filler scored low by heuristics");
  assert.ok(units[1].score >= 50, "clean unit scored keepable");
});

test("scoreUnits: content-hash cache makes the second call free", async () => {
  const cachePath = path.join(os.tmpdir(), `edit-ai-scores-${Date.now()}.json`);
  const units1 = [mkUnit(0, 0, 5, "A"), mkUnit(1, 5, 10, "A")];
  let calls = 0;
  const llm = async (messages) => {
    calls++;
    if (messages[0].content.includes("story editor")) return { beats: [], hookUnit: null, closingUnit: null };
    return { scores: [{ id: 0, score: 80, reason: "x" }, { id: 1, score: 70, reason: "y" }] };
  };
  const r1 = await scoreUnits(units1, { llm, cachePath, runs: 1 });
  assert.equal(r1.fromCache, false);
  const callsAfterFirst = calls;
  const units2 = [mkUnit(0, 0, 5, "A"), mkUnit(1, 5, 10, "A")];
  const r2 = await scoreUnits(units2, { llm, cachePath, runs: 1 });
  assert.equal(r2.fromCache, true);
  assert.equal(calls, callsAfterFirst, "no new llm calls");
  assert.equal(units2[0].score, 80);
  fs.unlink(cachePath, () => {});
});

/* ------------------------------ plan glue -------------------------------- */

test("enginePlan: server-shaped words → rich review blocks + junk cut", async () => {
  const fx = buildFixture("interview", 21);
  const serverWords = fx.words.map((w) => ({ word: w.w, start: w.s, end: w.e }));
  // truth-aware mock: junk sentences low, good high
  const junkRanges = fx.spans.filter((s) => s.meta.junk).map((s) => [s.start, s.end]);
  const eng = await enginePlan({
    words: serverWords,
    duration: fx.duration,
    utterances: [],
    chapters: [],
    llm: null, // deterministic tier — flags carry the junk detection
  });
  assert.ok(eng.blocks.length > 10, "blocks produced");
  const cut = eng.blocks.filter((b) => b.type === "cut");
  assert.ok(cut.length >= 4, "junk was cut");
  for (const b of eng.blocks) {
    assert.ok(typeof b.score === "number", "every block scored");
    assert.ok(Array.isArray(b.words) && b.words.every((w) => typeof w.i === "number"), "global word indexes preserved");
  }
  assert.ok(eng.keeps.length >= 1, "keeps produced");
  assert.equal(eng.tier, "deterministic");
  // junk time should be mostly outside the keeps
  const keptTime = (t) => eng.keeps.some((k) => t >= k.start && t <= k.end);
  let junkKept = 0;
  for (const [a, b] of junkRanges) if (keptTime((a + b) / 2)) junkKept++;
  assert.ok(junkKept <= 1, `junk mostly cut (kept ${junkKept}/${junkRanges.length})`);
});
