/**
 * test/engine-m2.test.js — M1.5/M2 tests: pairwise tournament.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { tournamentPass, runTournament, pickBand, findThreshold } = require("../lib/engine/tournament");
const { rng } = require("../bench/fixtures");

function mkUnit(id, score, dur = 5, text = null) {
  return {
    id,
    start: id * 6,
    end: id * 6 + dur,
    dur,
    score,
    text: text || `unit ${id} says something of quality`,
    words: [{ w: "x", s: id * 6, e: id * 6 + dur }],
    flags: [],
    silence: false,
  };
}

/** A judge that knows the TRUE quality and answers BATCHED head-to-heads. */
function truthJudge(quality, { positionBias = 0 } = {}) {
  const R = rng(99);
  return async (messages) => {
    const blocks = messages[1].content.split(/\n\n(?=Pair \d+:)/);
    const winners = blocks.map((blk) => {
      const m = blk.match(/A \([\d.]+s\): unit (\d+)[\s\S]*B \([\d.]+s\): unit (\d+)/);
      const aId = parseInt(m[1]);
      const bId = parseInt(m[2]);
      // position bias: sometimes just says A regardless — order swap must absorb it
      if (positionBias && R() < positionBias) return "A";
      return quality.get(aId) >= quality.get(bId) ? "A" : "B";
    });
    return { winners };
  };
}

test("threshold: midpoint between weakest kept and strongest cut", () => {
  const units = [mkUnit(0, 70), mkUnit(1, 60), mkUnit(2, 55), mkUnit(3, 40)];
  const keep = [true, true, false, false];
  assert.equal(findThreshold(units, keep), 57.5);
});

test("band: only near-threshold, unlocked, scored units; capped and centered", () => {
  const units = [
    mkUnit(0, 90),
    mkUnit(1, 62),
    mkUnit(2, 58),
    mkUnit(3, 55),
    mkUnit(4, 20),
    { ...mkUnit(5, 57), mustKeep: true },
    { ...mkUnit(6, 57), silence: true },
  ];
  const band = pickBand(units, 57.5, { bandWidth: 8 });
  const ids = band.map((u) => u.id).sort();
  assert.deepEqual(ids, [1, 2, 3], "locked/silence/far units excluded");
});

test("tournament: corrects a pointwise misordering inside the band", async () => {
  // truth: 3 > 1 > 2 > 0, but pointwise says 0 > 2 > 1 > 3 (inverted!)
  const units = [mkUnit(0, 60), mkUnit(1, 58), mkUnit(2, 59), mkUnit(3, 57)];
  const quality = new Map([[0, 10], [1, 30], [2, 20], [3, 40]]);
  const res = await runTournament(units, truthJudge(quality));
  assert.ok(res.reranked);
  const order = units.slice().sort((a, b) => b.score - a.score).map((u) => u.id);
  assert.deepEqual(order, [3, 1, 2, 0], "tournament order matches truth");
  // scores stay within the band's original range
  for (const u of units) assert.ok(u.score >= 57 && u.score <= 60);
});

test("tournament: order-swap absorbs position bias", async () => {
  const units = [mkUnit(0, 60), mkUnit(1, 58), mkUnit(2, 59), mkUnit(3, 57)];
  const quality = new Map([[0, 10], [1, 30], [2, 20], [3, 40]]);
  // 30% of calls blindly answer "A" — the swap makes that symmetric noise
  const res = await runTournament(units, truthJudge(quality, { positionBias: 0.3 }));
  assert.ok(res.reranked);
  const order = units.slice().sort((a, b) => b.score - a.score).map((u) => u.id);
  // With few games per unit, bias can flip adjacent ranks — the guarantee is
  // that the extremes stay on the right SIDE of the band, not exact placement.
  assert.equal(order[0], 3, "true best still wins under bias");
  assert.ok(order.indexOf(0) >= 2, "true worst stays in the bottom half under bias");
});

test("tournament: failed comparisons degrade gracefully", async () => {
  const units = [mkUnit(0, 60), mkUnit(1, 58)];
  const res = await runTournament(units, async () => {
    throw new Error("provider down");
  });
  assert.equal(res.reranked, false);
  assert.equal(units[0].score, 60, "pointwise scores untouched");
});

test("tournamentPass: end-to-end — non-band units are never touched", async () => {
  const units = [mkUnit(0, 95), mkUnit(1, 60), mkUnit(2, 58), mkUnit(3, 15)];
  const keep = [true, true, false, false];
  const quality = new Map([[1, 10], [2, 90]]);
  const res = await tournamentPass(units, keep, truthJudge(quality));
  assert.ok(res.bandSize >= 2);
  assert.equal(units[0].score, 95, "strong unit untouched");
  assert.equal(units[3].score, 15, "junk unit untouched");
  assert.ok(units[2].score > units[1].score, "band re-ranked by truth");
});
