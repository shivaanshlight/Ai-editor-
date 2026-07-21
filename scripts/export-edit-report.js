/**
 * scripts/export-edit-report.js — turn an edit into a readable report.
 *
 *   node scripts/export-edit-report.js            # most recent AI edit
 *   node scripts/export-edit-report.js <jobId>    # a specific job
 *
 * Regenerates the engine's plan from the stored transcript + CACHED scores
 * (no new LLM calls, no cost), then writes:
 *   1. A full timeline to  edit-report-<jobId>.md   (browse every line)
 *   2. A compact summary to the console             (paste THIS to Claude)
 *
 * The compact summary surfaces the decisions worth reviewing — the weakest
 * lines it KEPT and the strongest lines it CUT — which is exactly what you
 * need to judge whether the edit is good.
 */

const fs = require("fs");
const path = require("path");

// same .env loader as server.js / check-ai.js
try {
  for (const line of fs
    .readFileSync(path.join(__dirname, "..", ".env"), "utf8")
    .split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const store = require("../lib/supabase");
const { enginePlan } = require("../lib/engine/plan");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

function ts(sec) {
  if (sec == null || !isFinite(sec)) return "--:--";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const S = String(ss).padStart(2, "0");
  return h ? `${h}:${mm}:${S}` : `${mm}:${S}`;
}

function textOf(b) {
  if (b.text) return b.text;
  return (b.words || []).map((w) => w.w).join(" ").replace(/\s+/g, " ").trim();
}

function clip(str, n) {
  str = String(str || "").replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

(async () => {
  let jobs;
  try {
    jobs = await store.loadJobs(200);
  } catch (e) {
    console.error("Could not load jobs from Supabase:", e.message);
    console.error("Make sure the server can reach Supabase (it says 'connected ✓' at boot).");
    process.exit(1);
  }

  // Transcripts are stored separately (keyed by transcript_fp), so a loaded job
  // usually has empty .words until we fetch it — same as the server's ensureWords.
  async function loadWords(j) {
    if (j.words && j.words.length) return j.words;
    if (j.transcript_fp) {
      const t = await store.getTranscript(j.transcript_fp).catch(() => null);
      if (t && t.words && t.words.length) {
        j.words = t.words;
        return j.words;
      }
    }
    return [];
  }

  const listLine = (j) =>
    `  ${j.id}  [${j.mode || "?"}/${j.status || "?"}]  ${ts(j.meta?.duration || 0)}  ${j.originalName || ""}`;
  const recent = jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const argId = process.argv[2];

  // `list` — just show every job so you can copy an id
  if (argId === "list" || argId === "--list") {
    console.log("Your jobs (newest first):\n" + recent.map(listLine).join("\n"));
    return;
  }

  let job;
  if (argId) {
    job = jobs.find((j) => j.id === argId);
    if (!job) return console.error(`No job with id ${argId}.\nRun 'node scripts/export-edit-report.js list' to see all jobs.`);
  } else {
    // most recent AI/highlights edit whose transcript can be loaded
    const cands = recent.filter((j) => j.mode === "ai" || j.mode === "highlights");
    for (const c of cands) {
      if ((await loadWords(c)).length) {
        job = c;
        break;
      }
    }
    if (!job)
      return console.error(
        "No AI edit with a loadable transcript found.\nAll jobs:\n" +
          recent.map(listLine).join("\n") +
          "\n\nPick one and run: node scripts/export-edit-report.js <jobId>",
      );
  }

  await loadWords(job);
  if (!job.words || !job.words.length)
    return console.error(
      `Job ${job.id} has no stored transcript to rebuild from. Try another id (run 'list').`,
    );

  const duration = job.meta?.duration || 0;
  const s = job.settings || {};
  console.error(`Rebuilding plan for "${job.originalName || job.id}" (${ts(duration)})…`);

  const eng = await enginePlan({
    words: job.words,
    duration,
    utterances: job.speakers || [],
    chapters: job.chapters || [],
    // no mediaPath: skip ffmpeg signals (source may be gone; not needed for text)
    llm: null, // cached scores are reused; no new LLM calls / cost
    cachePath: path.join(UPLOAD_DIR, `${job.id}.scores.json`),
    targetDuration: s.targetDuration ? parseFloat(s.targetDuration) : undefined,
  }).catch((e) => {
    console.error("Could not rebuild the plan:", e.message);
    process.exit(1);
  });

  const blocks = eng.blocks || [];
  const kept = blocks.filter((b) => b.type === "keep");
  const cut = blocks.filter((b) => b.type === "cut");
  const keptDur = kept.reduce((t, b) => t + (b.end - b.start), 0);
  const hook = blocks.find((b) => b.hook);
  const closer = blocks.find((b) => b.closing);

  /* ---------- 1) full timeline → markdown file ---------- */
  const md = [];
  md.push(`# Edit Report — ${job.originalName || job.id}`);
  md.push("");
  md.push(`- Source length: **${ts(duration)}**`);
  md.push(`- Kept: **${kept.length}/${blocks.length}** units · runtime **${ts(keptDur)}**`);
  md.push(`- Scored by: **${eng.tier}**${eng.scoreError ? ` (fell back: ${eng.scoreError})` : ""}`);
  md.push(`- Summary: ${eng.summary || "—"}`);
  if (hook) md.push(`- Hook: [${ts(hook.start)}] ${clip(textOf(hook), 100)}`);
  if (closer) md.push(`- Closer: [${ts(closer.start)}] ${clip(textOf(closer), 100)}`);
  md.push("");
  md.push("## Timeline (✅ kept · ❌ cut)");
  md.push("");
  for (const b of blocks) {
    const mark = b.type === "keep" ? "✅" : "❌";
    const sc = typeof b.score === "number" ? String(b.score).padStart(3) : "  ·";
    const tags = [b.hook && "HOOK", b.closing && "CLOSER", b.chapter].filter(Boolean).join(" ");
    md.push(`- [${ts(b.start)}] ${mark} \`${sc}\` ${textOf(b)}${b.reason ? `  _— ${b.reason}_` : ""}${tags ? `  **${tags}**` : ""}`);
  }
  const mdPath = path.join(process.cwd(), `edit-report-${job.id}.md`);
  fs.writeFileSync(mdPath, md.join("\n"));

  /* ---------- 2) compact summary → console (paste this) ---------- */
  const scored = (arr) => arr.filter((b) => typeof b.score === "number");
  const weakestKept = scored(kept).sort((a, b) => a.score - b.score).slice(0, 15);
  const strongestCut = scored(cut).sort((a, b) => b.score - a.score).slice(0, 15);

  const out = [];
  out.push("=== EDIT REPORT — paste this to Claude ===");
  out.push(`Video: ${job.originalName || job.id} · ${ts(duration)} · scored by ${eng.tier}`);
  out.push(`Kept ${kept.length}/${blocks.length} units · runtime ${ts(keptDur)} · ${eng.summary || ""}`);
  if (hook) out.push(`HOOK   [${ts(hook.start)}] "${clip(textOf(hook), 90)}"`);
  if (closer) out.push(`CLOSER [${ts(closer.start)}] "${clip(textOf(closer), 90)}"`);
  out.push("");
  out.push(`⚠️ WEAKEST LINES IT KEPT (did it keep filler/rambling?) — ${weakestKept.length}:`);
  for (const b of weakestKept)
    out.push(`  [${ts(b.start)}] ${String(b.score).padStart(3)} "${clip(textOf(b), 85)}"${b.reason ? ` — ${b.reason}` : ""}`);
  out.push("");
  out.push(`⚠️ STRONGEST LINES IT CUT (did it drop something good?) — ${strongestCut.length}:`);
  for (const b of strongestCut)
    out.push(`  [${ts(b.start)}] ${String(b.score).padStart(3)} "${clip(textOf(b), 85)}"${b.reason ? ` — ${b.reason}` : ""}`);
  // Length options — all free (cached scores), no LLM calls.
  out.push("");
  out.push("📏 LENGTH OPTIONS (same scoring, pick your cut):");
  for (const [name, kf] of [["Tight", 0.45], ["Balanced", 0.65], ["Full", 0.85]]) {
    const e = await enginePlan({
      words: job.words,
      duration,
      utterances: job.speakers || [],
      chapters: job.chapters || [],
      llm: null,
      cachePath: path.join(UPLOAD_DIR, `${job.id}.scores.json`),
      keepFraction: kf,
    }).catch(() => null);
    if (e) {
      const rt = e.keeps.reduce((t, k) => t + (k.end - k.start), 0);
      out.push(`  ${name.padEnd(9)} ${ts(rt)}  (${Math.round((rt / (duration || 1)) * 100)}% of source, ${e.keeps.length} segments)`);
    }
  }
  out.push("");
  out.push(`Full line-by-line report written to: ${mdPath}`);
  out.push("=== end ===");

  console.log(out.join("\n"));
})();
