/**
 * lib/media.js — Phases 3 & 4: audio extraction, captions, music with auto-ducking.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function ff(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-y", ...args], { cwd });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("ffmpeg failed:\n" + stderr.slice(-800))),
    );
  });
}

/** Extract mono 16 kHz mp3 for Whisper (32 kbps keeps ~100 min under Groq's 25 MB cap). */
async function extractAudio(videoPath, audioPath) {
  await ff([
    "-i",
    videoPath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-b:a",
    "32k",
    audioPath,
  ]);
  const mb = fs.statSync(audioPath).size / 1024 / 1024;
  if (mb > 24)
    throw new Error(`Audio is ${mb.toFixed(0)} MB — over Groq's 25 MB limit.`);
}

/**
 * Long-video support: split the audio into ~20-minute mp3 chunks (≈5 MB each,
 * comfortably under Groq's 25 MB cap). Returns [{ path, offset }] so the
 * transcriber can shift every timestamp back onto the full-video timeline.
 */
async function extractAudioChunked(
  videoPath,
  baseOut,
  duration,
  chunkSec = 1200,
) {
  const chunks = [];
  for (let off = 0, k = 0; off < duration; off += chunkSec, k++) {
    const p = `${baseOut}.part${k}.mp3`;
    await ff([
      "-ss",
      String(off),
      "-t",
      String(chunkSec),
      "-i",
      videoPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "32k",
      p,
    ]);
    chunks.push({ path: p, offset: off });
  }
  return chunks;
}

/**
 * Map a source-timeline moment to the output timeline after cutting.
 * Returns null if the moment was cut out.
 */
function remapTime(t, keptSegments) {
  let offset = 0;
  for (const s of keptSegments) {
    if (t < s.start) return null;
    if (t <= s.end) return offset + (t - s.start);
    offset += s.end - s.start;
  }
  return null;
}

/**
 * Build SRT captions from Whisper words, remapped onto the post-cut timeline.
 * Groups words into short lines (max 5 words / 2.8 s), breaking at sentence ends.
 * Cues are forced monotonic (never overlap the previous cue) and get a minimum
 * display time without spilling into the next cue.
 */
function buildSrt(words, keptSegments) {
  const mapped = [];
  for (const w of words) {
    const start = remapTime(w.start, keptSegments);
    const end = remapTime(w.end, keptSegments);
    if (start !== null && end !== null && end > start)
      mapped.push({ word: w.word.trim(), start, end });
  }
  if (!mapped.length) return null;

  const cues = [];
  let cur = null;
  for (const w of mapped) {
    const sentenceEnd = /[.!?]$/.test(w.word);
    if (!cur) cur = { start: w.start, end: w.end, words: [w.word] };
    else if (
      cur.words.length >= 5 ||
      w.start - cur.end > 0.6 ||
      w.end - cur.start > 2.8
    ) {
      cues.push(cur);
      cur = { start: w.start, end: w.end, words: [w.word] };
    } else {
      cur.words.push(w.word);
      cur.end = w.end;
    }
    if (sentenceEnd && cur.words.length >= 2) {
      cues.push(cur);
      cur = null;
    }
  }
  if (cur) cues.push(cur);

  // Enforce ordering and readable display times.
  for (let i = 0; i < cues.length; i++) {
    const prev = cues[i - 1],
      next = cues[i + 1];
    if (prev && cues[i].start < prev.end + 0.05)
      cues[i].start = prev.end + 0.05;
    let minEnd = cues[i].start + 0.6; // readable minimum
    if (next) minEnd = Math.min(minEnd, next.start - 0.05);
    cues[i].end = Math.max(cues[i].end, minEnd);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3;
  }

  const stamp = (t) => {
    const h = Math.floor(t / 3600),
      m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60),
      ms = Math.round((t % 1) * 1000);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
  };
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.words.join(" ")}\n`,
    )
    .join("\n");
}

/**
 * Karaoke ASS captions — shorts style. Uppercase, max 3 words per line,
 * the word being spoken highlighted in amber. One Dialogue event per word.
 */
function buildAss(words, keptSegments, { vertical = false } = {}) {
  const mapped = [];
  for (const w of words) {
    const start = remapTime(w.start, keptSegments);
    const end = remapTime(w.end, keptSegments);
    if (start !== null && end !== null && end > start)
      mapped.push({ word: w.word.trim().toUpperCase(), start, end });
  }
  if (!mapped.length) return null;

  // Group into lines of up to 3 words, breaking on gaps and sentence ends.
  const lines = [];
  let cur = null;
  for (const w of mapped) {
    if (!cur) cur = { words: [w] };
    else if (
      cur.words.length >= 3 ||
      w.start - cur.words[cur.words.length - 1].end > 0.6
    ) {
      lines.push(cur);
      cur = { words: [w] };
    } else cur.words.push(w);
    if (/[.!?]$/.test(w.word) && cur.words.length >= 1) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);

  const resX = vertical ? 720 : 1280;
  const resY = vertical ? 1280 : 720;
  const fontSize = vertical ? 58 : 52;
  const marginV = vertical ? 320 : 90;

  const t = (sec) => {
    const h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60),
      cs = Math.round((sec % 1) * 100);
    const p = (n) => String(n).padStart(2, "0");
    return `${h}:${p(m)}:${p(s)}.${p(cs)}`;
  };

  const events = [];
  for (const line of lines) {
    const ws = line.words;
    const lineEnd = ws[ws.length - 1].end + 0.15;
    for (let i = 0; i < ws.length; i++) {
      const start = ws[i].start;
      const end = i + 1 < ws.length ? ws[i + 1].start : lineEnd;
      if (end <= start) continue;
      const text = ws
        .map((w, j) =>
          j === i
            ? `{\\c&H3BB4FF&\\fscx108\\fscy108}${w.word}{\\c&HFFFFFF&\\fscx100\\fscy100}`
            : w.word,
        )
        .join(" ");
      events.push(`Dialogue: 0,${t(start)},${t(end)},Karaoke,,0,0,0,,${text}`);
    }
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,1,0,1,5,2,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

const CAPTION_STYLES = {
  clean:
    "FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=36",
  bold: "FontName=Arial,FontSize=30,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&HCC000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=80",
};

/**
 * Final pass: optional vertical 9:16 reframe (center crop), burn captions
 * (SRT with force_style, or karaoke ASS with embedded styling), and mix
 * looping background music ducked under speech.
 * Runs ffmpeg with cwd = the subtitle folder to dodge Windows path escaping.
 */
async function finishPass(
  inputPath,
  outputPath,
  {
    srtFile,
    assFile,
    captionStyle,
    musicPath,
    musicVol = 0.25,
    vertical = false,
  },
) {
  const cwd = path.dirname(inputPath);
  const args = ["-i", path.basename(inputPath)];
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);

  const vSteps = [];
  if (vertical) vSteps.push("crop=ih*9/16:ih", "scale=720:1280");
  if (assFile) vSteps.push(`subtitles=${assFile}`);
  else if (srtFile) {
    const style = CAPTION_STYLES[captionStyle] || CAPTION_STYLES.clean;
    vSteps.push(`subtitles=${srtFile}:force_style='${style}'`);
  }

  const filters = [];
  let vOut = "0:v",
    aOut = "0:a";
  if (vSteps.length) {
    filters.push(`[0:v]${vSteps.join(",")}[v]`);
    vOut = "[v]";
  }
  if (musicPath) {
    filters.push(
      `[1:a]volume=${musicVol}[m]`,
      `[m][0:a]sidechaincompress=threshold=0.05:ratio=10:attack=25:release=350[duck]`,
      `[0:a][duck]amix=inputs=2:duration=first:normalize=0[a]`,
    );
    aOut = "[a]";
  }

  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push("-map", vOut, "-map", aOut);
  const reencodeVideo = vSteps.length > 0;
  args.push(
    "-c:v",
    reencodeVideo ? "libx264" : "copy",
    ...(reencodeVideo ? ["-preset", "veryfast", "-crf", "22"] : []),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-movflags",
    "+faststart",
    path.basename(outputPath),
  );
  await ff(args, { cwd });
}

module.exports = {
  extractAudio,
  extractAudioChunked,
  remapTime,
  buildSrt,
  buildAss,
  finishPass,
  CAPTION_STYLES,
};
