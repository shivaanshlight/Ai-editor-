/**
 * lib/engine/lint.js — M0 Edit Linter + repair loop (S5).
 *
 * Research verdict baked in: intrinsic self-critique fails; self-correction
 * works only with reliable EXTERNAL feedback. This is that feedback — a
 * deterministic, local, zero-cost analyzer of (units + keep decisions).
 *
 * Checks:
 *   orphanedReference — kept unit opens with a back-reference whose
 *                       antecedent (previous speech unit) was cut
 *   droppedPayoff     — kept question whose answer was cut; kept setup whose
 *                       linked payoff (payoffOf) is gone
 *   coverageGap       — a chapter that lost 100% of its material
 *   rhythm            — cuts/min over budget · kept runs shorter than a
 *                       phrase · boundaries not in silence (when words given)
 *   structure         — hook present in the first N kept seconds · final
 *                       kept unit is a closing-type line
 *
 * Flag first, repair only when safe: every finding is surfaced; automated
 * repair runs only for trivial high-agreement cases and is MONOTONE —
 * restore/extend only, never new cuts — so it cannot oscillate. Every repair
 * is re-linted (a fix can introduce a new violation): lint → repair → re-lint
 * to a fixpoint, max `maxPasses` iterations, then remaining findings go to
 * the human.
 */

const { inSpeech } = require("./boundary");

const DEFAULTS = {
  cutsPerMinBudget: 12,
  minKeepDur: 1.2, // a kept run shorter than this is a sub-phrase keep
  hookWindow: 20, // the hook must appear within the first N kept seconds
  boundaryTol: 0.06, // tolerance when checking boundary-in-silence
  maxPasses: 2,
};

const ORPHAN_RE =
  /^\s*["'“”]?\s*(so that'?s why|that'?s why|as i (said|mentioned)|like i said|which is why|because of that|that'?s when|that'?s what i mean|(he|she|it|they|this|that) (did|was|is|were|are)\b)/i;
const CLOSING_RE =
  /\b(thanks for (watching|listening)|see you (next|in)|that'?s (all|it) for|where can people find|come build with us|goodbye|until next time|wrapping up|to wrap|final thought)\b/i;

/* ---------------------------------- lint ----------------------------------- */

/**
 * @param units  segmenter units, optionally with {score, chapter, hook,
 *               closing, payoffOf, speaker}
 * @param keep   boolean[] aligned with units
 * @param opts   { words?, edl?, duration?, ... } — words+edl enable the
 *               boundary-in-silence check on the final EDL
 * @returns findings: [{ rule, severity, unitId?, msg, repair? }]
 *          repair (when present) = { restore: unitId } — monotone by design
 */
function lint(units, keep, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const findings = [];
  const speech = units.filter((u) => u.words && u.words.length);
  const isKept = (u) => keep[indexOf(units, u.id)];

  // --- orphaned references -------------------------------------------------
  // The antecedent is the previous NON-disfluent speech unit: cut filler or
  // false starts between the setup and the reference are junk, not the setup —
  // restoring one of those would "fix" the orphan with garbage.
  const isDisfluent = (u) =>
    u.flags &&
    (u.flags.includes("filler") || u.flags.includes("falseStart") || u.flags.includes("retake"));
  for (let k = 0; k < speech.length; k++) {
    const u = speech[k];
    if (!isKept(u) || !ORPHAN_RE.test(u.text)) continue;
    let pi = k - 1;
    while (pi >= 0 && isDisfluent(speech[pi])) pi--;
    const prev = speech[pi];
    if (prev && !isKept(prev)) {
      findings.push({
        rule: "orphanedReference",
        severity: 3,
        unitId: u.id,
        msg: `Kept #${u.id} opens with a reference whose setup was cut`,
        repair: { restore: prev.id },
      });
    }
  }

  // --- dropped payoffs ------------------------------------------------------
  for (const u of units) {
    if (u.payoffOf == null) continue;
    const setup = units.find((x) => x.id === u.payoffOf);
    if (setup && isKept(setup) && !isKept(u)) {
      findings.push({
        rule: "droppedPayoff",
        severity: 3,
        unitId: u.id,
        msg: `Setup #${setup.id} kept but its payoff #${u.id} was cut`,
        repair: { restore: u.id },
      });
    }
  }
  // kept question, answer cut. The "answer" is the next NON-disfluent speech
  // unit — cut filler/false-starts/retakes between Q and A are junk, not the
  // answer, and must not trigger this rule.
  const disfluent = (u) =>
    u.flags &&
    (u.flags.includes("filler") || u.flags.includes("falseStart") || u.flags.includes("retake"));
  for (let k = 0; k < speech.length - 1; k++) {
    const q = speech[k];
    if (!isKept(q) || !/\?\s*["'”’]?$/.test(q.text.trim())) continue;
    let ai = k + 1;
    while (ai < speech.length && disfluent(speech[ai])) ai++;
    const a = speech[ai];
    if (a && !isKept(a) && (q.speaker == null || a.speaker == null || q.speaker !== a.speaker)) {
      findings.push({
        rule: "droppedPayoff",
        severity: 2,
        unitId: a.id,
        msg: `Question #${q.id} kept but its answer #${a.id} was cut`,
        repair: { restore: a.id },
      });
    }
  }

  // --- coverage gaps --------------------------------------------------------
  const chapters = new Map();
  for (const u of speech) {
    if (u.chapter == null) continue;
    if (!chapters.has(u.chapter)) chapters.set(u.chapter, []);
    chapters.get(u.chapter).push(u);
  }
  for (const [name, list] of chapters) {
    if (list.length && list.every((u) => !isKept(u))) {
      const best = list.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      findings.push({
        rule: "coverageGap",
        severity: 3,
        unitId: best.id,
        msg: `Chapter “${name}” lost all its material`,
        repair: { restore: best.id },
      });
    }
  }

  // --- rhythm ----------------------------------------------------------------
  const total = o.duration ?? units.reduce((a, u) => Math.max(a, u.end), 0) ?? 1;
  let cuts = 0;
  let prevKept = true;
  for (let i = 0; i < units.length; i++) {
    if (!keep[i] && prevKept) cuts++;
    prevKept = keep[i];
  }
  const cpm = Math.round((cuts / (total / 60)) * 10) / 10;
  if (cpm > o.cutsPerMinBudget) {
    findings.push({
      rule: "rhythm",
      severity: 1,
      msg: `Cuts per minute ${cpm} exceeds the ${o.cutsPerMinBudget}/min budget`,
    });
  }
  // Sub-phrase kept runs. These ARE monotonically repairable: extend the
  // run by restoring its best adjacent cut unit (restore-only, so the loop
  // can't oscillate — a restore only ever lengthens runs). Prefer a clean
  // neighbor over a disfluent one, then the higher score; if every neighbor
  // is disfluent junk, leave it flagged for the human instead of "fixing"
  // a too-short keep by resurrecting garbage.
  const disfl = (u) =>
    u.flags &&
    (u.flags.includes("filler") || u.flags.includes("falseStart") || u.flags.includes("retake"));
  let runStart = -1;
  for (let i = 0; i <= units.length; i++) {
    const kept = i < units.length && keep[i];
    if (kept && runStart < 0) runStart = i;
    if (!kept && runStart >= 0) {
      const dur = units[i - 1].end - units[runStart].start;
      if (dur < o.minKeepDur) {
        const cands = [];
        const prev = units[runStart - 1];
        const next = i < units.length ? units[i] : null;
        if (prev && !keep[runStart - 1] && !prev.mustCut) cands.push(prev);
        if (next && !next.mustCut) cands.push(next);
        const clean = cands.filter((u) => !disfl(u));
        const pool = clean.length ? clean : [];
        pool.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        findings.push({
          rule: "rhythm",
          severity: 2,
          unitId: units[runStart].id,
          msg: `Kept run at ${units[runStart].start.toFixed(1)}s is shorter than a phrase (${dur.toFixed(2)}s)`,
          ...(pool.length ? { repair: { restore: pool[0].id } } : {}),
        });
      }
      runStart = -1;
    }
  }
  // boundary-in-silence on the final EDL
  if (opts.words && opts.edl) {
    const ws = opts.words.filter((w) => w.s != null && w.e != null).slice().sort((a, b) => a.s - b.s);
    for (const seg of opts.edl) {
      for (const t of [seg.start, seg.end]) {
        if (t <= 0.05 || (o.duration && t >= o.duration - 0.05)) continue;
        // a boundary is fine if it's at least tol inside a gap
        const bad = inSpeech(t, ws, -o.boundaryTol) === true && inSpeechStrict(t, ws, o.boundaryTol);
        if (bad) {
          findings.push({
            rule: "rhythm",
            severity: 2,
            msg: `Boundary at ${t.toFixed(2)}s lands mid-word`,
          });
        }
      }
    }
  }

  // --- structure ---------------------------------------------------------------
  const hookUnit = units.find((u) => u.hook);
  if (hookUnit) {
    // hook must be kept, and appear within the first hookWindow seconds of output
    let outPos = 0;
    let hookAt = -1;
    for (let i = 0; i < units.length; i++) {
      if (!keep[i]) continue;
      if (units[i].id === hookUnit.id) {
        hookAt = outPos;
        break;
      }
      outPos += units[i].dur;
    }
    if (!keep[indexOf(units, hookUnit.id)]) {
      findings.push({
        rule: "structure",
        severity: 3,
        unitId: hookUnit.id,
        msg: "The opening hook was cut",
        repair: { restore: hookUnit.id },
      });
    } else if (hookAt > o.hookWindow) {
      findings.push({
        rule: "structure",
        severity: 1,
        unitId: hookUnit.id,
        msg: `Hook appears at ${hookAt.toFixed(0)}s of output — outside the first ${o.hookWindow}s`,
      });
    }
  }
  const keptUnits = units.filter((_, i) => keep[i]);
  const lastKept = keptUnits[keptUnits.length - 1];
  const closingUnit = units.find((u) => u.closing);
  if (closingUnit && (!lastKept || lastKept.id !== closingUnit.id)) {
    if (!keep[indexOf(units, closingUnit.id)]) {
      findings.push({
        rule: "structure",
        severity: 2,
        unitId: closingUnit.id,
        msg: "The closing line was cut",
        repair: { restore: closingUnit.id },
      });
    }
  } else if (!closingUnit && lastKept && !CLOSING_RE.test(lastKept.text) && keptUnits.length > 3) {
    findings.push({
      rule: "structure",
      severity: 1,
      unitId: lastKept.id,
      msg: "The edit does not end on a closing-type line",
    });
  }

  return findings;
}

function inSpeechStrict(t, words, tol) {
  for (const w of words) {
    if (w.s + tol < t && t < w.e - tol) return true;
    if (w.s > t + 1) break;
  }
  return false;
}

function indexOf(units, id) {
  for (let i = 0; i < units.length; i++) if (units[i].id === id) return i;
  return -1;
}

/* --------------------------------- repair ----------------------------------- */

/**
 * Monotone repair: apply only the findings that carry a safe restore action.
 * Restores flip cut→keep, never keep→cut, so the loop cannot oscillate.
 * Returns { keep, restored: [unitId...] }.
 */
function repair(units, keep, findings) {
  const next = keep.slice();
  const restored = [];
  for (const f of findings) {
    if (!f.repair || f.repair.restore == null) continue;
    const i = indexOf(units, f.repair.restore);
    if (i >= 0 && !next[i]) {
      next[i] = true;
      restored.push(units[i].id);
    }
  }
  return { keep: next, restored };
}

/**
 * lint → repair → re-lint to a fixpoint (≤ maxPasses), then hand what's left
 * to the human. Deterministic and monotone ⇒ guaranteed to terminate.
 */
function lintRepairLoop(units, keep, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let cur = keep.slice();
  let restoredAll = [];
  let findings = lint(units, cur, o);
  let passes = 0;
  while (passes < o.maxPasses && findings.some((f) => f.repair)) {
    const r = repair(units, cur, findings);
    if (!r.restored.length) break;
    cur = r.keep;
    restoredAll = restoredAll.concat(r.restored);
    findings = lint(units, cur, o);
    passes++;
  }
  return { keep: cur, findings, restored: restoredAll, passes };
}

module.exports = { lint, repair, lintRepairLoop, ORPHAN_RE, CLOSING_RE, DEFAULTS };
