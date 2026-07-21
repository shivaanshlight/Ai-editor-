/**
 * lib/engine/segment.js — M0 Segmenter (S0, text half).
 *
 * Words with timestamps → "thought units": sentence-sized complete thoughts.
 * The atomic unit of the whole engine — we never cut inside one. Deterministic,
 * local, zero-cost; segmentation accuracy is measured by its own EditBench
 * fixtures because everything downstream keys off these boundaries.
 *
 * Boundary rules (in priority order):
 *   1. sentence-final punctuation ( . ? ! … )   — unless the "sentence" is
 *      still tiny (abbreviation guard) and the pause is negligible
 *   2. speaker change (when word.speaker is present)
 *   3. pause gap ≥ opts.pauseSplit seconds
 *   4. force-split at the biggest internal pause when a unit exceeds
 *      opts.maxUnitDur seconds
 *
 * Word shape in:  { w, s, e, speaker? }   (text, start sec, end sec)
 * Unit shape out: {
 *   id, start, end, dur, text, speaker?, words: [...],
 *   flags: ["filler"|"falseStart"|"retake"|"mergeWithNext"],
 *   pauseBefore: { s, kind: "rambling"|"neutral" },
 *   pauseAfter:  { s, kind: "rambling"|"neutral" },
 * }
 * ("dramatic" pause classification needs the M1 energy/salience signals; the
 *  field shape is already final so M1 only upgrades the "kind" values.)
 */

const DEFAULTS = {
  pauseSplit: 0.8, // gap that ends a thought even without punctuation
  maxUnitDur: 25, // force-split threshold (seconds)
  minSentenceWords: 3, // punctuation before this many words won't split alone
  retakeSimilarity: 0.8, // fuzzy-dup threshold for retake detection
  retakeWindow: 2, // how many following units to compare for retakes
  repetitionSimilarity: 0.55, // looser paraphrase threshold (below a full retake)
};

const TERMINAL_RE = /[.?!…]["'”’)\]]*$/;
const FILLER_WORD_RE = /^(um+|uh+|erm+|hmm+|mmm+|like|so|yeah|right|okay|ok|well|actually|basically|literally|honestly|anyway|totally|wow)[,.]?$/i;
const FILLER_PHRASE_RE = /\b(you know|i mean|sort of|kind of)\b/i;
const FALSE_START_RE =
  /\b(wait[,—\s]|let me (say|start|redo|try) (that|this|again)|let me —|sorry[,—\s]+(let me|i'?ll)|scratch that|take (that|two)|start (over|again)|redo (that|this))\b/i;
// Laughter / genuine "moment" markers — whisper transcribes these variously.
const LAUGH_RE = /\[laugh|\(laugh|\bha ?ha+\b|\bhaha+\b|\bhehe+\b|\blmao\b|\blol\b/i;

function norm(w) {
  return String(w).toLowerCase().replace(/[^a-z0-9']/g, "");
}

/* --------------------------------- split ---------------------------------- */

function segmentWords(words, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const units = [];
  let cur = [];

  const flush = () => {
    if (cur.length) units.push(cur);
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    cur.push(w);

    if (!next) break;
    const gap = Math.max(0, (next.s ?? w.e) - (w.e ?? w.s));
    const speakerFlip = w.speaker != null && next.speaker != null && w.speaker !== next.speaker;
    const terminal = TERMINAL_RE.test(w.w);
    const bigPause = gap >= o.pauseSplit;

    if (speakerFlip) {
      flush();
      continue;
    }
    if (terminal && (cur.length >= o.minSentenceWords || bigPause)) {
      flush();
      continue;
    }
    if (bigPause) flush();
  }
  flush();

  // Force-split oversized units at their biggest internal pause.
  const sized = [];
  for (const u of units) {
    let stack = [u];
    while (stack.length) {
      const g = stack.shift();
      const dur = (g[g.length - 1].e ?? g[g.length - 1].s) - (g[0].s ?? 0);
      if (dur <= o.maxUnitDur || g.length < 4) {
        sized.push(g);
        continue;
      }
      let bestI = -1;
      let bestGap = -1;
      for (let i = 1; i < g.length - 1; i++) {
        const gap = (g[i + 1]?.s ?? g[i].e) - g[i].e;
        if (gap > bestGap) {
          bestGap = gap;
          bestI = i;
        }
      }
      stack.unshift(g.slice(0, bestI + 1), g.slice(bestI + 1));
    }
  }

  return sized.map((ws, idx) => {
    const start = ws[0].s ?? 0;
    const end = ws[ws.length - 1].e ?? start;
    return {
      id: idx,
      start,
      end,
      dur: Math.max(0.01, end - start),
      text: ws.map((x) => x.w).join(" "),
      speaker: ws[0].speaker,
      words: ws,
      flags: [],
      pauseBefore: { s: 0, kind: "neutral" },
      pauseAfter: { s: 0, kind: "neutral" },
    };
  });
}

/* --------------------------------- flags ---------------------------------- */

/** Token-level Jaccard similarity — cheap fuzzy match for retake detection. */
function similarity(aText, bText) {
  const A = new Set(aText.split(/\s+/).map(norm).filter(Boolean));
  const B = new Set(bText.split(/\s+/).map(norm).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function fillerRatio(unit) {
  const toks = unit.words.map((w) => norm(w.w)).filter(Boolean);
  if (!toks.length) return 0;
  let f = 0;
  for (const t of toks) if (FILLER_WORD_RE.test(t)) f++;
  const phraseHits = (unit.text.match(new RegExp(FILLER_PHRASE_RE.source, "gi")) || []).length;
  return Math.min(1, (f + phraseHits * 2) / toks.length);
}

function flagUnits(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const flags = new Set();

    if (fillerRatio(u) >= 0.5 && u.words.length <= 12) flags.add("filler");
    if (FALSE_START_RE.test(u.text)) flags.add("falseStart");
    if (LAUGH_RE.test(u.text)) flags.add("laugh"); // a genuine moment — boosted downstream

    // Retake: this unit is a near-duplicate of one that follows shortly —
    // the EARLIER take is the junk (the speaker redid it).
    for (let k = 1; k <= o.retakeWindow && i + k < units.length; k++) {
      const later = units[i + k];
      if (
        u.words.length >= 4 &&
        later.words.length >= 4 &&
        (u.speaker == null || later.speaker == null || u.speaker === later.speaker) &&
        similarity(u.text, later.text) >= o.retakeSimilarity
      ) {
        flags.add("retake");
        break;
      }
    }

    // mergeWithNext: no terminal punctuation and the next unit follows almost
    // immediately from the same speaker — the thought spills over.
    const next = units[i + 1];
    if (
      next &&
      !TERMINAL_RE.test(u.words[u.words.length - 1].w) &&
      (u.speaker == null || next.speaker == null || u.speaker === next.speaker) &&
      next.start - u.end < 0.35 &&
      u.words.length <= 4
    ) {
      flags.add("mergeWithNext");
    }

    u.flags = Array.from(flags);
  }
  return units;
}

/**
 * Repetition collapse: the speaker makes the SAME point a few different ways
 * (a looser paraphrase than a full retake). Flag the LONGER, more verbose
 * restatement as "repetition" so the crisper version is the one that survives.
 * Soft signal — downstream applies only a mild score nudge, never a hard cut.
 */
function flagRepetition(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.words.length < 5) continue;
    for (let k = 1; k <= o.retakeWindow && i + k < units.length; k++) {
      const later = units[i + k];
      if (later.words.length < 5) continue;
      if (!(u.speaker == null || later.speaker == null || u.speaker === later.speaker)) continue;
      const sim = similarity(u.text, later.text);
      if (sim >= o.repetitionSimilarity && sim < o.retakeSimilarity) {
        const longer = u.words.length >= later.words.length ? u : later;
        const skip = ["retake", "filler", "falseStart", "repetition"];
        if (!longer.flags.some((f) => skip.includes(f))) longer.flags.push("repetition");
      }
    }
  }
  return units;
}

/* ------------------------------- pause map -------------------------------- */

function classifyPauses(units) {
  const disfluent = (u) =>
    u && (u.flags.includes("filler") || u.flags.includes("falseStart") || u.flags.includes("retake"));
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const prev = units[i - 1];
    const next = units[i + 1];
    const before = prev ? Math.max(0, u.start - prev.end) : u.start;
    const after = next ? Math.max(0, next.start - u.end) : 0;
    // A pause adjacent to disfluent/incomplete material is rambling (compressible);
    // "dramatic" (protected) needs M1's energy+salience and is assigned there.
    u.pauseBefore = { s: round2(before), kind: disfluent(prev) || disfluent(u) ? "rambling" : "neutral" };
    u.pauseAfter = { s: round2(after), kind: disfluent(next) || disfluent(u) ? "rambling" : "neutral" };
  }
  return units;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** One-call pipeline: words → flagged, pause-classified thought units. */
function segment(words, opts = {}) {
  return classifyPauses(flagRepetition(flagUnits(segmentWords(words, opts), opts), opts));
}

module.exports = { segment, segmentWords, flagUnits, flagRepetition, classifyPauses, similarity, fillerRatio, DEFAULTS };
