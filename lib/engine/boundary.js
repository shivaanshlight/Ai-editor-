/**
 * lib/engine/boundary.js — M0 Boundary craft (S4).
 *
 * Selection decides WHAT to keep; this decides WHERE each cut lands:
 *
 *   - Breath-aligned boundaries: snap every cut edge into the nearest word
 *     gap ≥ minSilence (120ms) within a search window. A boundary must never
 *     sit inside a word.
 *   - Speech-safe J/L offsets: audio may lead (J) or trail (L) the picture
 *     cut by up to jlMax — but only when the extended audio region contains
 *     no speech (verified against word timestamps). Never bleed words from
 *     deleted content across a boundary.
 *   - Shot-boundary preference (soft): when a scene-change timestamp exists
 *     inside the snap window, prefer the silence gap nearest to it. Scene
 *     maps arrive in M1; the hook is here and covered by tests.
 *
 * Inputs are pure data: segments [{start,end}], words [{w,s,e}], optional
 * sceneCuts [t...]. Deterministic; no ffmpeg here.
 */

const DEFAULTS = {
  minSilence: 0.12, // a usable gap must be at least this long (sec)
  snapWindow: 0.6, // how far a boundary may move to find silence (sec)
  jlMax: 0.3, // max J/L audio offset (sec)
  jlMin: 0.15, // desired J/L offset when space allows (sec)
  edgePad: 0.02, // keep this far inside a gap, away from word edges (sec)
};

/** All silence gaps [gs, ge] between consecutive words (plus head/tail). */
function silenceGaps(words, duration = Infinity) {
  const ws = words
    .filter((w) => w.s != null && w.e != null)
    .slice()
    .sort((a, b) => a.s - b.s);
  const gaps = [];
  let cursor = 0;
  for (const w of ws) {
    if (w.s > cursor) gaps.push([cursor, w.s]);
    cursor = Math.max(cursor, w.e);
  }
  if (duration > cursor) gaps.push([cursor, duration === Infinity ? cursor + 3600 : duration]);
  return gaps;
}

/** Is instant t inside any word (with a small tolerance)? */
function inSpeech(t, words, tol = 0) {
  for (const w of words) {
    if (w.s == null || w.e == null) continue;
    if (w.s - tol < t && t < w.e + tol) return true;
    if (w.s > t + 1) break; // words sorted; nothing later can contain t
  }
  return false;
}

/** True when [a,b] overlaps no word at all. */
function spanIsSilent(a, b, words) {
  for (const w of words) {
    if (w.s == null || w.e == null) continue;
    if (w.s < b && w.e > a) return false;
  }
  return true;
}

/**
 * Snap one boundary time into the best silence gap within the window.
 * Prefers (1) gaps ≥ minSilence, (2) near a scene cut when given, (3) close
 * to the original time. Returns the original t if no usable gap exists.
 */
function snapTime(t, gaps, o, sceneCuts = []) {
  let best = null;
  for (const [gs, ge] of gaps) {
    if (ge - gs < o.minSilence) continue;
    const lo = gs + o.edgePad;
    const hi = ge - o.edgePad;
    if (hi <= lo) continue;
    // candidate = closest point to t inside the padded gap
    let cand = Math.max(lo, Math.min(hi, t));
    // soft shot preference: if a scene cut falls in this gap+window, snap to it
    for (const sc of sceneCuts) {
      if (sc >= lo && sc <= hi && Math.abs(sc - t) <= o.snapWindow) {
        cand = sc;
        break;
      }
    }
    const dist = Math.abs(cand - t);
    if (dist <= o.snapWindow && (!best || dist < best.dist)) {
      best = { time: cand, dist };
    }
  }
  return best ? best.time : t;
}

/**
 * Craft all boundaries of an EDL.
 * Returns segments as {start, end, audioStart, audioEnd} where audio* are the
 * J/L-extended audio edges (audioStart ≤ start, audioEnd ≥ end), extended only
 * into verified silence.
 */
function craftBoundaries(segments, words, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sorted = segments.slice().sort((a, b) => a.start - b.start);
  const ws = words
    .filter((w) => w.s != null && w.e != null)
    .slice()
    .sort((a, b) => a.s - b.s);
  const gaps = silenceGaps(ws, opts.duration ?? Infinity);
  const scenes = opts.sceneCuts || [];

  const out = sorted.map((s) => ({ ...s }));

  for (let i = 0; i < out.length; i++) {
    const seg = out[i];
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    const nextStart = i < out.length - 1 ? out[i + 1].start : Infinity;

    // snap start & end into silence (don't cross neighbors)
    if (seg.start > 0.05) {
      const snapped = snapTime(seg.start, gaps, o, scenes);
      seg.start = Math.max(prevEnd, Math.min(snapped, seg.end - 0.05));
    }
    const snappedEnd = snapTime(seg.end, gaps, o, scenes);
    seg.end = Math.min(nextStart, Math.max(snappedEnd, seg.start + 0.05));

    // J/L offsets: extend audio into silence only.
    let aStart = seg.start;
    for (const off of [o.jlMin, o.jlMax / 2, o.jlMax]) {
      const cand = seg.start - off;
      if (cand >= prevEnd && cand >= 0 && spanIsSilent(cand, seg.start, ws)) aStart = cand;
      else break;
    }
    let aEnd = seg.end;
    for (const off of [o.jlMin, o.jlMax / 2, o.jlMax]) {
      const cand = seg.end + off;
      if (cand <= nextStart && spanIsSilent(seg.end, cand, ws)) aEnd = cand;
      else break;
    }
    seg.audioStart = round3(aStart);
    seg.audioEnd = round3(aEnd);
    seg.start = round3(seg.start);
    seg.end = round3(seg.end);
  }

  // merge any segments the snapping made touch
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.01) {
      last.end = Math.max(last.end, s.end);
      last.audioEnd = Math.max(last.audioEnd, s.audioEnd);
    } else merged.push(s);
  }
  return merged;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

module.exports = { craftBoundaries, snapTime, silenceGaps, inSpeech, spanIsSilent, DEFAULTS };
