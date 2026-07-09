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
  transcribeLong,
  planEdit,
  findClips,
  validateClips,
  validateEdl,
  removeFillers,
  shrinkPauses,
  detectChapters,
} = require("./lib/ai");
const {
  extractAudio,
  extractAudioChunked,
  buildSrt,
  buildAss,
  CAPTION_STYLES,
} = require("./lib/media");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const DATA_DIR = path.join(__dirname, "data");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const CACHE_DIR = path.join(DATA_DIR, "transcripts");
for (const d of [UPLOAD_DIR, OUTPUT_DIR, JOBS_DIR, CACHE_DIR])
  fs.mkdirSync(d, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});
const jobs = new Map();

/* ---------- persistence: every job survives a restart ---------- */
function saveJob(job) {
  try {
    const { _timer, ...clean } = job;
    fs.writeFile(
      path.join(JOBS_DIR, job.id + ".json"),
      JSON.stringify(clean),
      () => {},
    );
  } catch {}
}

// Load persisted jobs at boot. Jobs interrupted mid-processing fall back to
// their last human-facing checkpoint (review / clip selection) when possible.
for (const f of fs.readdirSync(JOBS_DIR)) {
  try {
    const job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
    const active = [
      "analyzing",
      "transcribing",
      "planning",
      "cutting",
      "finishing",
      "queued",
    ];
    if (active.includes(job.status)) {
      if (job.reviewBlocks && job.plannedKeeps) job.status = "review";
      else if (job.clipPlans) job.status = "clipReview";
      else {
        job.status = "error";
        job.error = "Interrupted by a server restart — upload again.";
      }
    }
    if (job.status === "done") {
      const latest = path.join(
        OUTPUT_DIR,
        `${job.id}.${job.clips?.length ? "c" + job.clips[0].i : "v" + (job.version || 1)}.mp4`,
      );
      if (!fs.existsSync(latest)) {
        job.status = "error";
        job.error = "Output files were removed.";
      }
    }
    jobs.set(job.id, job);
  } catch {}
}
// Clean only upload files no persisted job still references.
{
  const referenced = new Set();
  for (const j of jobs.values()) {
    if (j.input) referenced.add(path.basename(j.input));
    if (j.settings?.musicPath)
      referenced.add(path.basename(j.settings.musicPath));
  }
  for (const f of fs.readdirSync(UPLOAD_DIR))
    if (!referenced.has(f)) fs.unlink(path.join(UPLOAD_DIR, f), () => {});
}

/* ---------- render queue: one encode at a time, everything else waits ---------- */
const renderQueue = [];
let rendering = null;
function enqueueRender(job, fn) {
  job.status = "queued";
  saveJob(job);
  renderQueue.push({ job, fn });
  pumpQueue();
}
async function pumpQueue() {
  if (rendering || !renderQueue.length) return;
  const task = renderQueue.shift();
  rendering = task;
  try {
    await task.fn();
  } catch (err) {
    task.job.status = "error";
    task.job.error = err.message;
  } finally {
    saveJob(task.job);
    rendering = null;
    pumpQueue();
  }
}
function queuePosition(job) {
  const i = renderQueue.findIndex((t) => t.job.id === job.id);
  return i === -1 ? 0 : i + 1 + (rendering ? 1 : 0);
}

/* ---------- transcript cache: same file never transcribed twice ---------- */
async function fileFingerprint(file, duration) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return crypto
    .createHash("sha256")
    .update(buf)
    .update(String(stat.size))
    .update(String(Math.round(duration)))
    .digest("hex")
    .slice(0, 32);
}

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
      mode: ["ai", "clips", "silence"].includes(b.mode) ? b.mode : "silence",
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
        draft: b.draft === "true",
        clipCount: b.clipCount || "auto",
        clipLen: [30, 60, 90, 120].includes(parseInt(b.clipLen))
          ? parseInt(b.clipLen)
          : 60,
        musicPath: music ? music.path : null,
        musicVol: clamp(parseFloat(b.musicVol) || 0.25, 0.05, 0.8),
      },
      createdAt: Date.now(),
    };
    jobs.set(id, job);
    saveJob(job);
    processJob(job).catch((err) => {
      job.status = "error";
      job.error = err.message;
      saveJob(job);
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
    return enqueueRender(job, () => renderJob(job, keeps));
  }

  // ---- AI + Clips modes: chunked transcription with a fingerprint cache ----
  job.status = "transcribing";
  saveJob(job);
  const fp = await fileFingerprint(job.input, meta.duration);
  const cacheFile = path.join(CACHE_DIR, fp + ".json");
  let transcript;
  if (fs.existsSync(cacheFile)) {
    transcript = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    job.stage = "cached — skipped transcription";
  } else {
    const chunks = await extractAudioChunked(
      job.input,
      job.input,
      meta.duration,
    );
    transcript = await transcribeLong(chunks, (i, n) => {
      job.progress = Math.round((i / n) * 100);
      job.stage = n > 1 ? `chunk ${i + 1} of ${n}` : "";
    });
    for (const c of chunks) fs.unlink(c.path, () => {});
    fs.writeFile(cacheFile, JSON.stringify(transcript), () => {});
  }
  job.words = transcript.words || [];
  job.transcriptText = transcript.text || "";
  job.progress = 0;

  // Chapters are a bonus, never a blocker.
  try {
    job.chapters = await detectChapters(transcript, meta.duration);
  } catch {
    job.chapters = [];
  }

  job.status = "planning";
  saveJob(job);

  if (job.mode === "clips") {
    const minLen = Math.round(s.clipLen * 0.6),
      maxLen = Math.round(s.clipLen * 1.5);
    const found = await findClips(
      transcript,
      { count: s.clipCount, minLen, maxLen, instruction: s.instruction },
      meta.duration,
    );
    job.clipPlans = validateClips(found, meta.duration, job.words, {
      minLen: Math.max(8, minLen * 0.7),
      maxLen,
    }).map((c, i) => ({
      ...c,
      i,
      text: textInRange(job.words, c.start, c.end).slice(0, 220),
      // ±2 min of editable context so the timeline can extend the clip either way.
      padStart: Math.max(0, c.start - 120),
      padEnd: Math.min(meta.duration, c.end + 120),
    }));
    if (s.review) {
      job.status = "clipReview";
      saveJob(job);
      return;
    }
    return enqueueRender(job, () =>
      renderClips(
        job,
        job.clipPlans.map((c) => c.i),
      ),
    );
  }

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
    saveJob(job);
    return;
  }
  return enqueueRender(job, () => renderJob(job, keeps));
}

function textInRange(words, start, end) {
  return words
    .filter((w) => w.start >= start && w.end <= end)
    .map((w) => w.word.trim())
    .join(" ");
}

/** Render each selected clip through the full polish pipeline. */
async function renderClips(job, selectedIdx) {
  const s = job.settings;
  const { duration, fps, width, height } = job.meta;
  job.clips = [];
  const chosen = job.clipPlans.filter((c) => selectedIdx.includes(c.i));
  if (!chosen.length) throw new Error("No clips selected.");

  for (let k = 0; k < chosen.length; k++) {
    const c = chosen[k];
    job.status = "cutting";
    job.stage = `clip ${k + 1} of ${chosen.length}: ${c.title}`;
    job.progress = Math.round((k / chosen.length) * 100);

    let segs = [{ start: c.start, end: c.end }];
    if (s.fillerRemoval) segs = removeFillers(segs, job.words);
    if (s.shrinkPauses) segs = shrinkPauses(segs, job.words);
    segs = quantizeSegments(segs, fps, duration);
    const clipDur = segs.reduce((sum, x) => sum + (x.end - x.start), 0);

    const out = path.join(OUTPUT_DIR, `${job.id}.c${c.i}.mp4`);
    let subFile = null;
    if (s.captions) {
      if (s.captionStyle === "bold") {
        const ass = buildAss(job.words, segs, { vertical: s.vertical });
        if (ass) {
          subFile = `${job.id}.c${c.i}.ass`;
          fs.writeFileSync(path.join(OUTPUT_DIR, subFile), ass);
        }
      } else {
        const srt = buildSrt(job.words, segs);
        if (srt) {
          subFile = `${job.id}.c${c.i}.srt`;
          fs.writeFileSync(path.join(OUTPUT_DIR, subFile), srt);
        }
      }
    }
    await cutVideo(path.resolve(job.input), path.basename(out), segs, null, {
      punchIn: s.punchIn,
      width,
      height,
      draft: s.draft,
      subFile,
      subStyle: s.captionStyle === "clean" ? CAPTION_STYLES.clean : null,
      vertical: s.vertical,
      cwd: OUTPUT_DIR,
    });
    if (subFile) fs.unlink(path.join(OUTPUT_DIR, subFile), () => {});
    job.clips.push({
      i: c.i,
      title: c.title,
      duration: clipDur,
      start: c.start,
      end: c.end,
    });
  }
  job.status = "done";
  job.progress = 100;
  job.stage = "";
  saveJob(job);
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

  job.status = "cutting";
  let subFile = null;
  if (job.mode === "ai" && s.captions) {
    if (job.ass) {
      subFile = `${job.id}.v${job.version}.ass`;
      fs.writeFileSync(path.join(OUTPUT_DIR, subFile), job.ass);
    } else if (job.srt) {
      subFile = `${job.id}.v${job.version}.srt`;
      fs.writeFileSync(path.join(OUTPUT_DIR, subFile), job.srt);
    }
  }
  await cutVideo(
    path.resolve(job.input),
    path.basename(job.output),
    keeps,
    (sec) => {
      job.progress = Math.min(99, Math.round((sec / job.keptDuration) * 100));
    },
    {
      punchIn: job.mode === "ai" && s.punchIn,
      width,
      height,
      draft: s.draft,
      subFile,
      subStyle: s.captionStyle === "clean" ? CAPTION_STYLES.clean : null,
      vertical: job.mode === "ai" && s.vertical,
      musicPath:
        job.mode === "ai" && s.musicPath ? path.resolve(s.musicPath) : null,
      musicVol: s.musicVol,
      cwd: OUTPUT_DIR,
    },
  );
  if (subFile) fs.unlink(path.join(OUTPUT_DIR, subFile), () => {});

  job.status = "done";
  job.progress = 100;
  job.versions = job.versions || [];
  job.versions.push({
    v: job.version,
    keptDuration: job.keptDuration,
    segments: keeps,
    createdAt: Date.now(),
  });
  saveJob(job);
  // Source and music are kept so the timeline editor can re-render; boot cleanup
  // clears them when the server restarts.
}

/* ------------------------------------------------------------------ *
 * Review-block subdivision — WORD-timestamp based, NOT Whisper segments.
 *
 * Whisper's transcript.segments are ASR decoder/VAD windows, not sentences:
 * on real speech they routinely run 20–90 s and pack several sentences (or
 * half of one) into a single block. Subdividing a keep/cut region by those
 * boundaries therefore produces giant, un-reviewable 60–90 s blocks.
 *
 * Instead we walk the words in chronological order and cut at sentence
 * punctuation (. ! ? …) or at long pauses (> 0.8 s), then normalize sizes:
 * merge slivers (< 4 s) into a neighbour and hard-split anything over ~14 s.
 * When punctuation is absent for a long stretch we fall back to pause-based
 * splitting, and if a run is still too long we split roughly every 10–12 s at
 * the nearest word boundary — so a 3–4 h podcast still yields tidy blocks.
 *
 * Every block is { start, end, type, words:[{i,w,s,e}] } and the blocks tile
 * each region contiguously. Per-word start (s) / end (e) times let the review
 * UI cut PART of a block (individual words) instead of only whole blocks.
 * ------------------------------------------------------------------ */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const PAUSE_SPLIT = 0.8; // gap between words that reads as a sentence break
const MIN_BLOCK = 4; // merge anything shorter into a neighbour
const TARGET_BLOCK = 10; // aim for ~10 s review blocks
const MAX_BLOCK = 14; // hard-split anything longer

const chunkDur = (c) => c[c.length - 1].end - c[0].start;

/**
 * Break a punctuation-less / pause-less word run into <= max-second pieces,
 * preferring a natural micro-gap once we've reached the target length, and
 * force-splitting at a word boundary before we would ever exceed max.
 */
function splitLongRun(ws, target = TARGET_BLOCK, max = MAX_BLOCK) {
  const pieces = [];
  let cur = [];
  let startT = ws.length ? ws[0].start : 0;
  for (let k = 0; k < ws.length; k++) {
    cur.push(ws[k]);
    const last = k === ws.length - 1;
    const dur = ws[k].end - startT;
    const gap = last ? Infinity : ws[k + 1].start - ws[k].end;
    const nextDur = last ? dur : ws[k + 1].end - startT;
    if (!last && ((dur >= target && gap >= 0.25) || nextDur > max)) {
      pieces.push(cur);
      cur = [];
      startT = ws[k + 1].start;
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}

/**
 * Merge chunks shorter than `min` into whichever neighbour keeps the result
 * smallest without blowing past `max` where avoidable — so review never shows
 * 1–2 s slivers.
 */
function mergeTinyChunks(chunks, min = MIN_BLOCK, max = MAX_BLOCK) {
  if (chunks.length <= 1) return chunks;
  const out = chunks.map((c) => c.slice());
  let i = 0;
  while (i < out.length) {
    if (out.length === 1 || chunkDur(out[i]) >= min) {
      i++;
      continue;
    }
    const prev = out[i - 1];
    const next = out[i + 1];
    const prevOk = prev && chunkDur(prev) + chunkDur(out[i]) <= max;
    const nextOk = next && chunkDur(next) + chunkDur(out[i]) <= max;
    let mergePrev;
    if (prevOk && nextOk) mergePrev = chunkDur(prev) <= chunkDur(next);
    else if (prevOk) mergePrev = true;
    else if (nextOk) mergePrev = false;
    else mergePrev = !!prev && (!next || chunkDur(prev) <= chunkDur(next));
    if (mergePrev && prev) {
      prev.push(...out[i]);
      out.splice(i, 1);
      i = Math.max(0, i - 1);
    } else if (next) {
      next.unshift(...out[i]);
      out.splice(i, 1);
    } else {
      i++; // truly isolated tiny chunk (whole region is short) — leave it
    }
  }
  return out;
}

/**
 * Subdivide a single keep/cut region into sentence-sized blocks from its words.
 * Returns { sentenceCount, blocks } — blocks tile [region.start, region.end].
 */
function subdivideRegion(region, rWords) {
  if (!rWords.length) {
    // Silence / no-speech region: nothing to subdivide.
    return {
      sentenceCount: 0,
      blocks: [
        { start: region.start, end: region.end, type: region.type, words: [] },
      ],
    };
  }

  // 1. Sentence chunks: split on end punctuation OR a long pause.
  const sentences = [];
  let cur = [];
  for (let k = 0; k < rWords.length; k++) {
    cur.push(rWords[k]);
    const endsSentence = SENTENCE_END.test(rWords[k].word);
    const gap =
      k + 1 < rWords.length ? rWords[k + 1].start - rWords[k].end : Infinity;
    if (endsSentence || gap > PAUSE_SPLIT) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);
  const sentenceCount = sentences.length;

  // 2. Hard-split oversized sentences (long punctuation-less monologue).
  let chunks = [];
  for (const s of sentences) {
    if (chunkDur(s) > MAX_BLOCK) chunks.push(...splitLongRun(s));
    else chunks.push(s);
  }

  // 3. Merge slivers so we never emit 1–2 s review blocks.
  chunks = mergeTinyChunks(chunks);

  // 4. Lay chunks back over the region contiguously — boundaries fall in the
  //    pause between chunks — so kept blocks re-merge and cut blocks stay cut.
  const bounds = [region.start];
  for (let k = 0; k < chunks.length - 1; k++) {
    const leftEnd = chunks[k][chunks[k].length - 1].end;
    const rightStart = chunks[k + 1][0].start;
    let b = (leftEnd + rightStart) / 2;
    if (!isFinite(b)) b = leftEnd;
    b = Math.max(bounds[k] + 1e-3, Math.min(b, region.end - 1e-3));
    bounds.push(b);
  }
  bounds.push(region.end);

  const blocks = chunks.map((c, k) => ({
    start: bounds[k],
    end: bounds[k + 1],
    type: region.type,
    // s/e = per-word source times, so the UI can cut individual words.
    words: c.map((w) => ({ i: w.i, w: w.word.trim(), s: w.start, e: w.end })),
  }));
  return { sentenceCount, blocks };
}

/**
 * Build alternating keep/cut review blocks, each subdivided into sentence-sized
 * chunks from word timestamps so the human can flip whole blocks OR single words.
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

  // Index every word once with its center time for region assignment.
  const indexed = (words || []).map((w, i) => ({
    i,
    word: (w.word || "").trim(),
    start: w.start,
    end: w.end,
    c: (w.start + w.end) / 2,
  }));

  const out = [];
  for (const r of regions) {
    const rWords = indexed.filter((x) => x.c >= r.start && x.c < r.end);
    const { sentenceCount, blocks } = subdivideRegion(r, rWords);
    console.log({
      regionLength: +(r.end - r.start).toFixed(1),
      sentenceCount,
      generatedBlocks: blocks.length,
    });
    out.push(...blocks);
  }
  return out;
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

  job.progress = 0;
  enqueueRender(job, () => renderJob(job, keeps));
  res.json({ ok: true });
});

/** Render ONE clip from human-adjusted source segments (the timeline editor). */
app.post("/api/jobs/:id/render-clip", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (!job.meta) return res.status(400).json({ error: "Job not ready." });
  const i = parseInt(req.body.i, 10);
  if (!Number.isInteger(i))
    return res.status(400).json({ error: "Bad clip index." });
  const segs = sanitizeSegments(req.body.segments, job.meta.duration);
  if (!segs.length)
    return res.status(400).json({ error: "Nothing selected to keep." });
  const plan = (job.clipPlans || []).find((c) => c.i === i);
  const title =
    (plan && plan.title) ||
    String(req.body.title || "").slice(0, 80) ||
    `Clip ${i + 1}`;
  job.progress = 0;
  enqueueRender(job, () => renderClipSegments(job, i, segs, title));
  res.json({ ok: true });
});

/** Render a single clip #i from explicit keep-segments, then upsert job.clips[i]. */
async function renderClipSegments(job, i, baseSegs, title) {
  const s = job.settings;
  const { duration, fps, width, height } = job.meta;
  job.status = "cutting";
  job.stage = `rendering clip: ${title}`;
  job.progress = 0;

  let segs = baseSegs.map((x) => ({ ...x }));
  if (s.fillerRemoval) segs = removeFillers(segs, job.words);
  if (s.shrinkPauses) segs = shrinkPauses(segs, job.words);
  segs = quantizeSegments(segs, fps, duration);
  const clipDur = segs.reduce((sum, x) => sum + (x.end - x.start), 0);

  const out = path.join(OUTPUT_DIR, `${job.id}.c${i}.mp4`);
  let subFile = null;
  if (s.captions) {
    if (s.captionStyle === "bold") {
      const ass = buildAss(job.words, segs, { vertical: s.vertical });
      if (ass) {
        subFile = `${job.id}.c${i}.ass`;
        fs.writeFileSync(path.join(OUTPUT_DIR, subFile), ass);
      }
    } else {
      const srt = buildSrt(job.words, segs);
      if (srt) {
        subFile = `${job.id}.c${i}.srt`;
        fs.writeFileSync(path.join(OUTPUT_DIR, subFile), srt);
      }
    }
  }
  await cutVideo(
    path.resolve(job.input),
    path.basename(out),
    segs,
    (sec) => {
      job.progress = Math.min(99, Math.round((sec / Math.max(clipDur, 0.1)) * 100));
    },
    {
      punchIn: s.punchIn,
      width,
      height,
      draft: s.draft,
      subFile,
      subStyle: s.captionStyle === "clean" ? CAPTION_STYLES.clean : null,
      vertical: s.vertical,
      cwd: OUTPUT_DIR,
    },
  );
  if (subFile) fs.unlink(path.join(OUTPUT_DIR, subFile), () => {});

  job.clips = job.clips || [];
  const entry = {
    i,
    title,
    duration: clipDur,
    start: segs[0].start,
    end: segs[segs.length - 1].end,
  };
  const at = job.clips.findIndex((c) => c.i === i);
  if (at >= 0) job.clips[at] = entry;
  else job.clips.push(entry);
  job.clips.sort((a, b) => a.i - b.i);

  job.status = "done";
  job.progress = 100;
  job.stage = "";
  saveJob(job);
}

app.post("/api/jobs/:id/render-clips", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "clipReview" && job.status !== "done")
    return res
      .status(400)
      .json({ error: "Job is not awaiting clip selection." });
  const sel = Array.isArray(req.body.selected)
    ? req.body.selected.map(Number)
    : [];
  if (!sel.length)
    return res.status(400).json({ error: "Select at least one clip." });
  job.progress = 0;
  enqueueRender(job, () => renderClips(job, sel));
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
  if (job.stage) payload.stage = job.stage;
  if (status === "clipReview") payload.clipPlans = job.clipPlans;
  if (job.clips) payload.clips = job.clips;
  if (job.chapters?.length) payload.chapters = job.chapters;
  if (status === "queued") payload.queuePos = queuePosition(job);
  res.json(payload);
});

/** Recent projects (persistence makes this meaningful). */
app.get("/api/jobs", (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12)
    .map((j) => ({
      id: j.id,
      name: j.originalName,
      mode: j.mode,
      status: j.status,
      createdAt: j.createdAt,
    }));
  res.json(list);
});

/** Full word list for transcript search (word + start time only). */
app.get("/api/jobs/:id/words", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.words)
    return res.status(404).json({ error: "No transcript." });
  res.json(
    job.words.map((w, i) => ({
      i,
      w: w.word.trim(),
      s: Math.round(w.start * 10) / 10,
      e: Math.round(w.end * 10) / 10,
    })),
  );
});

/** Stream the ORIGINAL upload (range-enabled) so the clip editor can scrub the
 *  un-rendered ±2 min padding around a clip. */
app.get("/api/source/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.input || !fs.existsSync(job.input))
    return res.status(404).send("No source.");
  const stat = fs.statSync(job.input);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(job.input, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(job.input).pipe(res);
  }
});

app.get("/api/preview/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).send("Not ready.");
  const file =
    req.query.c !== undefined
      ? path.join(OUTPUT_DIR, `${job.id}.c${parseInt(req.query.c)}.mp4`)
      : path.join(
          OUTPUT_DIR,
          `${job.id}.v${parseInt(req.query.v) || job.version}.mp4`,
        );
  if (!fs.existsSync(file)) return res.status(404).send("Version not found.");
  res.sendFile(file); // sendFile handles HTTP range requests for <video> seeking
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).send("Not ready.");
  const isClip = req.query.c !== undefined;
  const n = isClip
    ? parseInt(req.query.c)
    : parseInt(req.query.v) || job.version;
  const file = path.join(OUTPUT_DIR, `${job.id}.${isClip ? "c" : "v"}${n}.mp4`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found.");
  const base = path.parse(job.originalName).name;
  const clip = isClip ? (job.clips || []).find((x) => x.i === n) : null;
  res.download(file, clip ? `${slug(clip.title)}.mp4` : `${base}.v${n}.mp4`);
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function slug(t) {
  return (
    String(t)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "clip"
  );
}

app.listen(PORT, () => {
  console.log(`ClipSurgeon running → http://localhost:${PORT}`);
  console.log(
    process.env.GROQ_API_KEY
      ? "AI mode: ready ✓"
      : "AI mode: OFF — add GROQ_API_KEY to .env",
  );
});
