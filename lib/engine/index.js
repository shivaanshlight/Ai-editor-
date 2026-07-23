/**
 * lib/engine/index.js — M0 decision loop composer.
 *
 * decide(units, opts) runs the full deterministic decision layer:
 *
 *   select → lint → repair → RE-SELECT → re-lint   (≤ maxRounds)
 *
 * The re-select step is what keeps Condense honest: monotone repairs restore
 * narrative-critical units (antecedents, payoffs, coverage, hook/closer), and
 * a plain lint→repair loop would leave the result over the duration target.
 * Here every restored unit becomes a hard lock and the DP re-fits the budget
 * by dropping lower-value material instead. Deterministic, terminates: the
 * lock set only grows and rounds are capped.
 */

const segmentM = require("./segment");
const selectM = require("./select");
const boundaryM = require("./boundary");
const lintM = require("./lint");

const DEFAULTS = { maxRounds: 3 };

function decide(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const locks = new Set(units.filter((u) => u.mustKeep).map((u) => u.id));
  let sel = null;
  let loop = null;
  let restoredAll = [];
  let rounds = 0;

  for (; rounds < o.maxRounds; rounds++) {
    const us = units.map((u) => (locks.has(u.id) ? { ...u, mustKeep: true } : u));
    sel = selectM.selectUnits(us, o);
    loop = lintM.lintRepairLoop(units, sel.keep, o);
    // noRestore: keep the linter's FINDINGS but don't add units back — restoring
    // continuity units force-grows the budget, which defeats an aggressive
    // condense (highlights is a montage; choppiness is expected there).
    if (o.noRestore || !loop.restored.length) break;
    for (const id of loop.restored) locks.add(id);
    restoredAll = restoredAll.concat(loop.restored);
  }

  return {
    keep: loop.keep,
    findings: loop.findings,
    restored: restoredAll,
    rounds: rounds + 1,
    cuts: countCuts(loop.keep),
    keptDur: units.reduce((a, u, i) => a + (loop.keep[i] ? u.dur : 0), 0),
  };
}

function countCuts(keep) {
  let cuts = 0;
  let prevKept = true;
  for (const k of keep) {
    if (!k && prevKept) cuts++;
    prevKept = k;
  }
  return cuts;
}

module.exports = {
  decide,
  ...segmentM,
  ...selectM,
  ...boundaryM,
  ...lintM,
};
