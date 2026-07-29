/**
 * lib/ffbin.js — resolve the ffmpeg/ffprobe executables ONCE, robustly.
 *
 * In a packaged desktop app (Electron + electron-builder), relying on the
 * bundled binaries being on PATH is fragile: PATH edits don't always survive,
 * and bare `spawn("ffprobe")` on Windows depends on PATHEXT resolution. So we
 * resolve the ffmpeg-static / ffprobe-static packages to ABSOLUTE paths and
 * spawn those directly — an absolute path always works, in every launch mode.
 *
 * Order of preference:
 *   1. FFMPEG_PATH / FFPROBE_PATH env override (power users / CI)
 *   2. the bundled static package (ffmpeg-static / ffprobe-static)
 *   3. bare "ffmpeg" / "ffprobe" (a system install on PATH) as last resort.
 */
const fs = require("fs");

function fromPkg(pkg, prop) {
  try {
    const m = require(pkg);
    let p = prop ? m[prop] : m;
    // ffmpeg-static/ffprobe-static return a path INSIDE app.asar when packaged
    // with asar; we ship asar:false, but handle it anyway for safety.
    if (typeof p === "string" && p.includes("app.asar" + require("path").sep)) {
      const unpacked = p.replace(
        "app.asar" + require("path").sep,
        "app.asar.unpacked" + require("path").sep,
      );
      if (fs.existsSync(unpacked)) p = unpacked;
    }
    if (typeof p === "string" && fs.existsSync(p)) return p;
  } catch {
    /* package not installed */
  }
  return null;
}

const FFMPEG =
  (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)
    ? process.env.FFMPEG_PATH
    : null) ||
  fromPkg("ffmpeg-static") ||
  "ffmpeg";

const FFPROBE =
  (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)
    ? process.env.FFPROBE_PATH
    : null) ||
  fromPkg("ffprobe-static", "path") ||
  "ffprobe";

module.exports = { FFMPEG, FFPROBE };
