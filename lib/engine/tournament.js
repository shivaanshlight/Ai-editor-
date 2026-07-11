/**
 * lib/engine/tournament.js — M1.5 S2.5 pairwise tournament.
 *
 * Pointwise scores triage the easy 80%. For units near the selection
 * threshold — where the keep/cut decision is actually contested — LLMs judge
 * COMPARISONS far more reliably than absolute scores. So:
 *
 *   1. Find the borderline band: units within ±bandWidth score points of the
 *      provisional keep/cut threshold (non-locked, non-silence, capped).
 *   2. Round-robin pairwise comparisons inside the band. Every pair is asked
 *      TWICE with A/B order swapped — position bias cancels out. The prompt
 *      demands per-second value judgment — verbosity bias is named and banned.
 *   3. Merge rule: band-local win rate re-ranks the band (simple Borda count,
 *      no Elo machinery at this scale). New scores are interpolated across
 *      the band's own score range, so units OUTSIDE the band are untouched
 *      and the global scale stays intact.
 *
 * Cost stays bounded: only the band is compared, pairs are capped, and the
 * whole thing is skipped when no LLM is available.
 */

const DEFAULTS = {
  bandWidth: 8, // score points either side of the threshold
  maxBand: 12, // most units ever admitted to the band
  maxPairs: 40, // hard cap on comparisons (each asked twice)
};

const PAIR_SYSTEM = `You compare two transcript moments from the same video and pick which one earns its place in the edit.
Judge VALUE PER SECOND: information, emotion, story movement. A long rambling moment does NOT beat a short sharp one by being longer.
Reply ONLY with JSON: {"winner":"A"|"B"}.`;

function pairUser(a, b) {
  return [
    `A (${a.dur.toFixed(1)}s): ${a.text}`,
    ``,
    `B (${b.dur.toFixed(1)}s): ${b.text}`,
  ].join("\n");
}

/**
 * The provisional threshold: with keeps decided, the contested line sits
 * between the weakest kept unit and the strongest cut unit (forced keeps and
 * silence excluded from both sides).
 */
function findThreshold(units, keep) {
  let minKept = Infinity;
  let maxCut = -Infinity;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.silence || u.mustKeep || u.hook || u.closing) continue;
    if (typeof u.score !== "number") continue;
    if (keep[i]) minKept = Math.min(minKept, u.score);
    else maxCut = Math.max(maxCut, u.score);
  }
  if (!isFinite(minKept) && !isFinite(maxCut)) return null;
  if (!isFinite(minKept)) return maxCut;
  if (!isFinite(maxCut)) return minKept;
  return (minKept + maxCut) / 2;
}

/** Units admitted to the borderline band, nearest-to-threshold first. */
function pickBand(units, threshold, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (threshold == null) return [];
  return units
    .filter(
      (u) =>
        !u.silence &&
        !u.mustKeep &&
        !u.hook &&
        !u.closing &&
        typeof u.score === "number" &&
        Math.abs(u.score - threshold) <= o.bandWidth,
    )
    .sort((a, b) => Math.abs(a.score - threshold) - Math.abs(b.score - threshold))
    .slice(0, o.maxBand);
}

/**
 * Run the tournament on a band. Mutates band units' scores (re-ranked within
 * the band's own min..max score range). Returns { compared, pairs, reranked }.
 */
async function runTournament(band, llm, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (band.length < 2 || !llm) return { compared: 0, pairs: 0, reranked: false };

  // round-robin pairs, capped
  const pairs = [];
  outer: for (let i = 0; i < band.length; i++) {
    for (let j = i + 1; j < band.length; j++) {
      pairs.push([band[i], band[j]]);
      if (pairs.length >= o.maxPairs) break outer;
    }
  }

  const wins = new Map(band.map((u) => [u.id, 0]));
  const games = new Map(band.map((u) => [u.id, 0]));
  let compared = 0;

  for (const [a, b] of pairs) {
    // each pair judged twice with order swapped — position bias cancels
    for (const [first, second] of [
      [a, b],
      [b, a],
    ]) {
      try {
        const res = await llm(
          [
            { role: "system", content: PAIR_SYSTEM },
            { role: "user", content: pairUser(first, second) },
          ],
          { temperature: 0.2 },
        );
        const winner = res && res.winner === "B" ? second : first;
        wins.set(winner.id, (wins.get(winner.id) || 0) + 1);
        games.set(first.id, (games.get(first.id) || 0) + 1);
        games.set(second.id, (games.get(second.id) || 0) + 1);
        compared++;
      } catch {
        // a failed comparison is just skipped — pointwise order stands for it
      }
    }
  }
  if (!compared) return { compared: 0, pairs: pairs.length, reranked: false };

  // Borda: win rate orders the band; interpolate new scores across the band's
  // existing score range so the global scale is preserved.
  const lo = Math.min(...band.map((u) => u.score));
  const hi = Math.max(...band.map((u) => u.score));
  const ranked = band
    .slice()
    .sort((x, y) => {
      const wx = (wins.get(x.id) || 0) / Math.max(1, games.get(x.id) || 0);
      const wy = (wins.get(y.id) || 0) / Math.max(1, games.get(y.id) || 0);
      return wx - wy || x.score - y.score; // ascending: worst first
    });
  ranked.forEach((u, idx) => {
    const t = ranked.length === 1 ? 0.5 : idx / (ranked.length - 1);
    u.score = Math.round((lo + t * (hi - lo)) * 10) / 10;
    u.reason = (u.reason ? u.reason + " · " : "") + "rank confirmed by head-to-head";
    u.tournament = { winRate: Math.round(((wins.get(u.id) || 0) / Math.max(1, games.get(u.id) || 0)) * 100) / 100 };
  });

  return { compared, pairs: pairs.length, reranked: true };
}

/**
 * Convenience: provisional keep → threshold → band → tournament.
 * Call between scoring and the final decide().
 */
async function tournamentPass(units, provisionalKeep, llm, opts = {}) {
  const threshold = findThreshold(units, provisionalKeep);
  const band = pickBand(units, threshold, opts);
  const res = await runTournament(band, llm, opts);
  return { ...res, threshold, bandSize: band.length, bandIds: band.map((u) => u.id) };
}

module.exports = { tournamentPass, runTournament, pickBand, findThreshold, PAIR_SYSTEM, DEFAULTS };
