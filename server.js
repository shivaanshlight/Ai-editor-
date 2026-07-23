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
  planRenderSegments,
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
  repurpose,
  findHighlights,
  answerQuestion,
} = require("./lib/ai");
const {
  extractAudio,
  extractAudioFull,
  extractAudioChunked,
  computeWaveform,
  buildSrt,
  buildAss,
  buildLowerThirds,
  CAPTION_STYLES,
} = require("./lib/media");
const store = require("./lib/supabase");
const { embed } = require("./lib/embed");
const { diarize } = require("./lib/diarize");
const whisperLocal = require("./lib/whisper-local");

const app = express();
const PORT = process.env.PORT || 3000;

// Local dirs are now just scratch space for ffmpeg; the durable copies of the
// source and every output live in Supabase Storage.
const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
for (const d of [UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(d, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});
const jobs = new Map();

/* ---------- persistence: Supabase (jobs survive a restart) ---------- */
// Coalescing writer: progress ticks call saveJob() many times a second, and
// firing a full-job Supabase upsert for each one stacks dozens of concurrent
// multi-KB POSTs — enough to make Node's fetch throw "fetch failed" (socket
// reset) even on a healthy connection. So we keep AT MOST ONE write in flight
// per job; any saveJob() calls that arrive mid-write collapse into a single
// follow-up write once it finishes. Isolated saves still go out immediately.
const _saveQ = new Map(); // job.id -> { inFlight, pending, job }
function _runSave(st) {
  st.inFlight = true;
  st.pending = false;
  store
    .saveJob(st.job)
    .catch((e) => console.error("saveJob:", e.message))
    .finally(() => {
      st.inFlight = false;
      if (st.pending) setTimeout(() => _runSave(st), 250);
    });
}
function saveJob(job) {
  let st = _saveQ.get(job.id);
  if (!st) {
    st = { inFlight: false, pending: false, job };
    _saveQ.set(job.id, st);
  }
  st.job = job; // always persist the latest state
  if (st.inFlight) {
    st.pending = true; // a write is running — coalesce into one follow-up
    return;
  }
  _runSave(st);
}

// Load recent jobs at boot. Jobs interrupted mid-processing fall back to their
// last human-facing checkpoint (review / clip selection) when possible.
async function loadPersistedJobs() {
  const list = await store.loadJobs(200);
  const active = [
    "analyzing",
    "transcribing",
    "planning",
    "cutting",
    "finishing",
    "queued",
  ];
  for (const job of list) {
    if (active.includes(job.status)) {
      if (job.reviewBlocks && job.plannedKeeps) job.status = "review";
      else if (job.clipPlans) job.status = "clipReview";
      else {
        job.status = "error";
        job.error = "Interrupted by a server restart — upload again.";
      }
    }
    jobs.set(job.id, job);
  }
  console.log(`Loaded ${jobs.size} job(s) from Supabase.`);
}

/* ---------- media on local disk (see Phase 2 notes for R2) ----------
 * Media files (source + rendered outputs) live on the local disk; Supabase
 * holds only job STATE + the transcript cache. On the user's own machine these
 * dirs persist across restarts, so nothing is lost. (Cloud object storage for
 * large media is Phase 2 — Cloudflare R2 — since Supabase free tier caps
 * objects at 50 MB, far too small for long-form video.)
 */

/** The source must still be on disk (it's local scratch, not re-fetchable). */
async function ensureLocalSource(job) {
  if (job.input && fs.existsSync(job.input)) return job.input;
  throw new Error("Source video is no longer on disk — please upload it again.");
}

/* ---------- semantic search: chunk → embed → store ---------- */

/** Group words into ~20–30 s passages, preferring sentence ends. */
function chunkPassages(words, { target = 20, max = 32 } = {}) {
  const out = [];
  let cur = [];
  let startT = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (startT === null) startT = w.start;
    cur.push(w.word.trim());
    const dur = w.end - startT;
    const endsSentence = /[.!?]["'”’)\]]*$/.test(w.word.trim());
    const last = i === words.length - 1;
    if (last || (dur >= target && endsSentence) || dur >= max) {
      const text = cur.join(" ").trim();
      if (text) out.push({ start: startT, end: w.end, text });
      cur = [];
      startT = null;
    }
  }
  return out;
}

/** Rank passages by keyword overlap with the question — no embeddings needed.
 *  Good enough to pull the right excerpts for "Ask your video" fully offline. */
const STOP = new Set(
  ("the a an and or but of to in on at for with is are was were be been being it this that these those i you he she " +
   "they we my your his her their our me him them us do does did what which who whom how when where why about as").split(" "),
);
function terms(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}
function rankPassages(passages, query, k = 8) {
  const qt = terms(query);
  if (!qt.length) return passages.slice(0, k); // no keywords → just take the opening
  const qset = new Set(qt);
  const scored = passages.map((p) => {
    const pt = terms(p.text);
    let hits = 0;
    for (const w of pt) if (qset.has(w)) hits++;
    // length-normalized so a long passage doesn't win on volume alone
    return { p, score: hits / Math.sqrt(pt.length + 1) };
  });
  const hasHits = scored.some((s) => s.score > 0);
  if (!hasHits) return passages.slice(0, k); // question words not found → summarize the start
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .sort((a, b) => a.p.start - b.p.start) // chronological for readable citations
    .map((s) => s.p);
}

/** Build + store the search index for a job. Non-critical: never blocks a job. */
async function indexPassages(job, transcript) {
  if (!store.ready) return;
  const passages = chunkPassages(transcript.words || []);
  if (!passages.length) return;
  const vectors = await embed(passages.map((p) => p.text));
  await store.savePassages(
    job.id,
    passages.map((p, i) => ({ ...p, embedding: vectors[i] })),
  );
  job.searchReady = true;
  saveJob(job);
}

/* ---------- auto-reframe: follow the active speaker in vertical ----------
 * v1 targets a fixed side-by-side / grid layout: speakers are assigned to
 * left→right columns by first appearance, and each keep-segment is split at
 * speaker turns so the vertical crop follows whoever is talking. (No per-frame
 * face tracking yet — that's v2.)
 */
function speakerReframe(keeps, speakers, W, H) {
  const order = [];
  for (const u of speakers) if (!order.includes(u.speaker)) order.push(u.speaker);
  const N = Math.min(Math.max(order.length, 1), 3);
  const colOf = (spk) => Math.min(Math.max(order.indexOf(spk), 0), N - 1);

  let cropW = Math.min(W, Math.round((H * 9) / 16));
  cropW -= cropW % 2;
  const xForCol = (c) => {
    let x = Math.round(((c + 0.5) / N) * W - cropW / 2);
    x = Math.max(0, Math.min(W - cropW, x));
    return x - (x % 2);
  };
  const speakerAt = (t) => {
    let last = order[0];
    for (const u of speakers) {
      if (t >= u.start && t <= u.end) return u.speaker;
      if (u.start <= t) last = u.speaker;
    }
    return last;
  };

  const segs = [];
  const reframe = [];
  for (const k of keeps) {
    const bounds = new Set([k.start, k.end]);
    for (const u of speakers) {
      if (u.start > k.start && u.start < k.end) bounds.add(u.start);
      if (u.end > k.start && u.end < k.end) bounds.add(u.end);
    }
    const bs = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < bs.length - 1; i++) {
      const a = bs[i],
        b = bs[i + 1];
      if (b - a < 0.05) continue;
      const x = xForCol(colOf(speakerAt((a + b) / 2)));
      const prev = reframe[reframe.length - 1];
      // Merge a run of same-column pieces so the filtergraph stays small.
      if (prev && prev.x === x && Math.abs(segs[segs.length - 1].end - a) < 1e-3)
        segs[segs.length - 1].end = b;
      else {
        segs.push({ start: a, end: b });
        reframe.push({ x, w: cropW });
      }
    }
  }
  return { segs, reframe };
}

/**
 * Smart transitions: decide a tight/wide framing per segment so the punch-in
 * flips land on meaningful cuts — every real cut, and especially a speaker
 * change — which is what makes a jump cut read as intentional.
 */
function planFraming(segments, speakers) {
  const spkAt = (t) => {
    let last = null;
    for (const u of speakers || []) {
      if (t >= u.start && t <= u.end) return u.speaker;
      if (u.start <= t) last = u.speaker;
    }
    return last;
  };
  const hasSpk = (speakers || []).length > 0;
  let tight = false;
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      const gap = segments[i].start - segments[i - 1].end;
      const realCut = gap > 0.35;
      const spkChange =
        hasSpk && spkAt(segments[i - 1].end) !== spkAt(segments[i].start);
      if (realCut || spkChange) tight = !tight;
    }
    out.push(tight);
  }
  return out;
}

/** Lazily attach the transcript's words (kept in the transcripts table). */
async function ensureWords(job) {
  if (job.words && job.words.length) return;
  if (job.transcript_fp) {
    const t = await store.getTranscript(job.transcript_fp);
    if (t) {
      job.words = t.words || [];
      job.transcriptText = t.text || "";
      return;
    }
  }
  job.words = job.words || [];
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

// Serve the new edit.ai frontend (Next.js static export in web/out) as the
// site root when it's present. It's a single-page app, so any non-API, non-file
// GET falls back to its index.html. If web/out isn't built, we fall back to the
// legacy public/index.html so the server still works out of the box.
const WEB_OUT = path.join(__dirname, "web", "out");
const HAS_WEB = fs.existsSync(path.join(WEB_OUT, "index.html"));
if (HAS_WEB) app.use(express.static(WEB_OUT));
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
      mode: ["ai", "clips", "silence", "highlights"].includes(b.mode)
        ? b.mode
        : "silence",
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
        softCaptions: b.softCaptions === "true",
        captionStyle: b.captionStyle === "bold" ? "bold" : "clean",
        diarize: b.diarize === "true",
        autoReframe: b.autoReframe === "true",
        enhanceAudio: b.enhanceAudio === "true",
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
  await ensureLocalSource(job);
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
  job.transcript_fp = fp;
  let transcript = await store.getTranscript(fp);
  if (transcript) {
    job.stage = "cached — skipped transcription";
  }
  // Local whisper.cpp first: zero API, zero rate limits, one pass for the
  // whole file. Every user transcribes on their own hardware — the app never
  // shares a quota bottleneck. Groq below is only the fallback.
  if (!transcript && whisperLocal.available()) {
    try {
      job.stage = "transcribing locally — no rate limits";
      saveJob(job);
      transcript = await whisperLocal.transcribe(job.input, {
        onProgress: (pct) => {
          job.progress = pct;
          job.stage = `transcribing locally — ${pct}%`;
        },
      });
      await store.saveTranscript(fp, transcript);
    } catch (e) {
      console.error("local whisper failed — falling back to Groq:", e.message);
      transcript = null;
    }
  }
  if (!transcript) {
    const chunks = await extractAudioChunked(
      job.input,
      job.input,
      meta.duration,
    );
    // Per-chunk cache (keyed by file fingerprint + chunk index) so a throttled
    // retry resumes instead of re-transcribing — critical on the free tier's
    // audio-per-hour limit.
    const chunkCache = store.ready
      ? {
          get: (i) => store.getTranscript(`${fp}#${i}`),
          set: (i, data) => store.saveTranscript(`${fp}#${i}`, data),
        }
      : null;
    transcript = await transcribeLong(
      chunks,
      (i, n, note) => {
        job.progress = Math.round((i / n) * 100);
        const base = n > 1 ? `chunk ${i + 1} of ${n}` : "";
        job.stage = note ? `${base} — ${note}` : base;
      },
      chunkCache,
    );
    for (const c of chunks) fs.unlink(c.path, () => {});
    await store.saveTranscript(fp, transcript);
  }
  job.words = transcript.words || [];
  job.transcriptText = transcript.text || "";
  job.progress = 0;

  // Build the semantic-search index in the background — never blocks editing.
  job.searchReady = false;
  indexPassages(job, transcript).catch((e) =>
    console.error("indexPassages:", e.message),
  );

  // Speaker diarization (optional) — who spoke when, for auto-reframe + labels.
  job.speakers = [];
  job.speakerCount = 0;
  if (s.diarize && process.env.ASSEMBLYAI_API_KEY) {
    try {
      job.status = "analyzing";
      job.stage = "identifying speakers";
      saveJob(job);
      const dAudio = path.join(UPLOAD_DIR, `${job.id}.diar.mp3`);
      await extractAudioFull(job.input, dAudio);
      const dia = await diarize(dAudio);
      fs.unlink(dAudio, () => {});
      job.speakers = dia.utterances;
      job.speakerCount = dia.speakers.length;
    } catch (e) {
      console.error("diarize:", e.message);
      job.speakers = [];
      job.speakerCount = 0;
    }
    job.stage = "";
  }

  // Chapters are a bonus, never a blocker — but detectChapters sends the WHOLE
  // transcript to Groq in one call, which on a long video blows past the free
  // tier and back-retries for minutes, freezing the pipeline BEFORE planning
  // (the UI stays stuck on "cached — skipped transcription"). Cap it with a
  // timeout and move on; the engine's own outline pass also yields chapters, so
  // dropping these costs nothing.
  job.stage = "finding chapters";
  saveJob(job);
  try {
    // PRIMARY: embedding-based chapters — local, key-free, topic-aligned, and
    // reliable for every video (no LLM to hang or return garbage). Only if that
    // yields too few do we try the LLM detector (which itself falls back to
    // deterministic). Chapters are a bonus, never a blocker.
    const { chaptersByEmbedding } = require("./lib/chapters");
    let chapters = [];
    try {
      chapters = await chaptersByEmbedding(transcript.segments || [], meta.duration, embed);
      if (chapters.length) console.log(`chapters: ${chapters.length} via embeddings`);
    } catch (e) {
      console.error("embedding chapters failed:", e.message);
    }
    if (chapters.length < 2) {
      const CHAP_MS = parseInt(process.env.CHAPTERS_TIMEOUT_MS || "90000");
      let chapLlm;
      try {
        const localLlm = require("./lib/local-llm");
        if (await localLlm.available()) chapLlm = localLlm.chatJSON;
      } catch {}
      chapters = await Promise.race([
        detectChapters(transcript, meta.duration, { budgetMs: CHAP_MS, llm: chapLlm }),
        new Promise((resolve) => setTimeout(() => resolve([]), CHAP_MS + 15000)),
      ]);
    }
    job.chapters = chapters;
  } catch (e) {
    console.error("chapters skipped:", e.message);
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
      (i, n) => {
        job.stage = n > 1 ? `finding clips — part ${i + 1} of ${n}` : "";
        job.progress = Math.round((i / n) * 100);
      },
    );
    // Each found moment is a SEPARATE standalone short (own file to post).
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

  // ---- M1 engine path (ai mode): segment → signals → score → decide.
  // EDIT_ENGINE=0 disables it; any engine failure falls back to the legacy
  // planner below, so an upload never dies on the new path.
  if (job.mode === "ai" && process.env.EDIT_ENGINE !== "0") {
    try {
      const { enginePlan } = require("./lib/engine/plan");
      const { chatJSON } = require("./lib/ai");
      const { geminiChatJSON, geminiAvailable, getResolvedModel } = require("./lib/gemini");
      job.stage = "engine — reading the video";
      saveJob(job);
      // SCORING LADDER, preference-ordered: LOCAL → Gemini → Groq → deterministic.
      // Local (Ollama on the user's GPU) is best when present — no API key, no
      // quota, no rate limits, no provider JSON quirks — which is why the app can
      // ship key-free. Gemini/Groq are cloud fallbacks. Override the head of the
      // order with SCORER=local|gemini|groq. A failing provider hands off to the
      // next in the chain (marked dead for the rest of the job).
      const localLlm = require("./lib/local-llm");
      const localOk = await localLlm.available();
      const all = {
        local: localOk ? { fn: localLlm.chatJSON, label: `local (${localLlm.modelName()})`, batch: parseInt(process.env.LOCAL_LLM_BATCH || "24") } : null,
        gemini: geminiAvailable() ? { fn: geminiChatJSON, label: `Gemini (${getResolvedModel()})`, batch: 150 } : null,
        groq: process.env.GROQ_API_KEY ? { fn: chatJSON, label: "Groq (batched)", batch: 40 } : null,
      };
      const head = String(process.env.SCORER || (localOk ? "local" : "gemini")).toLowerCase();
      const order = [head, "local", "gemini", "groq"].filter((k, i, a) => a.indexOf(k) === i);
      const chain = order.map((k) => all[k]).filter(Boolean);
      if (chain.length)
        console.log(`scoring via ${chain[0].label}${chain.length > 1 ? ` (+${chain.length - 1} fallback)` : ""}`);
      const primaryName = chain.length ? chain[0].label : "deterministic";

      // Batch size safe for EVERY provider in the chain, so a mid-job failover
      // never hands one provider a batch too big for it.
      const batchSize = chain.length ? Math.min(...chain.map((c) => c.batch)) : 40;

      // Composite scorer that MUST complete a long job on a slow local model.
      // Key rules:
      //  • A transient failure (timeout / rate-limit / network) is RETRIED on
      //    the same provider — a slow call is not a broken provider. Local
      //    stays primary for every batch; one slow call never demotes it.
      //  • Only a HARD error (404 / auth / bad request) marks a provider dead
      //    for the rest of the job.
      //  • So a 2-hour video no longer collapses to deterministic because a
      //    single call was slow.
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const transient = (m = "") =>
        /timeout|aborted|abort|ECONN|network|fetch failed|socket|429|rate.?limit|502|503|504|overload/i.test(m);
      const dead = new Set();
      const llm = !chain.length
        ? null
        : async (messages, opts) => {
            let lastErr;
            for (let i = 0; i < chain.length; i++) {
              if (dead.has(i)) continue;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  return await chain[i].fn(messages, opts);
                } catch (e) {
                  lastErr = e;
                  if (transient(e.message) && attempt < 2) {
                    await sleep(1500 * (attempt + 1)); // let the model catch up, retry same provider
                    continue;
                  }
                  if (!transient(e.message)) dead.add(i); // hard error → don't use again
                  const nextLabel = chain[i + 1]?.label;
                  if (nextLabel) console.error(`${chain[i].label} failed (${e.message}) — trying ${nextLabel}.`);
                  break; // move to the next provider for this batch only
                }
              }
            }
            throw lastErr || new Error("no working LLM provider");
          };
      // DEFAULT scorer is embeddings + signals (local, key-free, no LLM calls —
      // seconds instead of minutes, never times out). Set SCORER=local|gemini|
      // groq to force the LLM scorer instead; SCORER=embed (or unset) uses this.
      const useEmbed = String(process.env.SCORER || "embed").toLowerCase() === "embed";
      if (useEmbed) console.log("scoring via embeddings + signals (local, no LLM calls)");
      const eng = await enginePlan({
        words: job.words,
        duration: meta.duration,
        utterances: job.speakers || [],
        chapters: job.chapters || [],
        mediaPath: job.input,
        embed: useEmbed ? embed : undefined,
        llm,
        batchSize,
        // Diversified scoring passes. The 3-pass median-merge is a quality
        // luxury that TRIPLES LLM spend — a bootstrapped budget doesn't need it,
        // and Groq's free tier can't absorb the parallel burst anyway. Default
        // to 1 frugal pass; raise SCORING_RUNS later if you want more robustness.
        runs: parseInt(process.env.SCORING_RUNS || "1"),
        // per-video director's instruction ("keep the makeup steps, cut the
        // tangents") steers scoring; combined with learned taste below.
        instruction: s.instruction,
        cachePath: path.join(UPLOAD_DIR, `${job.id}.scores.json`),
        telemetryPath: path.join(UPLOAD_DIR, "preferences.jsonl"),
        targetDuration: s.targetDuration ? parseFloat(s.targetDuration) : undefined,
        onProgress: (stage, frac) => {
          job.stage = stage;
          // the engine reports overall planning progress 0..1 — drive the bar
          if (typeof frac === "number") job.progress = Math.min(99, Math.round(frac * 100));
          saveJob(job);
        },
      });
      // Never fail silently: if the scorer fell down the ladder, say WHY.
      if (eng.scoreError) {
        console.error(
          `scoring fell back to ${eng.tier} tier (primary: ${primaryName}):`,
          eng.scoreError,
        );
      }
      const engKeeps = validateEdl(eng.keeps, meta.duration, job.words);
      job.summary = eng.summary;
      job.planStats = computePlanStats(job, engKeeps, meta.duration);
      job.engineFindings = eng.findings || [];
      if (s.review) {
        job.plannedKeeps = engKeeps;
        job.reviewBlocks = eng.blocks;
        job.status = "review";
        saveJob(job);
        return;
      }
      return enqueueRender(job, () => renderJob(job, engKeeps));
    } catch (e) {
      console.error("engine plan failed — falling back to legacy planner:", e.message);
    }
  }

  const plan =
    job.mode === "highlights"
      ? await findHighlights(
          transcript,
          { targetDuration: s.targetDuration },
          meta.duration,
          (i, n) => {
            job.stage = n > 1 ? `finding highlights — part ${i + 1} of ${n}` : "";
            job.progress = Math.round((i / n) * 100);
          },
        )
      : await planEdit(
          transcript,
          s.instruction,
          s.targetDuration,
          meta.duration,
          (i, n) => {
            job.stage = n > 1 ? `planning the edit — part ${i + 1} of ${n}` : "";
            job.progress = Math.round((i / n) * 100);
          },
        );
  const keeps = validateEdl(plan.segments, meta.duration, job.words);
  job.summary = plan.summary || "";
  job.planStats = computePlanStats(job, keeps, meta.duration);

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

const PLAN_FILLERS = new Set([
  "um", "uh", "umm", "uhh", "er", "erm", "hmm", "mmm", "ah", "uhm",
]);

/** Cheap, honest counts for the "AI edit plan" summary card. */
function computePlanStats(job, keeps, duration) {
  const words = job.words || [];
  let longPauses = 0;
  for (let i = 0; i < words.length - 1; i++)
    if (words[i + 1].start - words[i].end > 0.8) longPauses++;
  let fillers = 0;
  for (const w of words) {
    const c = w.word.trim().toLowerCase().replace(/[.,!?]/g, "");
    if (PLAN_FILLERS.has(c)) fillers++;
  }
  const estRuntime = keeps.reduce((s, k) => s + (k.end - k.start), 0);
  return {
    speakers: job.speakerCount || 0,
    topics: (job.chapters || []).length,
    longPauses,
    fillers,
    cuts: keeps.length, // kept segments = number of joins the AI is making
    estRuntime: Math.round(estRuntime),
    originalRuntime: Math.round(duration),
  };
}

function textInRange(words, start, end) {
  return words
    .filter((w) => w.start >= start && w.end <= end)
    .map((w) => w.word.trim())
    .join(" ");
}

/**
 * Rebuild sentence-ish transcript lines from word timestamps, so the
 * repurposing pack works from `job.words` alone (no dependency on Whisper's
 * stored segments). Breaks on end punctuation or a >0.8 s pause, ~30 words max.
 */
function wordsToLines(words) {
  const lines = [];
  let cur = [];
  let startT = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (startT === null) startT = w.start;
    cur.push(w.word.trim());
    const endsSentence = /[.!?…]["'”’)\]]*$/.test(w.word.trim());
    const gap = i + 1 < words.length ? words[i + 1].start - w.end : Infinity;
    if (endsSentence || gap > 0.8 || cur.length >= 30 || i === words.length - 1) {
      const text = cur.join(" ").trim();
      if (text) lines.push({ start: startT, end: w.end, text });
      cur = [];
      startT = null;
    }
  }
  return lines;
}

/** Render each selected clip through the full polish pipeline. */
async function renderClips(job, selectedIdx) {
  const s = job.settings;
  await ensureLocalSource(job);
  await ensureWords(job);
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

    let renderSegs = segs;
    let reframe = null;
    if (s.vertical && s.autoReframe && (job.speakers || []).length && width > height) {
      const rf = speakerReframe(segs, job.speakers, width, height);
      renderSegs = rf.segs;
      reframe = rf.reframe;
    }

    const out = path.join(OUTPUT_DIR, `${job.id}.c${c.i}.mp4`);
    let subFile = null;
    if (s.captions) {
      if (s.captionStyle === "bold") {
        const ass = buildAss(job.words, segs, { vertical: s.vertical, width, height });
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
    await cutVideo(path.resolve(job.input), path.basename(out), renderSegs, null, {
      punchIn: s.punchIn,
      width,
      height,
      draft: s.draft,
      subFile,
      subStyle: s.captionStyle === "clean" ? CAPTION_STYLES.clean : null,
      vertical: s.vertical,
      reframe,
      framing: s.punchIn && !reframe ? planFraming(renderSegs, job.speakers) : null,
      enhanceAudio: s.enhanceAudio,
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
  await ensureLocalSource(job);
  await ensureWords(job);
  const { duration, fps, width, height } = job.meta;

  // Remember the human-approved cut list (pre filler/pause/quantize) so the
  // timeline editor can present and adjust it after rendering.
  job.approvedKeeps = keeps.map((k) => ({ ...k }));
  job.reviewBlocks = buildBlocks(job.approvedKeeps, job.words || [], duration);

  // Every render is a new version — history lets you compare and roll back.
  job.version = (job.version || 0) + 1;
  job.output = path.join(OUTPUT_DIR, `${job.id}.v${job.version}.mp4`);

  // Highlights is an edit mode too — it gets the same polish as AI edit.
  const edit = job.mode === "ai" || job.mode === "highlights";
  if (edit) {
    if (s.fillerRemoval) keeps = removeFillers(keeps, job.words);
    if (s.shrinkPauses) keeps = shrinkPauses(keeps, job.words);
  }
  keeps = quantizeSegments(keeps, fps, duration);

  // Dense edits get their closest gaps merged so the render stays on the fast
  // path. Do it HERE — before captions, keptDuration, and reframe — so every
  // overlay is timed against the EXACT segment list that gets rendered.
  // (Merging inside cutVideo instead desynced burned-in captions: they were
  // built from the un-merged list while the video played the merged one.)
  // No-op unless the edit exceeds the fast-seek budget for this source path.
  if (edit) keeps = planRenderSegments(job.input, keeps);

  // Soft captions ship as a selectable SRT track (mov_text) — no burn-in; the
  // viewer can toggle them, and they never touch the video pixels. Karaoke ASS
  // can't be a soft track, so soft mode always uses plain SRT.
  const soft = edit && s.captions && s.softCaptions;
  if (edit && s.captions && !soft) {
    if (s.captionStyle === "bold")
      job.ass = buildAss(job.words, keeps, { vertical: s.vertical, width, height });
    else job.srt = buildSrt(job.words, keeps);
  }

  job.segments = keeps;
  job.keptDuration = keeps.reduce((sum, k) => sum + (k.end - k.start), 0);

  // Auto-reframe: split the keeps at speaker turns so the vertical crop follows
  // the active speaker. Only for landscape multi-speaker sources in vertical.
  let renderSegs = keeps;
  let reframe = null;
  if (
    edit &&
    s.vertical &&
    s.autoReframe &&
    (job.speakers || []).length &&
    width > height
  ) {
    const rf = speakerReframe(keeps, job.speakers, width, height);
    renderSegs = rf.segs;
    reframe = rf.reframe;
  }

  job.status = "cutting";
  let subFile = null; // burned-in subtitle file (filtered into the video)
  let softSubFile = null; // muxed subtitle track (mov_text)
  if (edit && s.captions) {
    if (soft) {
      const srt = buildSrt(job.words, keeps);
      if (srt) {
        softSubFile = `${job.id}.v${job.version}.srt`;
        fs.writeFileSync(path.join(OUTPUT_DIR, softSubFile), srt);
      }
    } else if (job.ass) {
      subFile = `${job.id}.v${job.version}.ass`;
      fs.writeFileSync(path.join(OUTPUT_DIR, subFile), job.ass);
    } else if (job.srt) {
      subFile = `${job.id}.v${job.version}.srt`;
      fs.writeFileSync(path.join(OUTPUT_DIR, subFile), job.srt);
    }
  }

  // Speaker lower-thirds: burn each named speaker's name-tag while they talk.
  let lowerThirdFile = null;
  if (
    edit &&
    job.speakerNames &&
    Object.keys(job.speakerNames).length &&
    (job.speakers || []).length
  ) {
    const lt = buildLowerThirds(renderSegs, job.speakers, job.speakerNames, {
      width,
      height,
      vertical: s.vertical,
    });
    if (lt) {
      lowerThirdFile = `${job.id}.v${job.version}.lt.ass`;
      fs.writeFileSync(path.join(OUTPUT_DIR, lowerThirdFile), lt);
    }
  }

  await cutVideo(
    path.resolve(job.input),
    path.basename(job.output),
    renderSegs,
    (sec) => {
      job.progress = Math.min(99, Math.round((sec / job.keptDuration) * 100));
    },
    {
      punchIn: edit && s.punchIn,
      width,
      height,
      draft: s.draft,
      subFile,
      softSubFile,
      lowerThirdFile,
      subStyle: s.captionStyle === "clean" ? CAPTION_STYLES.clean : null,
      vertical: edit && s.vertical,
      reframe,
      framing:
        edit && s.punchIn && !reframe ? planFraming(renderSegs, job.speakers) : null,
      musicPath: edit && s.musicPath ? path.resolve(s.musicPath) : null,
      musicVol: s.musicVol,
      enhanceAudio: s.enhanceAudio,
      gains: job.gainRegions || null,
      cwd: OUTPUT_DIR,
    },
  );
  if (subFile) fs.unlink(path.join(OUTPUT_DIR, subFile), () => {});
  if (softSubFile) fs.unlink(path.join(OUTPUT_DIR, softSubFile), () => {});
  if (lowerThirdFile) fs.unlink(path.join(OUTPUT_DIR, lowerThirdFile), () => {});

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
    const { blocks } = subdivideRegion(r, rWords);
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
app.post("/api/jobs/:id/render", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "review" && job.status !== "done")
    return res.status(400).json({ error: "Job is not editable right now." });

  let keeps = sanitizeSegments(
    req.body.included || job.plannedKeeps,
    job.meta.duration,
  );
  if (!keeps.length)
    return res.status(400).json({ error: "Nothing selected to keep." });

  // M3 preference telemetry: the user's corrections against the engine's plan
  // are labeled taste examples fed to future scoring prompts.
  if (job.plannedKeeps?.length && req.body.included) {
    try {
      const { diffPlan, record } = require("./lib/engine/telemetry");
      const corrections = diffPlan(job.plannedKeeps, keeps, job.words || []);
      record(path.join(UPLOAD_DIR, "preferences.jsonl"), corrections);
    } catch {}
  }

  // M3 Cold Open: lift the hook's segment to the front as a teaser.
  if (req.body.coldOpen) {
    try {
      const { liftColdOpen } = require("./lib/engine/plan");
      const hookBlock = (job.reviewBlocks || []).find((b) => b.hook);
      if (hookBlock) keeps = liftColdOpen(keeps, hookBlock.start);
    } catch {}
  }

  // Apply caption text corrections (word index → new text; timing preserved).
  const edits = req.body.wordEdits || {};
  if (Object.keys(edits).length) await ensureWords(job);
  for (const [i, text] of Object.entries(edits)) {
    const idx = parseInt(i);
    if (job.words[idx] && typeof text === "string" && text.length <= 60)
      job.words[idx].word = text;
  }

  // Speaker names (speaker label → display name) for burned-in lower-thirds.
  if (req.body.speakerNames && typeof req.body.speakerNames === "object") {
    const names = {};
    for (const [k, v] of Object.entries(req.body.speakerNames))
      if (typeof v === "string" && v.trim())
        names[String(k)] = v.trim().slice(0, 40);
    job.speakerNames = names;
  }

  // Per-clip audio gain from the timeline's draggable waveform (source-time
  // regions {start,end,db}); applied per segment in cutVideo.
  if (Array.isArray(req.body.gains)) {
    job.gainRegions = req.body.gains
      .map((g) => ({
        start: Math.max(0, +g.start || 0),
        end: Math.min(job.meta.duration, +g.end || 0),
        db: Math.max(-30, Math.min(30, +g.db || 0)),
      }))
      .filter((g) => g.end > g.start && g.db);
  }

  job.progress = 0;
  enqueueRender(job, () => renderJob(job, keeps));
  res.json({ ok: true });
});

/** Chat with your video: answer a question from retrieved transcript passages. */
app.get("/api/jobs/:id/ask", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ answer: "", citations: [] });
  try {
    // In-memory retrieval over the transcript — NO Supabase, NO embeddings. The
    // old path needed a Supabase pgvector index (job.searchReady) that never
    // finished when Supabase was unreachable, so chat hung on "Thinking…".
    await ensureWords(job);
    if (!job.words || !job.words.length)
      return res.json({ answer: "No transcript for this video yet — try again after it finishes.", citations: [] });
    const passages = chunkPassages(job.words);
    const top = rankPassages(passages, q, 8);
    if (!top.length)
      return res.json({ answer: "I couldn't find anything about that in this video.", citations: [] });

    // Answer with the local LLM when Ollama is up (key-free); else Gemini/Groq.
    let askLlm;
    try {
      const localLlm = require("./lib/local-llm");
      if (await localLlm.available()) askLlm = localLlm.chatJSON;
    } catch {}
    const out = await answerQuestion(q, top, askLlm);
    res.json(out);
  } catch (e) {
    res.json({ answer: "", citations: [], error: e.message });
  }
});

/** Audio waveform peaks for the timeline (computed locally with ffmpeg, cached
 *  in memory). Powers the Premiere-style waveform under the clips. */
app.get("/api/jobs/:id/waveform", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.waveform) return res.json({ peaks: job.waveform, duration: job.duration });
  try {
    await ensureLocalSource(job);
    // ~4 buckets/sec, capped so a multi-hour video stays a small payload.
    const buckets = Math.min(8000, Math.max(600, Math.round((job.duration || 0) * 4)));
    const peaks = await computeWaveform(job.input, buckets);
    job.waveform = peaks; // in-memory cache (recomputed from the on-disk source after a restart)
    res.json({ peaks, duration: job.duration });
  } catch (e) {
    res.json({ peaks: [], error: e.message });
  }
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
  await ensureLocalSource(job);
  await ensureWords(job);
  const { duration, fps, width, height } = job.meta;
  job.status = "cutting";
  job.stage = `rendering clip: ${title}`;
  job.progress = 0;

  let segs = baseSegs.map((x) => ({ ...x }));
  if (s.fillerRemoval) segs = removeFillers(segs, job.words);
  if (s.shrinkPauses) segs = shrinkPauses(segs, job.words);
  segs = quantizeSegments(segs, fps, duration);
  const clipDur = segs.reduce((sum, x) => sum + (x.end - x.start), 0);

  let renderSegs = segs;
  let reframe = null;
  if (s.vertical && s.autoReframe && (job.speakers || []).length && width > height) {
    const rf = speakerReframe(segs, job.speakers, width, height);
    renderSegs = rf.segs;
    reframe = rf.reframe;
  }

  const out = path.join(OUTPUT_DIR, `${job.id}.c${i}.mp4`);
  let subFile = null;
  if (s.captions) {
    if (s.captionStyle === "bold") {
      const ass = buildAss(job.words, segs, { vertical: s.vertical, width, height });
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
    renderSegs,
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
      reframe,
      framing: s.punchIn && !reframe ? planFraming(renderSegs, job.speakers) : null,
      enhanceAudio: s.enhanceAudio,
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
  if (job.engineFindings?.length) payload.engineFindings = job.engineFindings;
  if (job.planStats) payload.planStats = job.planStats;
  payload.searchReady = !!job.searchReady;
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
  // Distinct speaker labels (for the "name your speakers" panel) + any saved names.
  if ((job.speakers || []).length) {
    const labels = [];
    for (const u of job.speakers) if (!labels.includes(u.speaker)) labels.push(u.speaker);
    payload.speakerLabels = labels;
    payload.speakerNames = job.speakerNames || {};
  }
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

/** Full word list for transcript search (word + start/end time). */
app.get("/api/jobs/:id/words", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  await ensureWords(job);
  if (!job.words.length)
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

/** Semantic search: find moments in the transcript by meaning. */
app.get("/api/jobs/:id/search", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  if (!store.ready)
    return res.json({ results: [], error: "Search needs Supabase configured." });
  if (!job.searchReady) return res.json({ indexing: true, results: [] });
  try {
    const [vec] = await embed([q]);
    const results = await store.searchPassages(job.id, vec, 12);
    res.json({ results });
  } catch (e) {
    res.json({ results: [], error: e.message });
  }
});

/**
 * Repurposing pack: titles, description, tags, show-notes summary, pull-quotes
 * and per-platform social captions built from the transcript. Generated on
 * demand (cheap, text-only, off the render path) and cached on the job.
 * Also returns chapter timestamp lines ready to paste into a YouTube description.
 */
app.get("/api/jobs/:id/repurpose", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (!process.env.GROQ_API_KEY)
    return res.status(400).json({ error: "AI is off — add GROQ_API_KEY to .env." });

  const chapterLines = (job.chapters || []).map((c) => ({
    t: fmtTimestamp(c.start),
    title: c.title,
  }));

  if (req.query.refresh !== "1" && job.repurpose)
    return res.json({ pack: job.repurpose, chapters: chapterLines });

  try {
    await ensureWords(job);
    if (!job.words || !job.words.length)
      return res.status(400).json({ error: "No transcript for this video yet." });
    // Provider ladder for the content kit, preferring LOCAL:
    //   1. Local LLM (Ollama) — key-free, no limits; chunked map-reduce.
    //   2. Gemini big-context — one fast call (oneShot); falls back to Groq
    //      internally if its model is dead/quota'd.
    //   3. Groq — used automatically when neither of the above is present.
    let kitLlm, oneShot = false;
    try {
      const localLlm = require("./lib/local-llm");
      if (await localLlm.available()) {
        kitLlm = localLlm.chatJSON; // local, chunked, no rate limits
      } else {
        const { geminiChatJSON, geminiAvailable } = require("./lib/gemini");
        if (geminiAvailable()) {
          kitLlm = geminiChatJSON;
          oneShot = true;
        }
      }
    } catch {}
    const pack = await repurpose(
      { segments: wordsToLines(job.words) },
      { title: job.originalName, duration: job.duration, chapters: job.chapters },
      null,
      { llm: kitLlm, oneShot },
    );
    job.repurpose = pack;
    saveJob(job);
    res.json({ pack, chapters: chapterLines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Multiple edit LENGTHS from ONE (cached) scoring pass — tight / balanced /
 * full. Reuses the cached scores so all three are computed for free, no LLM
 * calls. Returns each version's EDL + runtime so the UI can offer a one-click
 * "make it shorter / longer" without re-scoring.
 */
app.get("/api/jobs/:id/versions", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  try {
    await ensureWords(job);
    if (!job.words || !job.words.length)
      return res.status(400).json({ error: "No transcript for this video yet." });
    const { enginePlan } = require("./lib/engine/plan");
    const meta = job.meta || {};
    const presets = [
      { label: "Tight", keepFraction: 0.45 },
      { label: "Balanced", keepFraction: 0.65 },
      { label: "Full", keepFraction: 0.85 },
    ];
    const versions = [];
    for (const pre of presets) {
      const eng = await enginePlan({
        words: job.words,
        duration: meta.duration,
        utterances: job.speakers || [],
        chapters: job.chapters || [],
        llm: null, // cached scores only — zero cost
        cachePath: path.join(UPLOAD_DIR, `${job.id}.scores.json`),
        instruction: job.settings?.instruction,
        telemetryPath: path.join(UPLOAD_DIR, "preferences.jsonl"),
        keepFraction: pre.keepFraction,
      });
      const runtime = eng.keeps.reduce((t, k) => t + (k.end - k.start), 0);
      versions.push({
        label: pre.label,
        keepFraction: pre.keepFraction,
        runtime,
        cuts: eng.keeps.length,
        keeps: eng.keeps,
        summary: eng.summary,
      });
    }
    res.json({ duration: meta.duration, versions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Download captions as an .srt or .vtt file, timed to the EDITED video when a
 * render exists (job.segments), else the full transcript. Free — buildSrt
 * already remaps word timings onto the kept timeline.
 */
app.get("/api/jobs/:id/subtitles.:ext(srt|vtt)", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Job not found");
  try {
    await ensureWords(job);
    if (!job.words || !job.words.length) return res.status(400).send("No transcript yet");
    const dur = job.meta?.duration || job.words[job.words.length - 1].end;
    const segs = job.segments && job.segments.length ? job.segments : [{ start: 0, end: dur }];
    const srt = buildSrt(job.words, segs) || "";
    let body = srt;
    let type = "application/x-subrip";
    if (req.params.ext === "vtt") {
      // SRT → VTT: header + comma→dot in timestamps
      body = "WEBVTT\n\n" + srt.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
      type = "text/vtt";
    }
    const base = String(job.originalName || "subtitles").replace(/\.[^.]+$/, "");
    res.setHeader("Content-Type", type + "; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.${req.params.ext}"`);
    res.send(body);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/** Seconds → YouTube-chapter timestamp (m:ss, or h:mm:ss past an hour). */
function fmtTimestamp(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Stream the ORIGINAL upload (range-enabled) so the clip editor can scrub the
 *  un-rendered ±2 min padding around a clip. */
app.get("/api/source/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.input || !fs.existsSync(job.input))
    return res.status(404).send("No source.");
  const stat = fs.statSync(job.input);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  const m = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
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

/** Source-timeline word list for the LIVE preview's caption overlay. */
app.get("/api/jobs/:id/words", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  try {
    await ensureWords(job);
  } catch {}
  res.json({
    words: (job.words || []).map((w) => ({
      s: +(+w.start).toFixed(2),
      e: +(+w.end).toFixed(2),
      w: w.word,
    })),
  });
});

/** Local output path for a preview/download request (v<n>.mp4 or c<i>.mp4). */
function outputFileFor(job, q) {
  const isClip = q.c !== undefined;
  const n = isClip ? parseInt(q.c) : parseInt(q.v) || job.version;
  return path.join(OUTPUT_DIR, `${job.id}.${isClip ? "c" : "v"}${n}.mp4`);
}

app.get("/api/preview/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).send("Not ready.");
  const file = outputFileFor(job, req.query);
  if (!fs.existsSync(file)) return res.status(404).send("Version not found.");
  res.sendFile(file); // sendFile handles HTTP range requests for <video> seeking
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).send("Not ready.");
  const file = outputFileFor(job, req.query);
  if (!fs.existsSync(file)) return res.status(404).send("Not found.");
  const isClip = req.query.c !== undefined;
  const n = isClip ? parseInt(req.query.c) : parseInt(req.query.v) || job.version;
  const base = path.parse(job.originalName || "clip").name;
  const clip = isClip ? (job.clips || []).find((x) => x.i === n) : null;
  res.download(file, clip ? `${slug(clip.title)}.mp4` : `${base}.v${n}.mp4`);
});

// SPA fallback: any non-API GET that didn't match a static file returns the
// frontend's index.html, so refreshing / deep links still load the app.
if (HAS_WEB) {
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(WEB_OUT, "index.html"));
  });
}

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

async function init() {
  if (store.ready) {
    try {
      await loadPersistedJobs();
    } catch (e) {
      console.error("Job load failed:", e.message);
    }
  }
  app.listen(PORT, () => {
    console.log(`edit.ai running → http://localhost:${PORT}`);
    console.log(
      HAS_WEB
        ? "Frontend: edit.ai (web/out) ✓"
        : "Frontend: public/index.html (single-file build) ✓",
    );
    console.log(
      whisperLocal.available()
        ? "Transcription: local whisper.cpp ✓ (no rate limits)"
        : "Transcription: Groq API (rate-limited) — run `npm run setup-whisper` to go local",
    );
    console.log(
      process.env.GEMINI_API_KEY
        ? "Scoring: Gemini big-context ✓"
        : process.env.GROQ_API_KEY
          ? "Scoring: Groq batched (add GEMINI_API_KEY for whole-video scoring)"
          : "Scoring: deterministic only — no LLM key found",
    );
    console.log(
      store.ready
        ? "Supabase: connected ✓"
        : "Supabase: OFF — set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DEV_USER_ID",
    );
    console.log(
      process.env.GROQ_API_KEY
        ? "AI mode: ready ✓"
        : "AI mode: OFF — add GROQ_API_KEY to .env",
    );
  });
}
init();
