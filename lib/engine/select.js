/**
 * lib/engine/select.js — M0 DP Selector (S3).
 *
 * One deterministic optimizer replaces "threshold + separate rate-limiter":
 *
 *   choose the kept set maximizing  Σ salience − λ·(number of cuts)
 *   subject to: locks (always in) · coverage (each chapter keeps its best
 *   unit) · budget (Tighten: kept-unit quantile · Condense: target duration)
 *   · minimum-keep length (no isolated sub-phrase keeps) · deliberate hook
 *   and ending.
 *
 * "Cuts" are splice points: maximal runs of cut units. The per-cut penalty λ
 * makes contiguity emerge naturally — each extra cut must pay for itself —
 * which is what kills the keep-5/cut-6/keep-7 stutter.
 *
 * Exact 0/1 dynamic programming (standard video-summarization knapsack).
 * State: (unit index, budget used, kept-status of the previous two units) —
 * the two-unit history is what lets the DP forbid isolated short keeps.
 * Ordering stays chronological; Cold Open lifting is a later milestone.
 *
 * Unit shape in: { id, dur, score, chapter?, mustKeep?, mustCut?,
 *                  hook?, closing? }
 */

const DEFAULTS = {
  lambda: 8, // per-splice penalty, in score points
  minKeepDur: 1.2, // an isolated kept run must be at least this long (sec)
  durationCellMax: 2000, // condense-mode budget quantization cells (upper bound)
  keepHook: true,
  keepClosing: true,
  coverage: true,
};

const NEG = -1e15;

/** Pre-pass: fold locks, hook/closing, and chapter coverage into mustKeep. */
function applyConstraints(units, o) {
  const out = units.map((u) => ({ ...u }));
  if (o.keepHook) for (const u of out) if (u.hook) u.mustKeep = true;
  if (o.keepClosing) for (const u of out) if (u.closing) u.mustKeep = true;
  if (o.coverage) {
    const best = new Map(); // chapter -> unit
    for (const u of out) {
      if (u.chapter == null) continue;
      const b = best.get(u.chapter);
      if (!b || (u.score ?? 0) > (b.score ?? 0)) best.set(u.chapter, u);
    }
    for (const u of best.values()) u.mustKeep = true;
  }
  // Junk floor: force-cut anything the scorer rated below `junkFloor` so obvious
  // filler/pleasantries ("Period.", "Yeah.") never survive merely because
  // cutting them would add a splice (the λ penalty was keeping scored-10 junk).
  // Applied BEFORE the mustKeep reconciliation below, so a locked / hook /
  // closer / coverage / lint-restored unit still overrides the floor.
  if (o.junkFloor) {
    for (const u of out) {
      if (!u.mustKeep && typeof u.score === "number" && u.score < o.junkFloor)
        u.mustCut = true;
    }
  }
  for (const u of out) if (u.mustKeep) u.mustCut = false;
  return out;
}

/**
 * Exact DP solve.
 * mode "tighten": budget = max kept units (opts.keepCount).
 * mode "condense": budget = max kept seconds (opts.targetDuration).
 * Returns { keep: boolean[], keptIds, objective, cuts, keptDur, effectiveKeptPct }.
 */
function selectUnits(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const us = applyConstraints(units, o);
  const n = us.length;
  if (!n) return { keep: [], keptIds: [], objective: 0, cuts: 0, keptDur: 0, effectiveKeptPct: 0 };

  // --- budget setup -------------------------------------------------------
  let costOf, budget;
  if (o.mode === "condense") {
    const total = us.reduce((a, u) => a + u.dur, 0);
    const target = Math.max(0, o.targetDuration ?? total);
    const cell = Math.max(0.25, total / o.durationCellMax);
    costOf = (u) => Math.max(1, Math.round(u.dur / cell));
    const forced = us.filter((u) => u.mustKeep).reduce((a, u) => a + costOf(u), 0);
    budget = Math.max(Math.round(target / cell), forced);
  } else {
    costOf = () => 1;
    const forcedCount = us.filter((u) => u.mustKeep).length;
    budget = Math.max(
      Math.min(n, o.keepCount ?? n),
      forcedCount,
    );
  }

  const shortU = us.map((u) => u.dur < o.minKeepDur && !u.mustKeep);

  // --- DP -----------------------------------------------------------------
  // state p encodes (prev kept?, prev-prev kept?) as 2 bits: p = prev | prevprev<<1
  // dp[r][p] = best objective after i units. parent pointers for reconstruction.
  const W = budget + 1;
  let dp = new Float64Array(W * 4).fill(NEG);
  dp[0 * 4 + 0b10] = 0; // virtual: "before the clip" counts as kept, so a
  // leading cut-run costs one splice (a head trim) exactly once.
  // p bits at i=0: prev = virtual-kept(1), prevprev = 1 → 0b11? Use 0b11.
  dp = new Float64Array(W * 4).fill(NEG);
  dp[0 * 4 + 0b11] = 0;

  // parent[i][r][p] = { pr, pp, kept } — packed into arrays for speed
  const parent = new Array(n);

  for (let i = 0; i < n; i++) {
    const u = us[i];
    const cost = costOf(u);
    const next = new Float64Array(W * 4).fill(NEG);
    const par = new Int32Array(W * 4).fill(-1);

    for (let r = 0; r < W; r++) {
      for (let p = 0; p < 4; p++) {
        const cur = dp[r * 4 + p];
        if (cur === NEG) continue;
        const prevKept = p & 1;
        const prevPrevKept = (p >> 1) & 1;

        // Option A: keep unit i
        if (!u.mustCut && r + cost <= budget) {
          const np = ((prevKept << 1) | 1) & 3;
          const val = cur + (u.score ?? 0);
          const idx = (r + cost) * 4 + np;
          if (val > next[idx]) {
            next[idx] = val;
            par[idx] = (r << 3) | (p << 1) | 1;
          }
        }

        // Option B: cut unit i
        if (!u.mustKeep) {
          // forbid completing an isolated short keep: pattern cut,shortKeep,cut
          const isolatedShort = prevKept === 1 && prevPrevKept === 0 && i >= 1 && shortU[i - 1];
          if (!isolatedShort) {
            const np = ((prevKept << 1) | 0) & 3;
            const pen = prevKept === 1 ? o.lambda : 0; // new cut-run starts
            const val = cur - pen;
            const idx = r * 4 + np;
            if (val > next[idx]) {
              next[idx] = val;
              par[idx] = (r << 3) | (p << 1) | 0;
            }
          }
        }
      }
    }
    parent[i] = par;
    dp = next;
  }

  // --- best terminal state (also forbid trailing isolated short keep) ------
  let best = NEG;
  let bestR = -1;
  let bestP = -1;
  for (let r = 0; r < W; r++) {
    for (let p = 0; p < 4; p++) {
      const v = dp[r * 4 + p];
      if (v === NEG) continue;
      const prevKept = p & 1;
      const prevPrevKept = (p >> 1) & 1;
      if (prevKept === 1 && prevPrevKept === 0 && shortU[n - 1]) continue;
      if (v > best) {
        best = v;
        bestR = r;
        bestP = p;
      }
    }
  }
  // Fallback (over-constrained): keep everything forced, cut nothing else.
  if (bestR < 0) {
    const keep = us.map(() => true);
    return summarize(us, keep, o);
  }

  // --- reconstruct ----------------------------------------------------------
  const keep = new Array(n).fill(false);
  let r = bestR;
  let p = bestP;
  for (let i = n - 1; i >= 0; i--) {
    const packed = parent[i][r * 4 + p];
    const kept = packed & 1;
    const pp = (packed >> 1) & 3;
    const pr = packed >> 3;
    keep[i] = kept === 1;
    r = pr;
    p = pp;
  }

  return summarize(us, keep, o, best);
}

function summarize(us, keep, o, objective = null) {
  let cuts = 0;
  let prevKept = true; // virtual head
  for (let i = 0; i < us.length; i++) {
    if (!keep[i] && prevKept) cuts++;
    prevKept = keep[i];
  }
  const keptDur = us.reduce((a, u, i) => a + (keep[i] ? u.dur : 0), 0);
  const totalDur = us.reduce((a, u) => a + u.dur, 0) || 1;
  if (objective == null) {
    objective = us.reduce((a, u, i) => a + (keep[i] ? u.score ?? 0 : 0), 0) - o.lambda * cuts;
  }
  return {
    keep,
    keptIds: us.filter((_, i) => keep[i]).map((u) => u.id),
    objective,
    cuts,
    keptDur,
    effectiveKeptPct: Math.round((keptDur / totalDur) * 100),
  };
}

/**
 * Brute-force reference (test-only): enumerate all subsets. Exponential —
 * callers must keep n small (≤ ~18). Verifies the DP is exact.
 */
function bruteForceSelect(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const us = applyConstraints(units, o);
  const n = us.length;
  let costOf, budget;
  if (o.mode === "condense") {
    const total = us.reduce((a, u) => a + u.dur, 0);
    const cell = Math.max(0.25, total / o.durationCellMax);
    costOf = (u) => Math.max(1, Math.round(u.dur / cell));
    const forced = us.filter((u) => u.mustKeep).reduce((a, u) => a + costOf(u), 0);
    budget = Math.max(Math.round((o.targetDuration ?? total) / cell), forced);
  } else {
    costOf = () => 1;
    const forcedCount = us.filter((u) => u.mustKeep).length;
    budget = Math.max(Math.min(n, o.keepCount ?? n), forcedCount);
  }
  const shortU = us.map((u) => u.dur < o.minKeepDur && !u.mustKeep);

  let best = null;
  outer: for (let mask = 0; mask < 1 << n; mask++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const kept = (mask >> i) & 1;
      if (us[i].mustKeep && !kept) continue outer;
      if (us[i].mustCut && kept) continue outer;
      if (kept) cost += costOf(us[i]);
      // isolated short keep?
      if (
        kept &&
        shortU[i] &&
        (i === 0 || !((mask >> (i - 1)) & 1)) &&
        (i === n - 1 || !((mask >> (i + 1)) & 1))
      )
        continue outer;
    }
    if (cost > budget) continue;
    let cuts = 0;
    let prevKept = true;
    let score = 0;
    for (let i = 0; i < n; i++) {
      const kept = ((mask >> i) & 1) === 1;
      if (!kept && prevKept) cuts++;
      if (kept) score += us[i].score ?? 0;
      prevKept = kept;
    }
    const obj = score - o.lambda * cuts;
    if (!best || obj > best.objective) {
      best = { mask, objective: obj };
    }
  }
  if (!best) return null;
  const keep = [];
  for (let i = 0; i < n; i++) keep.push(((best.mask >> i) & 1) === 1);
  return summarize(us, keep, o, best.objective);
}

module.exports = { selectUnits, bruteForceSelect, applyConstraints, DEFAULTS };
