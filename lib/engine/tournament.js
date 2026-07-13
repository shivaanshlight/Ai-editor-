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
  pairsPerCall: 20, // BATCHED judging: many pairs per API call, not one —
  // per-pair calls put 80 requests through free-tier rate limits and turned
  // the tournament into minutes-to-hours of 429 backoff waiting.
};

const PAIR_SYSTEM = `You judge head-to-head matchups between transcript moments from the same video.
For EACH numbered pair, pick which moment earns its place in the edit.
Judge VALUE PER SECOND: information, emotion, story movement. A long rambling moment does NOT beat a short sharp one by being longer.
Reply ONLY with JSON: {"winners":["A"|"B", ...]} — exactly one entry per pair, in order.`;

function pairsUser(pairs, swapped) {
  return pairs
    .map(([a, b], i) => {
      const first = swapped ? b : a;
      const second = swapped ? a : b;
      return `Pair ${i + 1}:\nA (${first.dur.toFixed(1)}s): ${first.text}\nB (${second.dur.toFixed(1)}s): ${second.text}`;
    })
    .join("\n\n");
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

  // Every pair is judged twice — once in each presentation order, so
  // position bias cancels — but the judging is BATCHED: one API call per
  // direction per chunk of pairs instead of one call per comparison.
  for (const swapped of [false, true]) {
    for (let c = 0; c < pairs.length; c += o.pairsPerCall) {
      const chunk = pairs.slice(c, c + o.pairsPerCall);
      try {
        const res = await llm(
          [
            { role: "system", content: PAIR_SYSTEM },
            { role: "user", content: pairsUser(chunk, swapped) },
          ],
          { temperature: 0.2 },
        );
        const winners = Array.isArray(res?.winners) ? res.winners : [];
        chunk.forEach(([a, b], i) => {
          const w = winners[i];
          if (w !== "A" && w !== "B") return; // unanswered pair — skipped
          // in swapped order, displayed "A" is the original b
          const winner = w === "A" ? (swapped ? b : a) : (swapped ? a : b);
          wins.set(winner.id, (wins.get(winner.id) || 0) + 1);
          games.set(a.id, (games.get(a.id) || 0) + 1);
          games.set(b.id, (games.get(b.id) || 0) + 1);
          compared++;
        });
      } catch {
        // a failed batch is just skipped — pointwise order stands for it
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
