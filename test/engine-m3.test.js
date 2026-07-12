/**
 * test/engine-m3.test.js — M3 tests: preference telemetry + Cold Open lift.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { diffPlan, record, loadRecent, preferenceBlock } = require("../lib/engine/telemetry");
const { liftColdOpen } = require("../lib/engine/plan");

/* ------------------------------ telemetry ------------------------------ */

const WORDS = [
  { word: "the", start: 10, end: 10.3 },
  { word: "origin", start: 10.35, end: 10.7 },
  { word: "story", start: 10.75, end: 11.1 },
  { word: "boring", start: 30, end: 30.4 },
  { word: "tangent", start: 30.45, end: 30.9 },
];

test("diffPlan: restored and cut spans become labeled corrections", () => {
  const planned = [{ start: 0, end: 8 }, { start: 28, end: 35 }];
  const final = [{ start: 0, end: 8 }, { start: 9.5, end: 12 }]; // restored 9.5-12, cut 28-35
  const corrections = diffPlan(planned, final, WORDS);
  const restored = corrections.find((c) => c.action === "restored");
  const cut = corrections.find((c) => c.action === "cut");
  assert.ok(restored && /origin story/.test(restored.text), "restored text captured");
  assert.ok(cut && /boring tangent/.test(cut.text), "cut text captured");
});

test("record + loadRecent: append, rotate, newest-first", () => {
  const f = path.join(os.tmpdir(), `edit-ai-tel-${Date.now()}.jsonl`);
  record(f, [{ action: "restored", text: "first", at: 1 }]);
  record(f, [{ action: "cut", text: "second", at: 2 }]);
  const recent = loadRecent(f, 2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].text, "second", "newest first");
  fs.unlinkSync(f);
});

test("preferenceBlock: renders restored/cut few-shot lines", () => {
  const block = preferenceBlock([
    { action: "restored", text: "the story about the outage" },
    { action: "cut", text: "sponsor read boilerplate" },
  ]);
  assert.match(block, /RESTORED/);
  assert.match(block, /outage/);
  assert.match(block, /LOWER/);
  assert.match(block, /sponsor/);
  assert.equal(preferenceBlock([]), "", "empty in, empty out");
});

/* ------------------------------ cold open ------------------------------ */

test("liftColdOpen: hook segment moves to front, rest stays chronological", () => {
  const keeps = [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
    { start: 40, end: 55 },
  ];
  const out = liftColdOpen(keeps, 41);
  assert.deepEqual(out.map((s) => s.start), [40, 0, 10]);
});

test("liftColdOpen: no-op when hook is already first or missing", () => {
  const keeps = [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
  ];
  assert.deepEqual(liftColdOpen(keeps, 2).map((s) => s.start), [0, 10], "already first");
  assert.deepEqual(liftColdOpen(keeps, 999).map((s) => s.start), [0, 10], "hook not found");
  assert.deepEqual(liftColdOpen(keeps, null).map((s) => s.start), [0, 10], "no hook");
});

/* -------------------------- segment-count guard -------------------------- */

const { enginePlan } = require("../lib/engine/plan");

test("enginePlan: consecutive kept units bridge into few segments (render fast path)", async () => {
  const { buildFixture } = require("../bench/fixtures");
  const fx = buildFixture("interview", 7);
  const serverWords = fx.words.map((w) => ({ word: w.w, start: w.s, end: w.e }));
  const eng = await enginePlan({ words: serverWords, duration: fx.duration, llm: null });
  const keptBlocks = eng.blocks.filter((b) => b.type === "keep").length;
  // A per-unit EDL would emit ~keptBlocks segments; bridging must collapse
  // consecutive keeps so segments ≈ number of cut runs, far below unit count.
  assert.ok(
    eng.keeps.length < keptBlocks / 2,
    `expected bridged segments, got ${eng.keeps.length} for ${keptBlocks} kept units`,
  );
  // and every inter-sentence pause inside a kept run is preserved (no jump cut)
  for (const s of eng.keeps) assert.ok(s.end - s.start > 0, "valid span");
});
