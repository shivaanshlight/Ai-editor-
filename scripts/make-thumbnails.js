/**
 * scripts/make-thumbnails.js — pull thumbnail candidates from a video.
 *
 *   node scripts/make-thumbnails.js <jobId> [count]
 *   node scripts/make-thumbnails.js list
 *
 * Rebuilds the plan from cached scores (no LLM cost), picks the highest-value
 * "moment" frames (top score + high energy + laughs), and extracts a JPG at
 * each into outputs/<jobId>.thumb-N.jpg. Runs locally.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

try {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const store = require("../lib/supabase");
const { enginePlan } = require("../lib/engine/plan");
const OUTPUT_DIR = path.join(__dirname, "..", "outputs");
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const ts = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function grabFrame(input, t, out) {
  return new Promise((resolve, reject) => {
    // -ss before -i = fast seek; grab one high-quality frame.
    const p = spawn("ffmpeg", ["-hide_banner", "-y", "-ss", String(t), "-i", input, "-frames:v", "1", "-q:v", "2", out]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err.slice(-200)))));
  });
}

(async () => {
  let jobs;
  try {
    jobs = await store.loadJobs(200);
  } catch (e) {
    return console.error("Could not load jobs:", e.message);
  }
  const arg = process.argv[2];
  if (!arg || arg === "list") {
    console.log("Your jobs (newest first):\n" +
      jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map((j) => `  ${j.id}  [${j.mode}/${j.status}]  ${j.originalName || ""}`).join("\n"));
    return;
  }
  const count = Math.max(1, Math.min(10, parseInt(process.argv[3] || "5")));
  const job = jobs.find((j) => j.id === arg);
  if (!job) return console.error(`No job ${arg}. Run 'list'.`);

  if (!(job.words && job.words.length) && job.transcript_fp) {
    const t = await store.getTranscript(job.transcript_fp).catch(() => null);
    if (t) job.words = t.words || [];
  }
  if (!job.words || !job.words.length) return console.error("No transcript for this job.");
  if (!job.input || !fs.existsSync(job.input)) return console.error(`Source video not on disk: ${job.input}`);

  const meta = job.meta || {};
  const eng = await enginePlan({
    words: job.words,
    duration: meta.duration,
    utterances: job.speakers || [],
    chapters: job.chapters || [],
    mediaPath: job.input, // needed so energy/highEnergy signals are present
    llm: null,
    cachePath: path.join(UPLOAD_DIR, `${job.id}.scores.json`),
  }).catch((e) => {
    console.error("Plan rebuild failed:", e.message);
    process.exit(1);
  });

  // rank moments: kept blocks, prefer high energy + high score, spread out
  const cand = (eng.blocks || [])
    .filter((b) => b.type === "keep")
    .map((b) => ({ ...b, mid: (b.start + b.end) / 2, rank: (b.score ?? 0) + (b.highEnergy ? 25 : 0) }))
    .sort((a, b) => b.rank - a.rank);

  // de-cluster: don't grab two frames within 20s of each other
  const chosen = [];
  for (const c of cand) {
    if (chosen.every((x) => Math.abs(x.mid - c.mid) > 20)) chosen.push(c);
    if (chosen.length >= count) break;
  }

  console.error(`Grabbing ${chosen.length} thumbnail frames…`);
  const made = [];
  for (let i = 0; i < chosen.length; i++) {
    const out = path.join(OUTPUT_DIR, `${job.id}.thumb-${i + 1}.jpg`);
    try {
      await grabFrame(job.input, chosen[i].mid, out);
      made.push({ out, at: chosen[i].mid, score: chosen[i].score });
      console.error(`  ✓ [${ts(chosen[i].mid)}]  score ${chosen[i].score}  → ${path.basename(out)}`);
    } catch (e) {
      console.error(`  ✗ frame ${i + 1}: ${e.message}`);
    }
  }
  console.log("\n=== THUMBNAILS READY ===");
  for (const m of made) console.log(`  ${path.basename(m.out)}  (from ${ts(m.at)}, score ${m.score})`);
  console.log(`\nSaved in: ${OUTPUT_DIR}`);
})();
