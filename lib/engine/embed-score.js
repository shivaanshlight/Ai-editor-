/**
 * lib/engine/embed-score.js — score every moment WITHOUT generative LLM calls.
 *
 * Instead of asking an LLM to rate each unit (dozens of slow calls, timeouts,
 * rate limits), we embed the whole transcript ONCE with a local model and score
 * each unit from cheap vector math + the audio/disfluency signals the engine
 * already computed. On a 2-hour video this is one fast embedding pass instead of
 * ~90 sequential API calls — seconds, not minutes, and it can never time out.
 *
 * What each unit's score blends:
 *   • relevance  — cosine similarity to the video's overall topic (centroid).
 *                  On-topic material scores higher; off-topic tangents lower.
 *   • novelty    — how different it is from what was just said. Verbose
 *                  restatements (low novelty) get pushed down; the crisp first
 *                  statement of a point survives.
 *   • instruction— if the user typed a director's instruction, we embed it and
 *                  reward units close to it (semantic version of "keep the X").
 *   • signals    — energy (dead-air down, lively up), and hard disfluency flags
 *                  (filler / false start / retake → junk) plus a laugh boost.
 *
 * `embed` is INJECTED (async (texts) => unit vectors), so this module has no
 * hard dependency on the embedding backend and stays unit-testable.
 */

const DEFAULTS = {
  junk: 8, // filler / false-start / retake land here (below the junk floor)
  base: 30, // semantic scores span roughly base..base+spread
  spread: 55,
  noveltyWindow: 8, // compare against the previous N units for redundancy
  wRelevance: 0.5,
  wNovelty: 0.3,
  wInstruction: 0.45, // extra weight when a director's instruction is present
};

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
/** Min-max normalize an array to 0..1 (flat array → all 0.5). */
function minmax(arr) {
  let lo = Infinity,
    hi = -Infinity;
  for (const x of arr) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const range = hi - lo;
  if (!isFinite(range) || range < 1e-9) return arr.map(() => 0.5);
  return arr.map((x) => (x - lo) / range);
}
const JUNK_FLAGS = ["filler", "falseStart", "retake"];
function wordCount(t) {
  return String(t || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Score all units in place from embeddings + signals. Returns a Map(id →
 * {score, reason}) so callers can persist/cache exactly like the LLM tier.
 */
async function scoreByEmbedding(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!units.length) return new Map();

  // 1) embed every unit's text — in chunks so a multi-hour video (thousands of
  //    units) doesn't build one giant tensor. Still just a few local passes.
  const texts = units.map((u) => (u.text || "").trim() || "…");
  const CHUNK = o.embedChunk || 256;
  const vecsRaw = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const part = await o.embed(texts.slice(i, i + CHUNK));
    for (const v of part) vecsRaw.push(v);
    if (o.onProgress) o.onProgress(Math.min(i + CHUNK, texts.length), texts.length);
  }
  if (vecsRaw.length !== units.length) throw new Error("embedding count mismatch");
  const vecs = vecsRaw.map(normalize);

  // 2) topic centroid (mean of all vectors, renormalized).
  const dim = vecs[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] += v[i];
  for (let i = 0; i < dim; i++) centroid[i] /= vecs.length;
  const C = normalize(centroid);

  // 3) optional director's-instruction vector.
  let instrVec = null;
  const instr = (o.preferenceText || "").trim();
  if (instr) {
    try {
      const [iv] = await o.embed([instr.slice(0, 500)]);
      if (iv) instrVec = normalize(iv);
    } catch {}
  }

  // 4) per-unit raw components.
  const relevance = vecs.map((v) => dot(v, C));
  const instrRel = instrVec ? vecs.map((v) => dot(v, instrVec)) : null;
  const novelty = vecs.map((v, i) => {
    let maxSim = 0;
    for (let j = Math.max(0, i - o.noveltyWindow); j < i; j++) {
      const s = dot(v, vecs[j]);
      if (s > maxSim) maxSim = s;
    }
    return 1 - maxSim; // high = says something new
  });

  const relN = minmax(relevance);
  const novN = minmax(novelty);
  const instrN = instrRel ? minmax(instrRel) : null;

  // 5) blend + fold in signals → 0..100.
  const map = new Map();
  units.forEach((u, i) => {
    const flags = u.flags || [];

    // Hard junk: provable disfluency — straight to the floor, no semantics.
    if (flags.some((f) => JUNK_FLAGS.includes(f))) {
      const reason = flags.includes("filler")
        ? "filler run"
        : flags.includes("falseStart")
          ? "false start"
          : "near-duplicate retake";
      const e = { score: o.junk, reason };
      map.set(u.id, e);
      u.score = e.score;
      u.reason = e.reason;
      return;
    }

    // Semantic base.
    let semantic = o.wRelevance * relN[i] + o.wNovelty * novN[i];
    let wsum = o.wRelevance + o.wNovelty;
    if (instrN) {
      semantic += o.wInstruction * instrN[i];
      wsum += o.wInstruction;
    }
    semantic /= wsum; // 0..1
    let score = o.base + o.spread * semantic;

    // Signals.
    const reasons = [];
    if (typeof u.energyZ === "number") {
      score += Math.max(-8, Math.min(8, u.energyZ * 3)); // lively up, flat down
    }
    if (u.deadEnergy) {
      score -= 10;
      reasons.push("low energy");
    }
    if (u.highEnergy) {
      score += 5;
      reasons.push("high energy");
    }
    if (flags.includes("laugh")) {
      score += 12;
      u.moment = true;
      reasons.push("laughter");
    }
    if (flags.includes("repetition")) {
      score -= 8;
      reasons.push("repeats a nearby point");
    }
    const wc = wordCount(u.text);
    if (wc <= 3 && !flags.includes("laugh")) score -= 8; // tiny fragment
    if (relN[i] < 0.15) reasons.push("off-topic");
    else if (relN[i] > 0.8) reasons.push("on-topic");
    if (novN[i] > 0.8) reasons.push("new point");

    score = Math.max(0, Math.min(100, Math.round(score)));
    const reason = reasons.length ? reasons.join(", ") : "kept by embedding score";
    const e = { score, reason };
    map.set(u.id, e);
    u.score = score;
    u.reason = reason;
  });

  return map;
}

module.exports = { scoreByEmbedding, DEFAULTS };
