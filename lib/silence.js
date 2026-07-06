/**
 * lib/silence.js
 * Core cutting engine: silence detection, segment math, frame-accurate cut & concat.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Get duration (s), fps, and stream presence. */
async function probe(file) {
  const { code, stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-show_entries",
    "stream=codec_type,r_frame_rate,width,height",
    "-of",
    "json",
    file,
  ]);
  if (code !== 0)
    throw new Error("ffprobe failed — is this a valid video file?");
  const info = JSON.parse(stdout);
  const duration = parseFloat(info.format?.duration);
  const streams = info.streams || [];
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const vStream = streams.find((s) => s.codec_type === "video");
  if (!duration || !vStream) throw new Error("Could not read video stream.");
  if (!hasAudio) throw new Error("This video has no audio track.");
  let fps = 30;
  if (vStream.r_frame_rate) {
    const [n, d] = vStream.r_frame_rate.split("/").map(Number);
    if (n && d) fps = n / d;
  }
  return {
    duration,
    fps,
    hasAudio,
    width: vStream.width || 1920,
    height: vStream.height || 1080,
  };
}

async function detectSilence(file, { noiseDb = -35, minSilence = 0.6 } = {}) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-af",
    `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    "-f",
    "null",
    "-",
  ]);
  const silences = [];
  let current = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (start) current = { start: parseFloat(start[1]) };
    if (end && current) {
      current.end = parseFloat(end[1]);
      silences.push(current);
      current = null;
    }
  }
  return silences;
}

function buildKeepSegments(
  silences,
  duration,
  { padding = 0.15, minSegment = 0.25 } = {},
) {
  const keeps = [];
  let cursor = 0;
  for (const s of silences) {
    const segEnd = Math.min(s.start + padding, duration);
    if (segEnd - cursor >= minSegment)
      keeps.push({ start: cursor, end: segEnd });
    cursor = Math.max(s.end - padding, cursor);
  }
  if (duration - cursor >= minSegment)
    keeps.push({ start: cursor, end: duration });
  const merged = [];
  for (const k of keeps) {
    const last = merged[merged.length - 1];
    if (last && k.start <= last.end) last.end = Math.max(last.end, k.end);
    else merged.push({ ...k });
  }
  return merged;
}

/**
 * Snap segment boundaries to the video's frame grid.
 * CRITICAL for caption sync: ffmpeg cuts video on frame boundaries anyway, so if
 * we don't quantize, the real output timeline drifts away from our computed one
 * and captions creep ahead of the speech — a little more with every cut.
 */
function quantizeSegments(segments, fps, duration) {
  const frame = 1 / fps;
  const q = segments.map((s) => {
    let start = Math.round(s.start * fps) / fps;
    let end = Math.round(s.end * fps) / fps;
    start = Math.max(0, start);
    end = Math.min(duration, end);
    if (end - start < frame) end = Math.min(duration, start + frame);
    return { start, end };
  });
  const merged = [];
  for (const s of q) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * Single-pass render: cut + concat + audio polish + captions + vertical + music,
 * all in ONE encode (previously two — this roughly halves render time).
 *
 * opts:
 *   punchIn  — subtle alternating zoom, but the zoom state only flips at REAL
 *              cuts (source gap > 0.35 s). Micro-joins from filler removal keep
 *              the same zoom, so no more zoom flicker on every removed "um".
 *   draft    — fast preview encode (ultrafast/crf28) vs final (veryfast/crf22)
 *   subFile  — subtitle FILENAME (.ass or .srt) living in `cwd`
 *   subStyle — force_style string for .srt subtitles
 *   vertical — 9:16 center crop + 720x1280
 *   musicPath, musicVol — looping bed, ducked under speech
 */
async function cutVideo(input, output, segments, onLog, opts = {}) {
  if (!segments.length)
    throw new Error("Nothing to keep — thresholds too aggressive?");
  const {
    punchIn = false,
    width = 1920,
    height = 1080,
    draft = false,
    subFile = null,
    subStyle = null,
    vertical = false,
    musicPath = null,
    musicVol = 0.25,
    cwd = null,
  } = opts;
  const zw = Math.round((width * 1.07) / 2) * 2;
  const zh = Math.round((height * 1.07) / 2) * 2;

  const parts = [];
  const labels = [];
  let zoomed = false;
  segments.forEach((s, i) => {
    const len = s.end - s.start;
    const fade =
      len > 0.15
        ? `,afade=t=in:st=0:d=0.03,afade=t=out:st=${(len - 0.035).toFixed(3)}:d=0.03`
        : "";
    // Flip zoom only across real cuts, not micro-joins from filler surgery.
    if (punchIn && i > 0 && s.start - segments[i - 1].end > 0.35)
      zoomed = !zoomed;
    const zoom =
      punchIn && zoomed
        ? `,scale=${zw}:${zh},crop=${width}:${height},setsar=1`
        : ",setsar=1";
    parts.push(
      `[0:v]trim=start=${s.start.toFixed(4)}:end=${s.end.toFixed(4)},setpts=PTS-STARTPTS${zoom}[v${i}];`,
      `[0:a]atrim=start=${s.start.toFixed(4)}:end=${s.end.toFixed(4)},asetpts=PTS-STARTPTS${fade}[a${i}];`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(
    `${labels.join("")}concat=n=${segments.length}:v=1:a=1[catv][cata];`,
  );

  // ---- video finishing chain ----
  const vSteps = [];
  if (vertical) vSteps.push("crop=ih*9/16:ih", "scale=720:1280");
  if (subFile)
    vSteps.push(
      subFile.endsWith(".ass")
        ? `subtitles=${subFile}`
        : `subtitles=${subFile}:force_style='${subStyle || ""}'`,
    );
  parts.push(
    vSteps.length ? `[catv]${vSteps.join(",")}[outv];` : `[catv]null[outv];`,
  );

  // ---- audio finishing chain: loudness, then optional ducked music ----
  parts.push(`[cata]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice];`);
  if (musicPath) {
    parts.push(
      `[voice]asplit=2[vc1][vc2];`, // a labeled pad can only be consumed once
      `[1:a]volume=${musicVol}[m];`,
      `[m][vc1]sidechaincompress=threshold=0.05:ratio=10:attack=25:release=350[duck];`,
      `[vc2][duck]amix=inputs=2:duration=first:normalize=0[outa]`,
    );
  } else {
    parts.push(`[voice]anull[outa]`);
  }

  // Write the filter script INSIDE ffmpeg's working directory so the relative
  // reference resolves (subtitle filenames force cwd = the subtitles folder).
  const scriptName = path.basename(output) + ".filter";
  const scriptPath = path.join(cwd || process.cwd(), scriptName);
  fs.writeFileSync(scriptPath, parts.join("\n"));

  const args = ["-hide_banner", "-y", "-i", input];
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
  args.push(
    "-filter_complex_script",
    scriptName,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    draft ? "ultrafast" : "veryfast",
    "-crf",
    draft ? "28" : "22",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  );
  const p = spawn("ffmpeg", args, cwd ? { cwd } : undefined);
  return new Promise((resolve, reject) => {
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += d;
      if (onLog) {
        const m = String(d).match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) onLog(+m[1] * 3600 + +m[2] * 60 + +m[3]);
      }
    });
    p.on("error", reject);
    p.on("close", (code) => {
      fs.unlink(scriptPath, () => {});
      if (code === 0) resolve();
      else
        reject(
          new Error(
            "ffmpeg encode failed:\n" +
              stderr.slice(0, 500) +
              "\n…\n" +
              stderr.slice(-1600),
          ),
        );
    });
  });
}

module.exports = {
  probe,
  detectSilence,
  buildKeepSegments,
  quantizeSegments,
  cutVideo,
};
