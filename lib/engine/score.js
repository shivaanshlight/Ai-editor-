/**
 * lib/engine/score.js — M1 S2 scorer.
 *
 * Structure-first pass over the whole transcript, engineered around the
 * failure modes v3 documented:
 *
 *   BATCHED OUTPUT   units are scored in batches; the model returns a JSON
 *                    array of {id, score, reason, mergeWithNext?}. Any unit
 *                    MISSING from the reply is KEPT by default (safe score,
 *                    explicit reason) — a truncated reply can never silently
 *                    cut material.
 *   DIVERSIFIED ×3   the same batch is scored in `runs` passes at different
 *                    temperatures; per-unit MEDIAN wins. One flaky pass
 *                    cannot nuke a good moment.
 *   OUTLINE FIRST    a whole-video outline names the hook unit, the closing
 *                    unit, and chapter beats before any per-unit scoring.
 *   FALLBACK LADDER  llm → deterministic (disfluency-flag scores). The
 *                    engine never hard-fails a job because a provider
 *                    throttles; the result reports which tier produced it.
 *   SCORE CACHE      content-hash keyed; slider moves and re-edits cost zero
 *                    LLM calls.
 *
 * The LLM is INJECTED: `opts.llm = async (messages, {temperature}) => parsed
 * JSON`. Tests pass mocks; server.js passes the Groq/Gemini adapter.
 */

const crypto = require("crypto");
const fs = require("fs");
const { scoreByEmbedding } = require("./embed-score");

const DEFAULTS = {
  runs: 3,
  temperatures: [0.1, 0.4, 0.7],
  batchSize: 40,
  defaultScore: 65, // missing ⇒ keep: comfortably above cut thresholds
  heuristics: { junk: 8, filler: 12, plain: 62 },
  // Smart-skip: don't spend an LLM call on units that are PROVABLY junk — the
  // segmenter already flagged them. Only the ambiguous middle goes to the model.
  // On a long raw recording (lots of filler / false starts / dead air) this cuts
  // the number of LLM calls dramatically. Conservative by design: we auto-CUT
  // obvious junk but never auto-KEEP, so nothing sneaks INTO the edit unscored.
  smartSkip: true,
  deadAirMaxWords: 6, // a dead-energy unit this short is treated as skippable filler
  // The whole-video outline stuffs EVERY unit into one prompt; past this many
  // units that overflows a small local context and stalls, so we skip it (its
  // hook/closing/chapter hints have deterministic fallbacks anyway).
  outlineMaxUnits: 400,
};

/* --------------------------------- cache ----------------------------------- */

function contentHash(units, salt = "") {
  const h = crypto.createHash("sha1");
  for (const u of units) h.update(u.text + " ");
  // Salt with the instruction/taste so a different directive re-scores instead
  // of returning cached scores computed under the old preferences.
  if (salt) h.update(" " + salt);
  return h.digest("hex");
}

function readCache(cachePath, hash) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (j && j.hash === hash) return j;
  } catch {}
  return null;
}

function writeCache(cachePath, payload) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify(payload));
  } catch {}
}

/* ------------------------------- heuristics --------------------------------- */

/** Deterministic score for one unit from its disfluency flags. */
function heuristicOne(u, o) {
  if (u.flags.includes("retake")) return { score: o.heuristics.junk, reason: "near-duplicate retake" };
  if (u.flags.includes("falseStart")) return { score: o.heuristics.junk, reason: "false start" };
  if (u.flags.includes("filler")) return { score: o.heuristics.filler, reason: "filler run" };
  if (u.lowQuality) return { score: o.heuristics.plain, reason: "kept — flagged low audio quality" };
  return { score: o.heuristics.plain, reason: "kept by the deterministic pass" };
}

/** Deterministic tier: flags in, sane scores out. No network. */
function heuristicScores(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const map = new Map();
  for (const u of units) map.set(u.id, heuristicOne(u, o));
  return map;
}

/**
 * Split units into ones we can score WITHOUT the LLM (provable junk) and the
 * ambiguous ones that still need it. Returns { auto: Map(id→{score,reason}),
 * llmUnits: [] }. Only auto-CUTS — a unit is skipped only when its flags make
 * it junk regardless of content, so the edit's KEEP decisions still all come
 * from the model (or the safe default).
 */
function prefilter(units, o) {
  const auto = new Map();
  const llmUnits = [];
  const JUNK_FLAGS = ["filler", "falseStart", "retake"];
  for (const u of units) {
    const flags = u.flags || [];
    if (flags.some((f) => JUNK_FLAGS.includes(f))) {
      auto.set(u.id, heuristicOne(u, o)); // filler/false-start/retake → deterministic cut score
      continue;
    }
    // Dead-air fragment: low-energy AND barely any words — safe to treat as junk.
    if (u.deadEnergy) {
      const words = (u.text || "").trim().split(/\s+/).filter(Boolean).length;
      if (words <= o.deadAirMaxWords) {
        auto.set(u.id, { score: o.heuristics.filler, reason: "dead-air, low value" });
        continue;
      }
    }
    llmUnits.push(u); // ambiguous → the model decides
  }
  return { auto, llmUnits };
}

/* --------------------------------- prompts ---------------------------------- */

const OUTLINE_SYSTEM = `You are a story editor analyzing a full video transcript split into numbered units.
Reply ONLY with JSON: {"beats":[{"title":str,"firstUnit":int,"lastUnit":int}...],
"hookUnit":int|null,"closingUnit":int|null}.
hookUnit = the single strongest cold-open moment. closingUnit = the natural final line.`;

const SCORE_SYSTEM = `You score transcript units for an edit. For EACH unit id given, output an entry.
Rubric (0-100): 90+ unmissable (emotional peak, core lesson, punchline, concrete story beat);
70-89 strong; 40-69 useful context; 20-39 weak/redundant; <20 junk (filler, false start, retake, pleasantry).
Long rambling restatements score LOW even when on-topic. Do not reward length.
If a DIRECTOR'S INSTRUCTION or USER PREFERENCE is given, it OVERRIDES the rubric:
push matching moments toward 90+ and non-matching ones toward <20 accordingly.
Reply ONLY with JSON: {"scores":[{"id":int,"score":int,"reason":"<12 words"}...]}.
Include an entry for EVERY id you were given. Optional field "mergeWithNext":true when a unit is an incomplete thought.`;

function outlineUser(units) {
  return [
    "Units:",
    ...units.map((u) => `${u.id}\t${u.speaker ? u.speaker + ": " : ""}${u.text}`),
  ].join("\n");
}

function batchUser(units, outline, preferenceText) {
  const beats = outline?.beats?.length
    ? "Outline: " + outline.beats.map((b) => b.title).join(" → ")
    : "";
  return [beats, preferenceText || "", "Score these units:", ...units.map((u) => `${u.id}\t${u.text}`)]
    .filter(Boolean)
    .join("\n");
}

/* ---------------------------------- merge ----------------------------------- */

/** Median score per id across runs; reasons from the middle run that had it. */
function mergeRuns(runs) {
  const byId = new Map();
  for (const run of runs) {
    for (const e of run) {
      if (e == null || e.id == null || typeof e.score !== "number") continue;
      if (!byId.has(e.id)) byId.set(e.id, []);
      byId.get(e.id).push(e);
    }
  }
  const out = new Map();
  for (const [id, list] of byId) {
    list.sort((a, b) => a.score - b.score);
    const mid = list[Math.floor(list.length / 2)];
    out.set(id, {
      score: mid.score,
      reason: mid.reason || "",
      mergeWithNext: list.filter((e) => e.mergeWithNext).length > list.length / 2,
    });
  }
  return out;
}

/**
 * Apply a score map. Units missing from it are KEPT by default — with one
 * carve-out: units the segmenter already flagged as disfluent junk fall back
 * to their deterministic heuristic score instead. "Missing ⇒ keep" exists to
 * protect real content from truncated replies; provably-flagged junk does not
 * need the LLM's confirmation to stay junk.
 */
function applyScores(units, map, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const JUNK_FLAGS = ["filler", "falseStart", "retake"];
  let missing = 0;
  for (const u of units) {
    const e = map.get(u.id);
    if (e) {
      u.score = Math.max(0, Math.min(100, Math.round(e.score)));
      u.reason = e.reason || u.reason;
      if (e.mergeWithNext) u.mergeWithNext = true;
    } else if (u.flags && u.flags.some((f) => JUNK_FLAGS.includes(f))) {
      const h = heuristicOne(u, o);
      u.score = h.score;
      u.reason = h.reason + " (unscored by LLM)";
      missing++;
    } else {
      u.score = o.defaultScore;
      u.reason = "unscored — kept by default";
      missing++;
    }
  }
  return missing;
}

/* ------------------------------- orchestrator -------------------------------- */

/**
 * Score all units in place. Returns { tier, outline, missing, fromCache }.
 * opts.llm: async (messages, {temperature}) => parsed JSON object.
 */
async function scoreUnits(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hash = contentHash(units, o.preferenceText || "");

  if (o.cachePath) {
    const cached = readCache(o.cachePath, hash);
    if (cached) {
      applyScores(units, new Map(cached.scores.map((e) => [e.id, e])));
      markStructure(units, cached.outline);
      return { tier: cached.tier, outline: cached.outline, missing: 0, fromCache: true };
    }
  }

  // DEFAULT TIER: embeddings + signals. One local embedding pass scores every
  // moment in seconds — no generative LLM calls, no timeouts, no rate limits.
  // Falls through to the LLM/heuristic tiers below if the embedder errors.
  if (o.embed) {
    try {
      if (o.onProgress) o.onProgress(0, 1);
      const map = await scoreByEmbedding(units, {
        embed: o.embed,
        preferenceText: o.preferenceText,
        onProgress: o.onProgress,
      });
      markStructure(units, null); // hook/closing via score-based fallbacks
      persist(o, hash, "embed", null, map);
      if (o.onProgress) o.onProgress(1, 1);
      return { tier: "embed", outline: null, missing: 0, fromCache: false };
    } catch (e) {
      // fall through to the LLM/heuristic tiers
      if (o.onProgress) o.onProgress(1, 1);
      // eslint-disable-next-line no-console
      console.error(`embedding scorer failed (${e.message}) — falling back.`);
    }
  }

  if (!o.llm) {
    const map = heuristicScores(units, o);
    applyScores(units, map, o);
    markStructure(units, null);
    persist(o, hash, "deterministic", null, map);
    return { tier: "deterministic", outline: null, missing: 0, fromCache: false };
  }

  try {
    // 0) smart-skip: score provable junk deterministically; only the ambiguous
    //    units reach the LLM. On a long raw recording this is most of the win.
    const { auto, llmUnits } = o.smartSkip
      ? prefilter(units, o)
      : { auto: new Map(), llmUnits: units };
    const toScore = llmUnits.length ? llmUnits : units; // never send an empty set

    // 1) whole-video outline — skipped on long videos (one giant prompt that
    //    overflows a small local context and stalls; fallbacks cover it).
    let outline = null;
    if (units.length <= o.outlineMaxUnits) {
      try {
        outline = await o.llm(
          [
            { role: "system", content: OUTLINE_SYSTEM },
            { role: "user", content: outlineUser(units) },
          ],
          { temperature: 0.2 },
        );
      } catch {
        outline = null; // outline is an optimization, not a requirement
      }
    }

    // 2) batched scoring × diversified runs — runs execute IN PARALLEL
    // (they're independent by design; sequential execution tripled the
    // wall-clock for no reason). Progress counts completed batches across
    // all runs so the UI moves instead of sitting at 0%.
    const batches = [];
    for (let i = 0; i < toScore.length; i += o.batchSize) batches.push(toScore.slice(i, i + o.batchSize));
    const totalCalls = o.runs * batches.length;
    let doneCalls = 0;
    const runResults = await Promise.all(
      Array.from({ length: o.runs }, async (_, r) => {
        const temp = o.temperatures[r % o.temperatures.length];
        const entries = [];
        for (const batch of batches) {
          const res = await o.llm(
            [
              { role: "system", content: SCORE_SYSTEM },
              { role: "user", content: batchUser(batch, outline, o.preferenceText) },
            ],
            { temperature: temp },
          );
          for (const e of res?.scores || []) entries.push(e);
          doneCalls++;
          if (o.onProgress) o.onProgress(doneCalls, totalCalls);
        }
        return entries;
      }),
    );

    const map = mergeRuns(runResults);
    // Fold in the deterministic auto-scores for the skipped junk units.
    for (const [id, e] of auto) if (!map.has(id)) map.set(id, e);
    const missing = applyScores(units, map, o);
    markStructure(units, outline);
    persist(o, hash, "llm", outline, map);
    return { tier: "llm", outline, missing, skipped: auto.size, scored: toScore.length, fromCache: false };
  } catch (err) {
    // fallback ladder: deterministic tier, never hard-fail
    const map = heuristicScores(units, o);
    applyScores(units, map, o);
    markStructure(units, null);
    return {
      tier: "deterministic",
      outline: null,
      missing: 0,
      fromCache: false,
      error: String(err && err.message ? err.message : err),
    };
  }
}

/** Hook / closing / chapters from the outline (safe fallbacks without one). */
function markStructure(units, outline) {
  if (outline) {
    const hookId = outline.hookUnit;
    const closeId = outline.closingUnit;
    for (const u of units) {
      if (hookId != null && u.id === hookId) u.hook = true;
      if (closeId != null && u.id === closeId) u.closing = true;
    }
    for (const b of outline.beats || []) {
      if (b.firstUnit == null || b.lastUnit == null || !b.title) continue;
      for (const u of units) {
        if (u.id >= b.firstUnit && u.id <= b.lastUnit && !u.chapter) u.chapter = b.title;
      }
    }
  }
  // fallbacks: highest-scored early unit as hook, last unit as closer
  if (!units.some((u) => u.hook) && units.length) {
    const early = units.slice(0, Math.max(3, Math.ceil(units.length * 0.15)));
    const best = early.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (best) best.hook = true;
  }
  if (!units.some((u) => u.closing) && units.length) {
    units[units.length - 1].closing = true;
  }
}

function persist(o, hash, tier, outline, map) {
  if (!o.cachePath) return;
  writeCache(o.cachePath, {
    hash,
    tier,
    outline,
    scores: Array.from(map.entries()).map(([id, e]) => ({ id, ...e })),
  });
}

module.exports = {
  scoreUnits,
  heuristicScores,
  prefilter,
  mergeRuns,
  applyScores,
  markStructure,
  contentHash,
  OUTLINE_SYSTEM,
  SCORE_SYSTEM,
  DEFAULTS,
};
