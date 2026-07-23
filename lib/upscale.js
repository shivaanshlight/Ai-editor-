/**
 * lib/upscale.js — local AI video enhancement (super-resolution) with
 * Real-ESRGAN (ncnn-vulkan). Runs on the user's GPU via Vulkan — no CUDA, no
 * API, no key. Reconstructs real detail (faces, edges, textures) instead of
 * just stretching pixels, taking a low-res clip up to a crisp 1080p.
 *
 * Frame-by-frame, so it's only practical on SHORT outputs (Find Clips shorts,
 * Highlights) — a full-length video would take hours. The app only offers it
 * where the output is short.
 *
 * One-time setup:  node scripts/setup-upscaler.js
 *   → downloads the realesrgan-ncnn-vulkan binary + models into bin/.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MODEL = process.env.UPSCALE_MODEL || "realesr-general-x4v3"; // best for real video
const TARGET = parseInt(process.env.UPSCALE_TARGET || "1080"); // shorter side → 1080p

/** Locate the realesrgan-ncnn-vulkan binary in bin/. */
function binaryPath() {
  const names = [
    "realesrgan-ncnn-vulkan.exe",
    "realesrgan-ncnn-vulkan",
  ];
  for (const n of names) {
    const p = path.join(ROOT, "bin", n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function available() {
  return !!binaryPath();
}

function run(cmd, args, { onLine, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let err = "";
    const feed = (d) => {
      err += d;
      if (onLine) String(d).split(/\r?\n/).forEach((l) => l && onLine(l));
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.slice(-400)}`)),
    );
  });
}

/** Read a video's frame rate via ffprobe (falls back to 30). */
async function probeFps(input) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", [
      "-v", "0", "-of", "csv=p=0", "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate", input,
    ]);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(30));
    p.on("close", () => {
      const m = /(\d+)\s*\/\s*(\d+)/.exec(out);
      if (m && +m[2]) return resolve(+m[1] / +m[2]);
      const n = parseFloat(out);
      resolve(isFinite(n) && n > 0 ? n : 30);
    });
  });
}

/**
 * Enhance a video in place-ish: writes an upscaled version to `output`.
 * @param opts.onProgress (stage:string, frac:number 0..1)
 */
async function upscaleVideo(input, output, opts = {}) {
  const bin = binaryPath();
  if (!bin) throw new Error("Real-ESRGAN not installed — run: node scripts/setup-upscaler.js");
  const on = opts.onProgress || (() => {});
  const targetH = opts.targetHeight || TARGET;

  const work = path.join(path.dirname(output), `._enh_${path.basename(output, path.extname(output))}`);
  const framesIn = path.join(work, "in");
  const framesOut = path.join(work, "out");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(framesIn, { recursive: true });
  fs.mkdirSync(framesOut, { recursive: true });

  try {
    const fps = await probeFps(input);

    // 1) extract frames
    on("enhancing — extracting frames", 0.05);
    await run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", input, "-qscale:v", "2", path.join(framesIn, "f%08d.png")]);
    const total = fs.readdirSync(framesIn).filter((f) => f.endsWith(".png")).length;
    if (!total) throw new Error("no frames extracted");

    // 2) AI super-resolution over the whole folder (GPU). Report progress by
    //    polling how many output frames exist.
    on("enhancing — upscaling frames (GPU)", 0.1);
    const modelDir = path.join(ROOT, "bin", "models");
    const args = ["-i", framesIn, "-o", framesOut, "-n", MODEL, "-s", "4", "-f", "png", "-g", "0"];
    if (fs.existsSync(modelDir)) args.push("-m", modelDir);
    if (process.env.UPSCALE_TILE) args.push("-t", process.env.UPSCALE_TILE);
    const poll = setInterval(() => {
      try {
        const done = fs.readdirSync(framesOut).filter((f) => f.endsWith(".png")).length;
        on(`enhancing — upscaling ${done}/${total} frames`, 0.1 + 0.8 * (done / total));
      } catch {}
    }, 1500);
    try {
      await run(bin, args);
    } finally {
      clearInterval(poll);
    }

    // 3) reassemble upscaled frames + original audio, scaled so the SHORTER
    //    side is the target (1080p landscape → 1920 tall for vertical).
    on("enhancing — reassembling", 0.92);
    const enc = process.env.UPSCALE_ENCODER || "h264_nvenc";
    const scale = `scale=w='if(gte(iw,ih),-2,${targetH})':h='if(gte(iw,ih),${targetH},-2)':flags=lanczos`;
    await run("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-framerate", String(fps),
      "-i", path.join(framesOut, "f%08d.png"),
      "-i", input,
      "-map", "0:v:0", "-map", "1:a:0?",
      "-vf", scale,
      "-c:v", enc, "-pix_fmt", "yuv420p", "-b:v", "0", "-cq", "23",
      "-c:a", "copy",
      "-movflags", "+faststart",
      output,
    ]).catch(async (e) => {
      // NVENC missing → fall back to software x264
      if (enc !== "libx264") {
        await run("ffmpeg", [
          "-hide_banner", "-v", "error", "-y",
          "-framerate", String(fps),
          "-i", path.join(framesOut, "f%08d.png"),
          "-i", input,
          "-map", "0:v:0", "-map", "1:a:0?",
          "-vf", scale,
          "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "copy", "-movflags", "+faststart", output,
        ]);
      } else throw e;
    });
    on("enhancing — done", 1);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return output;
}

module.exports = { available, binaryPath, upscaleVideo, MODEL };
