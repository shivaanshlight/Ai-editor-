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

/**
 * Detect the fastest available H.264 encoder once and cache it. Hardware
 * encoders (NVENC / QSV / VideoToolbox) are 5–20x faster than libx264 and are
 * the single biggest win for long-form renders. Set FORCE_ENCODER to override,
 * or FORCE_ENCODER=libx264 to stay on software.
 */
let _encoderPromise = null;
function pickEncoder() {
  if (_encoderPromise) return _encoderPromise;
  _encoderPromise = (async () => {
    if (process.env.FORCE_ENCODER) return process.env.FORCE_ENCODER;
    try {
      const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"]);
      if (stdout.includes("h264_nvenc")) return "h264_nvenc";
      if (stdout.includes("h264_qsv")) return "h264_qsv";
      if (stdout.includes("h264_videotoolbox")) return "h264_videotoolbox";
    } catch {}
    return "libx264";
  })();
  return _encoderPromise;
}

/**
 * The fast-seek input budget for a given source path — bounded by the OS
 * command-line limit (fast-seek repeats the path once per segment, and Windows
 * caps a command line at ~32,767 chars).
 */
function fastSeekBudget(input) {
  const perInput = input.length + 40;
  const safeMax = Math.max(60, Math.floor(28000 / perInput));
  return Math.min(parseInt(process.env.FAST_SEEK_MAX || "600"), safeMax);
}

/**
 * The EXACT segment list a render will use: dense edits get their closest gaps
 * merged to fit the fast-seek budget. Callers that build captions / lower-thirds
 * MUST plan with this first and feed the SAME list to cutVideo — otherwise the
 * overlay timeline (built from the un-merged list) drifts out of sync with the
 * merged video. No-op when the edit already fits, or when per-segment reframe
 * crops (1:1 with segments) are in play.
 */
function planRenderSegments(input, segments, { reframe = null } = {}) {
  if (process.env.DISABLE_FAST_SEEK) return segments;
  if (reframe && reframe.length === segments.length) return segments;
  const budget = fastSeekBudget(input);
  return segments.length > budget ? fitSegmentCount(segments, budget) : segments;
}

/**
 * Merge adjacent segments across the SMALLEST source gaps until the count fits
 * `maxCount`. Keeps dense edits on the fast render path: re-including a few
 * sub-second gaps is invisible, and far better than an unusably slow
 * full-decode of a huge source through a several-hundred-way concat filter.
 */
function fitSegmentCount(segs, maxCount) {
  const out = segs.map((s) => ({ ...s }));
  while (out.length > maxCount) {
    let bestI = 0;
    let bestGap = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const gap = out[i + 1].start - out[i].end;
      if (gap < bestGap) {
        bestGap = gap;
        bestI = i;
      }
    }
    out[bestI].end = out[bestI + 1].end; // swallow the gap into the left segment
    out.splice(bestI + 1, 1);
  }
  return out;
}

/** Map an encoder + quality tier to its ffmpeg output args. */
function encoderArgs(enc, draft) {
  switch (enc) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", draft ? "p1" : "p4",
        "-rc", "vbr", "-cq", draft ? "30" : "23", "-b:v", "0"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", draft ? "veryfast" : "medium",
        "-global_quality", draft ? "30" : "23"];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-q:v", draft ? "55" : "40"];
    default:
      return ["-c:v", "libx264", "-preset", draft ? "ultrafast" : "veryfast",
        "-crf", draft ? "28" : "22"];
  }
}

/** Get duration (s), fps, DISPLAY dimensions, and stream presence. */
async function probe(file) {
  const { code, stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-show_entries",
    // rotate tag (old) + display-matrix rotation side data (new) so we can
    // report the on-screen orientation, not the coded one.
    "stream=codec_type,r_frame_rate,width,height:stream_tags=rotate:stream_side_data=rotation",
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

  // Portrait phone videos are stored landscape + a rotation flag; ffmpeg
  // auto-rotates on decode, so every downstream filter sees the SWAPPED
  // dimensions. Report those display dimensions or the concat filter (and
  // punch-in / vertical crop) will mismatch and the encode fails.
  let rotate = 0;
  if (vStream.tags && vStream.tags.rotate)
    rotate = parseInt(vStream.tags.rotate, 10) || 0;
  if (Array.isArray(vStream.side_data_list)) {
    const sd = vStream.side_data_list.find((s) => s.rotation !== undefined);
    if (sd) rotate = parseInt(sd.rotation, 10) || 0;
  }
  rotate = ((rotate % 360) + 360) % 360;
  let width = vStream.width || 1920;
  let height = vStream.height || 1080;
  if (rotate === 90 || rotate === 270) [width, height] = [height, width];

  return { duration, fps, hasAudio, width, height, rotate };
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
    softSubFile = null,
    lowerThirdFile = null,
    subStyle = null,
    vertical = false,
    reframe = null,
    framing = null,
    musicPath = null,
    musicVol = 0.25,
    enhanceAudio = false,
    cwd = null,
  } = opts;
  // A stronger punch (10%) makes the two framings distinct enough that the eye
  // reads a cut as intentional — the classic jump-cut hide.
  const zw = Math.round((width * 1.1) / 2) * 2;
  const zh = Math.round((height * 1.1) / 2) * 2;
  // reframe = per-segment {x,w} crops that follow the active speaker; when set,
  // each segment is cropped+scaled to 720x1280 here (no global vertical crop).
  const usingReframe = Array.isArray(reframe) && reframe.length === segments.length;

  // FAST SEEK: open the source once PER kept segment with input seeking
  // (-ss/-t before -i) so ffmpeg decodes only the kept regions instead of the
  // whole source — a big win when a long video is trimmed to a fraction. Each
  // input is one demuxer context, so only use it for a moderate segment count;
  // dense edits (hundreds of tiny keeps) fall back to the single-input trim
  // path, where the decode savings would be small anyway. Input -ss with a
  // re-encode is frame-accurate (ffmpeg decodes+discards to the exact point).
  //
  // The cap is DYNAMIC, bounded by the OS command-line length limit. Fast-seek
  // repeats the full source path once per segment (`-ss N -t N -i <path>`), and
  // Windows caps a process command line at ~32,767 chars — a deep path × 475
  // segments blew past it ("spawn ENAMETOOLONG") and killed the render. So cap
  // the input count so the estimated command line stays safely under the limit;
  // above that, fall back to single-input full-decode (one -i, filtergraph in a
  // script file — short command line, slower decode but always works).
  const MAX_SEEK_INPUTS = fastSeekBudget(input);
  // If the edit is denser than the fast-seek budget, MERGE the closest-together
  // segments (smallest source gaps first) until it fits — rather than collapsing
  // to the brutally slow full-decode path (a several-hundred-way trim+concat
  // filter over a multi-hour source barely progresses; a 475-cut edit sat at
  // 1%). Merging across the tiniest gaps re-includes a few sub-second
  // fillers/pauses: an invisible trade for a render an order of magnitude faster
  // that also can't overflow the command line. Skipped when per-segment reframe
  // crops are in play, since those are 1:1 with the segment list.
  if (
    !process.env.DISABLE_FAST_SEEK &&
    segments.length > MAX_SEEK_INPUTS &&
    !usingReframe
  ) {
    const before = segments.length;
    segments = fitSegmentCount(segments, MAX_SEEK_INPUTS);
    console.log(
      `render: merged ${before} → ${segments.length} closest-gap segments to fit fast-seek`,
    );
  }
  const usingFastSeek =
    !process.env.DISABLE_FAST_SEEK && segments.length <= MAX_SEEK_INPUTS;

  // Fast seek accuracy: input `-ss` lands on the nearest keyframe, which on
  // long-GOP phone footage can be up to a second or two BEFORE s.start — so the
  // segment plays a moment of the wrong content and the speech lands late,
  // making burned-in captions look "ahead". Fix: seek coarsely to SEEK_PAD
  // seconds before the cut (fast, keyframe), then trim to the EXACT frame in the
  // filter. Frame-accurate, and only SEEK_PAD extra seconds get decoded.
  const SEEK_PAD = 2;
  const coarseStart = (s) => Math.max(0, s.start - SEEK_PAD);
  const fineOffset = (s) => s.start - coarseStart(s); // 0..SEEK_PAD

  // Extra (non-segment) input indices depend on how many segment inputs precede.
  const firstExtra = usingFastSeek ? segments.length : 1;
  const musicIdx = musicPath ? firstExtra : null;
  const subIdx = softSubFile ? (musicPath ? firstExtra + 1 : firstExtra) : null;

  const parts = [];
  const labels = [];
  let zoomed = false;
  segments.forEach((s, i) => {
    const len = s.end - s.start;
    // Only fade across REAL cuts (a source gap), not contiguous joins from
    // filler removal or speaker-reframe splits — otherwise the audio dips.
    const gapBefore = i === 0 || s.start - segments[i - 1].end > 0.05;
    const gapAfter =
      i === segments.length - 1 || segments[i + 1].start - s.end > 0.05;
    const fade =
      len > 0.15
        ? (gapBefore ? `,afade=t=in:st=0:d=0.03` : "") +
          (gapAfter ? `,afade=t=out:st=${(len - 0.035).toFixed(3)}:d=0.03` : "")
        : "";
    let vf;
    if (usingReframe) {
      const r = reframe[i];
      vf = `,crop=${r.w}:${height}:${r.x}:0,scale=720:1280,setsar=1`;
    } else {
      // `framing` (from the smart-transition planner) says tight/wide per
      // segment based on cuts + speaker changes; otherwise blind alternation.
      let tight;
      if (framing) tight = !!framing[i];
      else {
        if (punchIn && i > 0 && s.start - segments[i - 1].end > 0.35)
          zoomed = !zoomed;
        tight = punchIn && zoomed;
      }
      vf = tight
        ? `,scale=${zw}:${zh},crop=${width}:${height},setsar=1`
        : ",setsar=1";
    }
    // Fast seek: input was coarse-seeked to SEEK_PAD before the cut, so trim the
    // exact segment from `fineOffset` within it (frame-accurate). Legacy: one
    // input, trim per segment at absolute times.
    const vSrc = usingFastSeek ? `[${i}:v]` : `[0:v]`;
    const aSrc = usingFastSeek ? `[${i}:a]` : `[0:a]`;
    const off = fineOffset(s);
    const vTrim = usingFastSeek
      ? `trim=start=${off.toFixed(4)}:duration=${len.toFixed(4)},`
      : `trim=start=${s.start.toFixed(4)}:end=${s.end.toFixed(4)},`;
    const aTrim = usingFastSeek
      ? `atrim=start=${off.toFixed(4)}:duration=${len.toFixed(4)},`
      : `atrim=start=${s.start.toFixed(4)}:end=${s.end.toFixed(4)},`;
    parts.push(
      `${vSrc}${vTrim}setpts=PTS-STARTPTS${vf}[v${i}];`,
      `${aSrc}${aTrim}asetpts=PTS-STARTPTS${fade}[a${i}];`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(
    `${labels.join("")}concat=n=${segments.length}:v=1:a=1[catv][cata];`,
  );

  // ---- video finishing chain ----
  const vSteps = [];
  if (usingReframe) {
    // already cropped + scaled to 720x1280 per segment above
  } else if (vertical) vSteps.push("crop=ih*9/16:ih", "scale=720:1280");
  else if (draft) {
    // Draft previews of 4K/1440p sources spend almost all their time pushing
    // pixels. Cap the long side at 1280 for a fast proxy encode (final render,
    // draft=false, stays full resolution). ~9x fewer pixels on 4K.
    const longSide = Math.max(width, height);
    if (longSide > 1280) {
      const f = 1280 / longSide;
      const dw = Math.round((width * f) / 2) * 2;
      const dh = Math.round((height * f) / 2) * 2;
      vSteps.push(`scale=${dw}:${dh}`);
    }
  }
  if (subFile)
    vSteps.push(
      subFile.endsWith(".ass")
        ? `subtitles=${subFile}`
        : `subtitles=${subFile}:force_style='${subStyle || ""}'`,
    );
  // Speaker name-tags are a second, independent subtitles pass (always ASS).
  if (lowerThirdFile) vSteps.push(`subtitles=${lowerThirdFile}`);
  parts.push(
    vSteps.length ? `[catv]${vSteps.join(",")}[outv];` : `[catv]null[outv];`,
  );

  // ---- audio finishing chain: (optional cleanup) → loudness → optional music ----
  // Enhancement runs BEFORE loudnorm so the normalizer measures the cleaned
  // signal: high-pass kills mic rumble / AC hum, afftdn is a spectral denoiser
  // for hiss & steady background noise, and a gentle compressor evens out the
  // level swing between a close and a leaned-back speaker. All cheap on audio.
  const aClean = enhanceAudio
    ? "highpass=f=80,afftdn=nf=-25,acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=2,"
    : "";
  parts.push(
    `[cata]${aClean}loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice];`,
  );
  if (musicPath) {
    parts.push(
      `[voice]asplit=2[vc1][vc2];`, // a labeled pad can only be consumed once
      `[${musicIdx}:a]volume=${musicVol}[m];`,
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

  const buildArgs = (enc) => {
    const a = ["-hide_banner", "-y"];
    if (usingFastSeek) {
      // One input per kept segment. Coarse-seek to SEEK_PAD before the cut (fast
      // keyframe seek) and decode just enough to cover the segment; the filter
      // above trims to the exact frame. This is what keeps captions in sync.
      for (const s of segments)
        a.push(
          "-ss",
          coarseStart(s).toFixed(4),
          "-t",
          (fineOffset(s) + (s.end - s.start)).toFixed(4),
          "-i",
          input,
        );
    } else {
      a.push("-i", input);
    }
    if (musicPath) a.push("-stream_loop", "-1", "-i", musicPath);
    if (softSubFile) a.push("-i", softSubFile); // muxed (not burned) below
    a.push("-filter_complex_script", scriptName, "-map", "[outv]", "-map", "[outa]");
    if (subIdx !== null) a.push("-map", `${subIdx}:0`);
    a.push(...encoderArgs(enc, draft), "-c:a", "aac", "-b:a", "160k");
    if (subIdx !== null)
      a.push(
        "-c:s",
        "mov_text",
        "-metadata:s:s:0",
        "language=eng",
        "-disposition:s:0",
        "default",
      );
    // -shortest would truncate the video to the caption track's end; skip it
    // when muxing subtitles (the filtergraph outputs are already bounded).
    else a.push("-shortest");
    a.push("-movflags", "+faststart", output);
    return a;
  };

  const runEncode = (enc) =>
    new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", buildArgs(enc), cwd ? { cwd } : undefined);
      let stderr = "";
      p.stderr.on("data", (d) => {
        stderr += d;
        if (onLog) {
          const m = String(d).match(/time=(\d+):(\d+):([\d.]+)/);
          if (m) onLog(+m[1] * 3600 + +m[2] * 60 + +m[3]);
        }
      });
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                "ffmpeg encode failed:\n" +
                  stderr.slice(0, 500) +
                  "\n…\n" +
                  stderr.slice(-1600),
              ),
            ),
      );
    });

  const enc = await pickEncoder();
  // One honest line per render: which encoder actually ran and whether the
  // fast-seek path applied. libx264 + full-decode explains an hour-long render.
  console.log(
    `render: encoder=${enc}${enc === "libx264" ? " (SOFTWARE — no HW encoder found)" : ""} · ${segments.length} segments · ${usingFastSeek ? "fast-seek" : "full-decode (segment count > 240)"}`,
  );
  try {
    await runEncode(enc);
  } catch (err) {
    // A flaky GPU/driver must never fail a job outright — retry in software.
    if (enc !== "libx264") await runEncode("libx264");
    else throw err;
  } finally {
    fs.unlink(scriptPath, () => {});
  }
  return;
}

module.exports = {
  probe,
  detectSilence,
  buildKeepSegments,
  quantizeSegments,
  cutVideo,
  planRenderSegments,
};
