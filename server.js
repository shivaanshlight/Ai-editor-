/**
 * ClipSurgeon server — with human-in-the-loop review.
 * ai mode flow: transcribe → LLM plan → REVIEW (you approve/adjust) → render.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Tiny .env loader
try {
  for (const line of fs
    .readFileSync(path.join(__dirname, ".env"), "utf8")
    .split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const express = require("express");
const multer = require("multer");
const {
  probe,
  detectSilence,
  buildKeepSegments,
  quantizeSegments,
  cutVideo,
} = require("./lib/silence");
const {
  transcribe,
  planEdit,
  validateEdl,
  removeFillers,
  shrinkPauses,
} = require("./lib/ai");
const { extractAudio, buildSrt, buildAss, finishPass } = require("./lib/media");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
for (const d of [UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(d, { recursive: true });
// Jobs don't survive restarts, so stale uploads are orphans — clear them at boot.
for (const f of fs.readdirSync(UPLOAD_DIR))
  fs.unlink(path.join(UPLOAD_DIR, f), () => {});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});
const jobs = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

app.post(
  "/api/upload",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "music", maxCount: 1 },
  ]),
  (req, res) => {
    const video = req.files?.video?.[0];
    if (!video)
      return res.status(400).json({ error: "No video file received." });
    const music = req.files?.music?.[0] || null;

    const id = crypto.randomUUID();
    const b = req.body;
    const job = {
      id,
      mode: b.mode === "ai" ? "ai" : "silence",
      status: "analyzing",
      progress: 0,
      input: video.path,
      originalName: video.originalname,
      output: path.join(OUTPUT_DIR, id + ".mp4"),
      settings: {
        noiseDb: clamp(parseFloat(b.noiseDb) || -35, -60, -10),
        minSilence: clamp(parseFloat(b.minSilence) || 0.6, 0.2, 5),
        padding: clamp(parseFloat(b.padding) || 0.15, 0, 1),
        instruction: String(b.instruction || "").slice(0, 2000),
        targetDuration: b.targetDuration
          ? clamp(parseFloat(b.targetDuration), 5, 36000)
          : null,
        captions: b.captions === "true",
        captionStyle: b.captionStyle === "bold" ? "bold" : "clean",
        fillerRemoval: b.fillerRemoval !== "false",
        shrinkPauses: b.shrinkPauses !== "false",
        punchIn: b.punchIn === "true",
        vertical: b.vertical === "true",
        review: b.review !== "false",
        musicPath: music ? music.path : null,
        musicVol: clamp(parseFloat(b.musicVol) || 0.25, 0.05, 0.8),
      },
      createdAt: Date.now(),
    };
    jobs.set(id, job);
    processJob(job).catch((err) => {
      job.status = "error";
      job.error = err.message;
    });
    res.json({ id });
  },
);

async function processJob(job) {
  const s = job.settings;
  const meta = await probe(job.input);
  job.meta = meta;
  job.duration = meta.duration;

  if (job.mode === "silence") {
    const silences = await detectSilence(job.input, s);
    let keeps = buildKeepSegments(silences, meta.duration, {
      padding: s.padding,
    });
    if (!silences.length) keeps = [{ start: 0, end: meta.duration }];
    return renderJob(job, keeps);
  }

  // ---- AI mode ----
  job.status = "transcribing";
  const audioPath = job.input + ".mp3";
  await extractAudio(job.input, audioPath);
  const transcript = await transcribe(audioPath);
  fs.unlink(audioPath, () => {});
  job.words = transcript.words || [];
  job.transcriptText = transcript.text || "";

  job.status = "planning";
  const plan = await planEdit(
    transcript,
    s.instruction,
    s.targetDuration,
    meta.duration,
  );
  const keeps = validateEdl(plan.segments, meta.duration, job.words);
  job.summary = plan.summary || "";

  if (s.review) {
    // Pause here: hand the plan to the human.
    job.plannedKeeps = keeps;
    job.reviewBlocks = buildBlocks(keeps, job.words, meta.duration);
    job.status = "review";
    return;
  }
  return renderJob(job, keeps);
}

/** Shared final pipeline: filler surgery → pause shrink → quantize → cut → captions/music. */
async function renderJob(job, keeps) {
  const s = job.settings;
  const { duration, fps, width, height } = job.meta;

  // Remember the human-approved cut list (pre filler/pause/quantize) so the
  // timeline editor can present and adjust it after rendering.
  job.approvedKeeps = keeps.map((k) => ({ ...k }));
  job.reviewBlocks = buildBlocks(job.approvedKeeps, job.words || [], duration);

  // Every render is a new version — history lets you compare and roll back.
  job.version = (job.version || 0) + 1;
  job.output = path.join(OUTPUT_DIR, `${job.id}.v${job.version}.mp4`);

  if (job.mode === "ai") {
    if (s.fillerRemoval) keeps = removeFillers(keeps, job.words);
    if (s.shrinkPauses) keeps = shrinkPauses(keeps, job.words);
  }
  keeps = quantizeSegments(keeps, fps, duration);

  if (job.mode === "ai" && s.captions) {
    if (s.captionStyle === "bold")
      job.ass = buildAss(job.words, keeps, { vertical: s.vertical });
    else job.srt = buildSrt(job.words, keeps);
  }

  job.segments = keeps;
  job.keptDuration = keeps.reduce((sum, k) => sum + (k.end - k.start), 0);

  const needsFinish =
    job.mode === "ai" &&
    ((s.captions && (job.srt || job.ass)) || s.musicPath || s.vertical);
  const cutTarget = needsFinish
    ? path.join(OUTPUT_DIR, job.id + ".cut.mp4")
    : job.output;

  job.status = "cutting";
  const wholeVideo =
    keeps.length === 1 && keeps[0].start === 0 && keeps[0].end === duration;
  if (wholeVideo) fs.copyFileSync(job.input, cutTarget);
  else
    await cutVideo(
      job.input,
      cutTarget,
      keeps,
      (sec) => {
        job.progress = Math.min(99, Math.round((sec / job.keptDuration) * 100));
      },
      { punchIn: job.mode === "ai" && s.punchIn, width, height },
    );

  if (needsFinish) {
    job.status = "finishing";
    job.progress = 0;
    let srtFile = null,
      assFile = null;
    if (s.captions && job.ass) {
      assFile = job.id + ".ass";
      fs.writeFileSync(path.join(OUTPUT_DIR, assFile), job.ass);
    } else if (s.captions && job.srt) {
      srtFile = job.id + ".srt";
      fs.writeFileSync(path.join(OUTPUT_DIR, srtFile), job.srt);
    }
    await finishPass(cutTarget, job.output, {
      srtFile,
      assFile,
      captionStyle: s.captionStyle,
      musicPath: s.musicPath ? path.resolve(s.musicPath) : null,
      musicVol: s.musicVol,
      vertical: s.vertical,
    });
    fs.unlink(cutTarget, () => {});
    for (const f of [srtFile, assFile])
      if (f) fs.unlink(path.join(OUTPUT_DIR, f), () => {});
  }

  job.status = "done";
  job.progress = 100;
  job.versions = job.versions || [];
  job.versions.push({
    v: job.version,
    keptDuration: job.keptDuration,
    segments: keeps,
    createdAt: Date.now(),
  });
  // Source and music are kept so the timeline editor can re-render; boot cleanup
  // clears them when the server restarts.
}

/**
 * Build alternating keep/cut blocks with their transcript text and word indices,
 * so the review UI can show exactly what the AI decided — and let the human flip it.
 */
function buildBlocks(keeps, words, duration) {
  const regions = [];
  let cursor = 0;
  for (const k of keeps) {
    if (k.start > cursor + 0.05)
      regions.push({ start: cursor, end: k.start, type: "cut" });
    regions.push({ start: k.start, end: k.end, type: "keep" });
    cursor = k.end;
  }
  if (duration - cursor > 0.05)
    regions.push({ start: cursor, end: duration, type: "cut" });

  return regions.map((r) => ({
    ...r,
    words: words
      .map((w, i) => ({ i, w: w.word.trim(), c: (w.start + w.end) / 2 }))
      .filter((x) => x.c >= r.start && x.c < r.end)
      .map(({ i, w }) => ({ i, w })),
  }));
}

function sanitizeSegments(list, duration) {
  const clean = (Array.isArray(list) ? list : [])
    .map((s) => ({
      start: Math.max(0, +s.start),
      end: Math.min(duration, +s.end),
    }))
    .filter(
      (s) => isFinite(s.start) && isFinite(s.end) && s.end - s.start >= 0.2,
    )
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of clean) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.02)
      last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** The human approved (and possibly adjusted) the plan — render it. */
app.post("/api/jobs/:id/render", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "review" && job.status !== "done")
    return res.status(400).json({ error: "Job is not editable right now." });

  const keeps = sanitizeSegments(
    req.body.included || job.plannedKeeps,
    job.meta.duration,
  );
  if (!keeps.length)
    return res.status(400).json({ error: "Nothing selected to keep." });

  // Apply caption text corrections (word index → new text; timing preserved).
  const edits = req.body.wordEdits || {};
  for (const [i, text] of Object.entries(edits)) {
    const idx = parseInt(i);
    if (job.words[idx] && typeof text === "string" && text.length <= 60)
      job.words[idx].word = text;
  }

  job.status = "cutting";
  job.progress = 0;
  renderJob(job, keeps).catch((err) => {
    job.status = "error";
    job.error = err.message;
  });
  res.json({ ok: true });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const {
    id,
    status,
    progress,
    error,
    duration,
    keptDuration,
    segments,
    originalName,
    summary,
    mode,
  } = job;
  const payload = {
    id,
    status,
    progress,
    error,
    duration,
    keptDuration,
    segments,
    originalName,
    summary,
    mode,
  };
  if (status === "review" || status === "done")
    payload.reviewBlocks = job.reviewBlocks;
  if (job.transcriptText)
    payload.transcript = job.transcriptText.slice(0, 6000);
  if (job.versions) {
    payload.versions = job.versions;
    payload.version = job.version;
  }
  res.json(payload);
});

app.get("/api/preview/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).send("Not ready.");
  const v = parseInt(req.query.v) || job.version;
  const file = path.join(OUTPUT_DIR, `${job.id}.v${v}.mp4`);
  if (!fs.existsSync(file)) return res.status(404).send("Version not found.");
  res.sendFile(file); // sendFile handles HTTP range requests for <video> seeking
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).send("Not ready.");
  const v = parseInt(req.query.v) || job.version;
  const file = path.join(OUTPUT_DIR, `${job.id}.v${v}.mp4`);
  if (!fs.existsSync(file)) return res.status(404).send("Version not found.");
  const base = path.parse(job.originalName).name;
  res.download(file, `${base}.v${v}.mp4`);
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

app.listen(PORT, () => {
  console.log(`ClipSurgeon running → http://localhost:${PORT}`);
  console.log(
    process.env.GROQ_API_KEY
      ? "AI mode: ready ✓"
      : "AI mode: OFF — add GROQ_API_KEY to .env",
  );
});
