/**
 * lib/engine/plan.js — M1 glue: server-shaped inputs → engine plan.
 *
 * One call that runs the whole M1 decision layer for an upload:
 *
 *   words → segment → S0 signals (energy/SNR/scene when media given)
 *         → S2 scores (llm ladder) → dramatic pauses → decide()
 *         → boundary craft → { keeps, blocks, summary, tier }
 *
 * `blocks` are ReviewBlocks enriched with score / reason / speaker / chapter
 * / hook / closing / highEnergy — exactly what the Workspace UI renders.
 * Word objects keep their global transcript index so word-level edits and
 * re-renders keep working unchanged.
 */

const { segment } = require("./segment");
const { applySignals, upgradePauses, extractEnergyFrames, extractSceneCuts } = require("./analyze");
const { scoreUnits } = require("./score");
const { tournamentPass } = require("./tournament");
const { loadRecent, preferenceBlock } = require("./telemetry");
const { decide } = require("./index");
const { buildIncluded } = fromWorkspaceShim();
const { craftBoundaries } = require("./boundary");

// buildIncluded lives in the web data layer conceptually; the server-side
// equivalent is kept here to avoid a web/ dependency.
//
// CRITICAL: consecutive kept units merge into ONE segment, bridging the
// natural inter-sentence pause between them. Splitting on those pauses (a)
// turns every sentence gap into a jump cut, and (b) explodes the segment
// count past the renderer's fast-seek limit (240), silently switching a
// minutes-long render into a full-source decode that takes an hour.
// A cut only exists where a unit between two keeps was actually removed.
function fromWorkspaceShim() {
  return {
    buildIncluded(units, keep, maxBridge = 1.5) {
      const segs = [];
      let prevKept = false;
      for (let i = 0; i < units.length; i++) {
        if (!keep[i]) {
          prevKept = false;
          continue;
        }
        const last = segs[segs.length - 1];
        const gap = last ? units[i].start - last.end : Infinity;
        // bridge breathing pauses; still split on dead air (> maxBridge)
        if (last && prevKept && gap <= maxBridge) last.end = units[i].end;
        else segs.push({ start: units[i].start, end: units[i].end });
        prevKept = true;
      }
      return segs;
    },
  };
}

/** server words {word,start,end} → engine words {w,s,e,i} (index preserved). */
function adaptWords(words) {
  return (words || []).map((w, i) => ({
    w: (w.word || "").trim(),
    s: w.start,
    e: w.end,
    i,
  }));
}

/** map job.chapters [{start,end,title}] onto units by midpoint. */
function attachChapters(units, chapters) {
  if (!chapters || !chapters.length) return;
  for (const u of units) {
    if (u.chapter) continue; // outline beats win
    const mid = (u.start + u.end) / 2;
    const c = chapters.find((c) => mid >= c.start && mid < c.end);
    if (c) u.chapter = c.title;
  }
}

/**
 * @param {object} p
 *   words        server transcript words
 *   duration     media duration (sec)
 *   utterances   diarization utterances [{speaker,start,end}] (optional)
 *   chapters     [{start,end,title}] (optional)
 *   mediaPath    source file for ffmpeg signals (optional)
 *   llm          async (messages,{temperature})=>json — omit for deterministic tier
 *   cachePath    score-cache file (optional)
 *   targetDuration  seconds → condense mode; absent → gentle tighten
 *   onProgress   (stage:string) => void
 */
async function enginePlan(p) {
  const on = p.onProgress || (() => {});

  on("segmenting the transcript");
  const units = segment(adaptWords(p.words));
  if (!units.length) throw new Error("engine: no units from transcript");

  // S0 signals — best-effort; never block the plan on ffmpeg
  on("listening for energy & scenes");
  let frames = null;
  let sceneTimes = null;
  if (p.mediaPath) {
    try {
      [frames, sceneTimes] = await Promise.all([
        extractEnergyFrames(p.mediaPath),
        extractSceneCuts(p.mediaPath),
      ]);
    } catch {}
  }
  applySignals(units, {
    frames: frames
      ? frames.map((f) => ({ t: f.t, rms: f.rms })) // dB frames fine — analyze handles both
      : null,
    utterances: p.utterances || [],
    sceneTimes: sceneTimes || [],
    duration: p.duration,
  });

  // S2 scores — batchSize scales with the provider: Gemini big-context takes
  // the whole transcript in one batch (no chunking artifacts), Groq stays small.
  on("scoring every moment");
  const scored = await scoreUnits(units, {
    llm: p.llm,
    batchSize: p.batchSize,
    cachePath: p.cachePath,
    // M3: the editor learns your taste — recent review corrections ride along
    // as few-shot preference lines in the scoring prompt.
    preferenceText: p.telemetryPath ? preferenceBlock(loadRecent(p.telemetryPath)) : "",
    onProgress: (r, n) => on(`scoring every moment — pass ${r + 1} of ${n}`),
  });
  attachChapters(units, p.chapters);
  upgradePauses(units);

  const selOpts = p.targetDuration
    ? { mode: "condense", targetDuration: p.targetDuration, lambda: 6, duration: p.duration }
    : {
        mode: "tighten",
        // gentle first pass: cut only clear junk; the review slider does the rest
        keepCount: units.filter((u) => (u.score ?? 65) >= 30).length,
        lambda: 6,
        duration: p.duration,
      };

  // S2.5 — pairwise tournament in the borderline band (only when an LLM and
  // fresh scores exist; cached scores were already tournament-adjusted).
  let tourney = null;
  if (p.llm && scored.tier === "llm" && !scored.fromCache) {
    on("head-to-head on the borderline moments");
    try {
      const provisional = decide(units, selOpts);
      tourney = await tournamentPass(units, provisional.keep, p.llm);
    } catch {}
  }

  // S3–S5: decide
  on("optimizing the cut");
  const out = decide(units, selOpts);

  // S4 on the kept set
  const rough = fromWorkspaceShim().buildIncluded(units, out.keep);
  const engineWords = adaptWords(p.words);
  const keeps = craftBoundaries(rough, engineWords, { duration: p.duration }).map((s) => ({
    start: s.start,
    end: s.end,
  }));

  // Rich review blocks — every unit, kept or cut, with its evidence.
  const blocks = units.map((u, i) => ({
    start: round3(u.start),
    end: round3(u.end),
    type: out.keep[i] ? "keep" : "cut",
    words: u.words.map((w) => ({ i: w.i, w: w.w, s: w.s, e: w.e })),
    score: u.score,
    reason: u.reason,
    speaker: u.speaker,
    chapter: u.chapter,
    hook: !!u.hook,
    closing: !!u.closing,
    highEnergy: !!u.highEnergy,
  }));

  const junkCut = units.filter(
    (u, i) => !out.keep[i] && (u.flags.includes("filler") || u.flags.includes("falseStart") || u.flags.includes("retake")),
  ).length;
  const summary = `Engine cut ${out.cuts} splice${out.cuts === 1 ? "" : "s"} (${junkCut} junk unit${junkCut === 1 ? "" : "s"}) · scored by ${scored.tier}${scored.fromCache ? " (cached)" : ""}`;

  return {
    keeps,
    blocks,
    summary,
    tier: scored.tier,
    findings: out.findings,
    tournament: tourney,
    unitCount: units.length,
  };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * M3 Cold Open: lift the segment containing the hook to the front of the EDL
 * as a teaser; everything else stays chronological. No-op when the hook is
 * already first or can't be found.
 */
function liftColdOpen(keeps, hookStart) {
  if (hookStart == null || !keeps.length) return keeps;
  const idx = keeps.findIndex((s) => hookStart >= s.start - 0.05 && hookStart < s.end + 0.05);
  if (idx <= 0) return keeps;
  return [keeps[idx], ...keeps.slice(0, idx), ...keeps.slice(idx + 1)];
}

module.exports = { enginePlan, adaptWords, attachChapters, liftColdOpen };
