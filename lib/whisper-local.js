/**
 * lib/whisper-local.js — local, rate-limit-free transcription (whisper.cpp).
 *
 * THE permanent fix for "rate-limited — retrying in 300s": transcription runs
 * on YOUR machine. No API, no quota, no chunking, no 25MB file caps — a
 * multi-hour video transcribes in one pass at CPU speed (≈5-15× realtime on
 * a typical laptop with the small model; far faster with a GPU build).
 *
 * Setup (one time):  npm run setup-whisper        (downloads binary + model)
 * Or manual: put whisper-cli.exe in ./bin and a ggml model in ./models,
 * or set WHISPER_CPP / WHISPER_MODEL in .env.
 *
 * The server tries local first and falls back to Groq automatically, so a
 * missing binary never breaks anything.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function firstExisting(cands) {
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function binaryPath() {
  return firstExisting([
    process.env.WHISPER_CPP,
    path.join(ROOT, "bin", "whisper-cli.exe"),
    path.join(ROOT, "bin", "whisper-cli"),
    path.join(ROOT, "bin", "main.exe"),
    path.join(ROOT, "bin", "main"),
  ]);
}

function modelPath() {
  if (process.env.WHISPER_MODEL && fs.existsSync(process.env.WHISPER_MODEL))
    return process.env.WHISPER_MODEL;
  const dir = path.join(ROOT, "models");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^ggml-.*\.bin$/.test(f))
      // prefer bigger = better among the common sizes
      .sort((a, b) => order(b) - order(a));
    return files.length ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
  function order(f) {
    if (f.includes("large")) return 5;
    if (f.includes("medium")) return 4;
    if (f.includes("small")) return 3;
    if (f.includes("base")) return 2;
    if (f.includes("tiny")) return 1;
    return 0;
  }
}

function available() {
  return !!(binaryPath() && modelPath());
}

/** ffmpeg → 16k mono wav (what whisper.cpp wants). */
function toWav(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-hide_banner", "-y", "-i", input,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      output,
    ]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error("wav extract failed: " + err.slice(-300))),
    );
  });
}

/**
 * Parse whisper.cpp -oj JSON (with -ml 1 -sow each entry ≈ one word).
 * Returns { text, words: [{word, start, end}] }. Pure — unit tested.
 */
function parseWhisperJson(json) {
  const entries = (json && json.transcription) || [];
  const words = [];
  for (const e of entries) {
    const t = String(e.text || "").trim();
    if (!t) continue;
    const from = (e.offsets?.from ?? 0) / 1000;
    const to = (e.offsets?.to ?? from * 1000) / 1000;
    // -ml 1 can still emit multi-word tokens occasionally; split evenly
    const parts = t.split(/\s+/).filter(Boolean);
    const dur = Math.max(0.02, to - from);
    parts.forEach((w, i) => {
      words.push({
        word: w,
        start: round3(from + (i / parts.length) * dur),
        end: round3(from + ((i + 1) / parts.length) * dur),
      });
    });
  }
  return { text: words.map((w) => w.word).join(" "), words };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Transcribe a media file locally. One pass, no chunks.
 * onProgress(pct 0-100) parsed from whisper's --print-progress output.
 */
async function transcribe(mediaPath, { onProgress, threads } = {}) {
  const bin = binaryPath();
  const model = modelPath();
  if (!bin || !model) throw new Error("local whisper not installed (npm run setup-whisper)");

  const wav = mediaPath + ".16k.wav";
  await toWav(mediaPath, wav);
  const outPrefix = wav + ".out";

  const args = [
    "-m", model,
    "-f", wav,
    "-ml", "1", // one token per segment → word-level timestamps
    "-sow", // split on word boundaries
    "-oj", // write JSON
    "-of", outPrefix,
    "-pp", // print progress to stderr
    "-t", String(threads || Math.max(2, require("os").cpus().length - 1)),
    "-l", process.env.WHISPER_LANG || "auto",
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = "";
    const onData = (d) => {
      const s = d.toString();
      err += s;
      const m = s.match(/progress\s*=\s*(\d+)%/);
      if (m && onProgress) onProgress(parseInt(m[1]));
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("whisper.cpp failed: " + err.slice(-400))),
    );
  });

  const jsonPath = outPrefix + ".json";
  const parsed = parseWhisperJson(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
  fs.unlink(wav, () => {});
  fs.unlink(jsonPath, () => {});
  if (!parsed.words.length) throw new Error("local whisper produced no words");
  return parsed;
}

module.exports = { available, transcribe, parseWhisperJson, binaryPath, modelPath, toWav };
