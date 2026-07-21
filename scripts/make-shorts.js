/**
 * scripts/make-shorts.js — one long video → several vertical shorts.
 *
 *   node scripts/make-shorts.js <jobId> [count]
 *   node scripts/make-shorts.js list           # show job ids
 *
 * Finds the best self-contained moments with Gemini (ONE cheap call — no Groq
 * map-reduce storm), then renders each as a 9:16 short with burned-in karaoke
 * captions, saved to outputs/<jobId>.short-N.mp4. Runs entirely on your machine.
 */

const fs = require("fs");
const path = require("path");

// same .env loader as the server
try {
  for (const line of fs
    .readFileSync(path.join(__dirname, "..", ".env"), "utf8")
    .split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const store = require("../lib/supabase");
const { cutVideo } = require("../lib/silence");
const { buildAss, buildSrt } = require("../lib/media");
const { validateClips } = require("../lib/ai");

const OUTPUT_DIR = path.join(__dirname, "..", "outputs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const CLIP_SYSTEM = `You find the BEST standalone short-video moments in a long transcript.
Each moment must work as a vertical short with ZERO context: a complete story, a hot take,
a surprising fact, a punchline, or a strong exchange. It must start on a hook and end on a
resolution — never mid-thought. Return ONLY JSON:
{"clips":[{"start":<sec>,"end":<sec>,"title":"<punchy, <=60 chars>","score":<0-100>,"reason":"<why it hooks, one line>"}]}
Rank best-first. Clips must not overlap. Timestamps must lie inside the transcript.`;

function ts(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** words → timestamped transcript lines (~one sentence each) for the prompt. */
function linesFromWords(words) {
  const out = [];
  let cur = [];
  let start = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (start === null) start = w.start;
    cur.push(w.word.trim());
    const endsSentence = /[.!?]$/.test(w.word.trim());
    if (endsSentence || cur.length >= 40 || i === words.length - 1) {
      out.push(`[${Math.round(start)}] ${cur.join(" ")}`);
      cur = [];
      start = null;
    }
  }
  return out;
}

(async () => {
  let jobs;
  try {
    jobs = await store.loadJobs(200);
  } catch (e) {
    console.error("Could not load jobs from Supabase:", e.message);
    process.exit(1);
  }

  const arg = process.argv[2];
  const listLine = (j) => `  ${j.id}  [${j.mode}/${j.status}]  ${j.originalName || ""}`;
  if (!arg || arg === "list") {
    console.log("Your jobs (newest first):\n" +
      jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(listLine).join("\n") +
      "\n\nRun: node scripts/make-shorts.js <jobId> [count]");
    return;
  }

  const count = Math.max(1, Math.min(12, parseInt(process.argv[3] || "5")));
  const job = jobs.find((j) => j.id === arg);
  if (!job) return console.error(`No job ${arg}. Run 'node scripts/make-shorts.js list'.`);

  // load transcript words (stored separately)
  if (!(job.words && job.words.length) && job.transcript_fp) {
    const t = await store.getTranscript(job.transcript_fp).catch(() => null);
    if (t) job.words = t.words || [];
  }
  if (!job.words || !job.words.length) return console.error("No transcript for this job.");
  if (!job.input || !fs.existsSync(job.input))
    return console.error(`Source video not on disk (${job.input}). Keep the original file where it was uploaded.`);

  const meta = job.meta || {};
  const duration = meta.duration || job.words[job.words.length - 1].end;
  const width = meta.width || 1920;
  const height = meta.height || 1080;

  // 1) find the best moments — ONE Gemini call
  console.error(`Finding the ${count} best short moments in "${job.originalName || job.id}"…`);
  const { geminiChatJSON, geminiAvailable } = require("../lib/gemini");
  if (!geminiAvailable()) return console.error("Gemini key required for clip-finding (add GEMINI_API_KEY).");
  const lines = linesFromWords(job.words);
  const userMsg = [
    `Video duration: ${Math.round(duration)}s. Find the ${count} best shorts, 15-60s each.`,
    "Transcript:",
    ...lines,
  ].join("\n");
  let clips;
  try {
    const res = await geminiChatJSON(
      [
        { role: "system", content: CLIP_SYSTEM },
        { role: "user", content: userMsg },
      ],
      { temperature: 0.3 },
    );
    clips = Array.isArray(res?.clips) ? res.clips : [];
  } catch (e) {
    return console.error("Clip-finding failed:", e.message);
  }
  if (!clips.length) return console.error("No clips found.");

  const chosen = validateClips(clips, duration, job.words, { minLen: 12, maxLen: 75 })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, count);

  console.error(`\nRendering ${chosen.length} vertical shorts…\n`);

  // 2) render each as a 9:16 short with karaoke captions
  const made = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const segs = [{ start: c.start, end: c.end }];
    const base = `${job.id}.short-${i + 1}`;
    // karaoke ASS captions, remapped to the clip's own timeline
    let subFile = null;
    const ass = buildAss(job.words, segs, { vertical: true, width, height });
    if (ass) {
      subFile = `${base}.ass`;
      fs.writeFileSync(path.join(OUTPUT_DIR, subFile), ass);
    }
    const out = path.join(OUTPUT_DIR, `${base}.mp4`);
    try {
      await cutVideo(job.input, out, segs, null, {
        vertical: true,
        width,
        height,
        subFile,
        cwd: OUTPUT_DIR,
      });
      made.push({ file: out, title: c.title, at: c.start, dur: c.end - c.start, score: c.score });
      console.error(`  ✓ short ${i + 1}/${chosen.length}  [${ts(c.start)}]  ${c.title}`);
    } catch (e) {
      console.error(`  ✗ short ${i + 1} failed: ${e.message}`);
    }
    if (subFile) fs.unlink(path.join(OUTPUT_DIR, subFile), () => {});
  }

  console.log("\n=== SHORTS READY ===");
  for (const m of made)
    console.log(`  ${path.basename(m.file)}  ·  ${Math.round(m.dur)}s  ·  score ${m.score}  ·  "${m.title}"  (from ${ts(m.at)})`);
  console.log(`\nSaved in: ${OUTPUT_DIR}`);
})();
