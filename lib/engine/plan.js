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
const { decide } = require("./index");
const { buildIncluded } = fromWorkspaceShim();
const { craftBoundaries } = require("./boundary");

// buildIncluded lives in the web data layer conceptually; the server-side
// equivalent is trivial and kept here to avoid a web/ dependency.
function fromWorkspaceShim() {
  return {
    buildIncluded(units, keep) {
      const segs = [];
      for (let i = 0; i < units.length; i++) {
        if (!keep[i]) continue;
        const last = segs[segs.length - 1];
        if (last && units[i].start <= last.end + 0.05) last.end = units[i].end;
        else segs.push({ start: units[i].start, end: units[i].end });
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

  // S2 scores
  on("scoring every moment");
  const scored = await scoreUnits(units, {
    llm: p.llm,
    cachePath: p.cachePath,
    onProgress: (r, n) => on(`scoring every moment — pass ${r + 1} of ${n}`),
  });
  attachChapters(units, p.chapters);
  upgradePauses(units);

  // S3–S5: decide
  on("optimizing the cut");
  const selOpts = p.targetDuration
    ? { mode: "condense", targetDuration: p.targetDuration, lambda: 6, duration: p.duration }
    : {
        mode: "tighten",
        // gentle first pass: cut only clear junk; the review slider does the rest
        keepCount: units.filter((u) => (u.score ?? 65) >= 30).length,
        lambda: 6,
        duration: p.duration,
      };
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
    unitCount: units.length,
  };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

module.exports = { enginePlan, adaptWords, attachChapters };
