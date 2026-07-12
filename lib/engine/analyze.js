/**
 * lib/engine/analyze.js — M1 S0 audio signals.
 *
 * The cheap "ears": everything the decision layer knows about the video that
 * isn't text. All pure functions below are deterministic and unit-tested with
 * mocked frames; the two ffmpeg wrappers at the bottom are thin spawn shells
 * used at runtime and skipped gracefully when ffmpeg is unavailable.
 *
 * Signals produced per unit:
 *   energy      0..1, z-scored WITHIN each speaker. Raw loudness is confounded
 *               by mic gain/distance — global normalization would flag a
 *               soft-spoken guest as "low energy" and over-cut one side of an
 *               interview. Keyed on diarization.
 *   highEnergy  z ≥ +1 within the speaker's own distribution
 *   snr / lowQuality  per-unit RMS vs the recording's noise floor. Surfaced,
 *               never auto-cut; never chosen as the hook.
 *   shotBoundaryNear  a scene change lies within `tol` of the unit edge.
 *               Multicam podcasts auto-switch cameras constantly, so the scene
 *               map carries a `multicam` signature and downstream treats shot
 *               snapping as a soft preference.
 *   pause kinds upgraded: a pause after a high-energy or high-salience unit
 *               is "dramatic" (protected); rambling stays as segmented.
 */

const { spawn } = require("child_process");

const DEFAULTS = {
  highEnergyZ: 1.0,
  lowSnrDb: 8, // below this many dB over the noise floor → lowQuality
  noiseFloorPct: 0.1, // percentile of frame RMS treated as the noise floor
  shotTol: 0.4, // "near" a scene change (seconds)
  multicamMaxInterval: 6, // median scene interval below this → multicam
  multicamMinCount: 12,
  dramaticMinPause: 0.6,
  dramaticSalience: 75,
};

/* ------------------------------ speakers ---------------------------------- */

/** Assign each unit its dominant speaker from diarization utterances. */
function attachSpeakers(units, utterances = []) {
  if (!utterances.length) return units;
  for (const u of units) {
    let best = null;
    let bestOv = 0;
    for (const t of utterances) {
      const ov = Math.min(u.end, t.end) - Math.max(u.start, t.start);
      if (ov > bestOv) {
        bestOv = ov;
        best = t;
      }
    }
    if (best) u.speaker = best.speaker;
  }
  return units;
}

/* ------------------------------- energy ----------------------------------- */

/** Mean frame RMS per unit. frames: [{ t, rms }] (rms linear 0..1 or dB<0). */
function energyPerUnit(units, frames) {
  for (const u of units) {
    const fs = frames.filter((f) => f.t >= u.start && f.t < u.end);
    u.rms = fs.length ? fs.reduce((a, f) => a + f.rms, 0) / fs.length : 0;
  }
  return units;
}

/**
 * Z-score energy within each speaker, then squash to 0..1 with a logistic.
 * Units without a speaker share one pool.
 */
function zScorePerSpeaker(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pools = new Map();
  for (const u of units) {
    const key = u.speaker ?? "__all__";
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(u);
  }
  for (const list of pools.values()) {
    const vals = list.map((u) => u.rms ?? 0);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const sd =
      Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1)) || 1e-9;
    for (const u of list) {
      const z = ((u.rms ?? 0) - mean) / sd;
      u.energyZ = Math.round(z * 100) / 100;
      u.energy = Math.round((1 / (1 + Math.exp(-z))) * 100) / 100;
      if (z >= o.highEnergyZ) {
        u.highEnergy = true;
        if (!u.flags.includes("high energy")) u.flags.push("high energy");
      }
    }
  }
  return units;
}

/* --------------------------------- SNR ------------------------------------- */

/**
 * Per-unit SNR over the recording's noise floor (a low percentile of frame
 * RMS). Frames in dB or linear both work — computed in dB internally.
 */
function snrPerUnit(units, frames, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // Frames may carry linear RMS (0..1) or dB (≤ 0). Zero/near-zero linear = silence.
  const toDb = (x) =>
    x > 0 && x <= 1.001 ? 20 * Math.log10(Math.max(x, 1e-5)) : x === 0 ? -100 : x;
  const db = frames.map((f) => toDb(f.rms)).sort((a, b) => a - b);
  if (!db.length) return units;
  const floor = db[Math.max(0, Math.floor(db.length * o.noiseFloorPct) - 1)] ?? db[0];
  for (const u of units) {
    const fs = frames.filter((f) => f.t >= u.start && f.t < u.end);
    if (!fs.length) continue;
    const mean = fs.reduce((a, f) => a + toDb(f.rms), 0) / fs.length;
    const snrDb = mean - floor;
    u.snrDb = Math.round(snrDb * 10) / 10;
    u.snr = Math.round(Math.max(0, Math.min(1, snrDb / 30)) * 100) / 100;
    if (snrDb < o.lowSnrDb) {
      u.lowQuality = true;
      if (!u.flags.includes("lowQuality")) u.flags.push("lowQuality");
    }
  }
  return units;
}

/* ------------------------------ scene map ---------------------------------- */

/** Classify the scene-change list; detect the multicam signature. */
function sceneMap(sceneTimes, duration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const times = (sceneTimes || []).slice().sort((a, b) => a - b);
  let multicam = false;
  if (times.length >= o.multicamMinCount && duration > 0) {
    const intervals = [];
    for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)] ?? Infinity;
    multicam = median <= o.multicamMaxInterval;
  }
  return { times, multicam };
}

/** Mark units whose edges sit near a scene change. */
function markShotBoundaries(units, scenes, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const times = scenes.times || [];
  for (const u of units) {
    u.shotBoundaryNear = times.some(
      (t) => Math.abs(t - u.start) <= o.shotTol || Math.abs(t - u.end) <= o.shotTol,
    );
  }
  return units;
}

/* ---------------------------- dramatic pauses ------------------------------- */

/**
 * Upgrade the M0 pause map: a pause AFTER a high-salience or high-energy unit
 * is dramatic (protected). Requires scores/energy, hence M1.
 */
function upgradePauses(units, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const next = units[i + 1];
    if (!next) continue;
    const strong = u.highEnergy || (u.score ?? 0) >= o.dramaticSalience;
    if (
      strong &&
      u.pauseAfter &&
      u.pauseAfter.s >= o.dramaticMinPause &&
      u.pauseAfter.kind !== "rambling"
    ) {
      u.pauseAfter = { ...u.pauseAfter, kind: "dramatic" };
      next.pauseBefore = { ...next.pauseBefore, kind: "dramatic" };
    }
  }
  return units;
}

/** One call: apply every pure signal to units. */
function applySignals(units, { frames, utterances, sceneTimes, duration } = {}, opts = {}) {
  attachSpeakers(units, utterances || []);
  if (frames && frames.length) {
    energyPerUnit(units, frames);
    zScorePerSpeaker(units, opts);
    snrPerUnit(units, frames, opts);
  }
  const scenes = sceneMap(sceneTimes || [], duration || 0, opts);
  markShotBoundaries(units, scenes, opts);
  return { units, scenes };
}

/* ------------------------- ffmpeg wrappers (runtime) ------------------------ */

function runFf(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const p = spawn("ffmpeg", args);
    const to = setTimeout(() => {
      if (!done) p.kill("SIGKILL");
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => {
      clearTimeout(to);
      resolve(null); // ffmpeg missing — engine proceeds without signals
    });
    p.on("close", () => {
      done = true;
      clearTimeout(to);
      resolve(out + "\n" + err);
    });
  });
}

/** Frame RMS via astats (one frame per ~0.5s window). Returns [{t, rms(dB)}]. */
async function extractEnergyFrames(mediaPath) {
  const txt = await runFf([
    "-hide_banner", "-i", mediaPath, "-vn",
    // mono 16k keeps a multi-hour audio decode to seconds, not minutes
    "-ac", "1", "-ar", "16000",
    "-af", "astats=metadata=1:reset=12,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-",
  ], 240000);
  if (!txt) return null;
  const frames = [];
  let t = null;
  for (const line of txt.split("\n")) {
    const mT = line.match(/pts_time:([\d.]+)/);
    if (mT) t = parseFloat(mT[1]);
    const mR = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (mR && t != null) {
      const v = mR[1] === "-inf" ? -90 : parseFloat(mR[1]);
      frames.push({ t, rms: v });
    }
  }
  return frames.length ? frames : null;
}

/** Scene-change timestamps via the scene filter. */
async function extractSceneCuts(mediaPath, threshold = 0.3) {
  const txt = await runFf([
    "-hide_banner", "-i", mediaPath,
    // downscale + sample at 3fps: scene detection doesn't need full frames,
    // and a full-res pass over a multi-hour video would run for an hour
    "-vf", `scale=320:-2,fps=3,select='gt(scene,${threshold})',metadata=print`,
    "-an", "-f", "null", "-",
  ], 240000);
  if (!txt) return null;
  const times = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) times.push(parseFloat(m[1]));
  }
  return times;
}

module.exports = {
  attachSpeakers,
  energyPerUnit,
  zScorePerSpeaker,
  snrPerUnit,
  sceneMap,
  markShotBoundaries,
  upgradePauses,
  applySignals,
  extractEnergyFrames,
  extractSceneCuts,
  DEFAULTS,
};
