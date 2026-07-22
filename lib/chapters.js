/**
 * lib/chapters.js — chapters WITHOUT an LLM, from local embeddings.
 *
 * Generative chapter titling needs an LLM, which on a flaky local/cloud setup
 * either hangs or returns garbage. This produces reliable, topic-aligned
 * chapters for every video using the same local embedding model as scoring:
 *   1. embed every transcript segment,
 *   2. find the biggest topic SHIFTS (where the conversation shifts subject),
 *   3. title each chapter with its most representative (central) sentence.
 *
 * Titles are extractive (a real line from that part), not invented — so they're
 * always accurate, if less punchy than an LLM's. `embed` is injected.
 */

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
function meanVec(vecs) {
  if (!vecs.length) return null;
  const dim = vecs[0].length;
  const m = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) m[i] += v[i];
  for (let i = 0; i < dim; i++) m[i] /= vecs.length;
  return m;
}

const FILLER_RE = /\b(um+|uh+|like|you know|so|okay|right|actually|basically|i mean|kind of|sort of)\b/gi;
function cleanTitle(text, max = 52) {
  let t = String(text || "")
    .replace(FILLER_RE, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-–—]+/, "")
    .trim();
  const words = t.split(" ");
  if (words.length > 9) t = words.slice(0, 9).join(" ") + "…";
  if (t.length > max) t = t.slice(0, max).replace(/\s\S*$/, "") + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * @param segments [{start,end,text}]
 * @param duration total seconds
 * @param embed async (texts[]) => vectors[]
 * @returns [{start,end,title}]
 */
async function chaptersByEmbedding(segments, duration, embed, opts = {}) {
  const segs = (segments || []).filter((s) => (s.text || "").trim());
  if (segs.length < 3 || !duration) return [];

  // embed all segment texts (chunked)
  const texts = segs.map((s) => s.text.trim());
  const vecs = [];
  const CH = opts.embedChunk || 256;
  for (let i = 0; i < texts.length; i += CH) {
    const part = await embed(texts.slice(i, i + CH));
    for (const v of part) vecs.push(normalize(v));
  }
  if (vecs.length !== segs.length) throw new Error("embedding count mismatch");

  // topic-shift score per boundary: 1 - cos(window before, window after)
  const W = 3;
  const shift = new Array(segs.length).fill(0);
  for (let i = 1; i < segs.length; i++) {
    const a = meanVec(vecs.slice(Math.max(0, i - W), i));
    const b = meanVec(vecs.slice(i, Math.min(segs.length, i + W)));
    if (a && b) shift[i] = 1 - dot(normalize(a), normalize(b));
  }

  const target = Math.max(3, Math.min(14, Math.round(duration / 150))); // ~1 / 2.5 min
  const minGap = Math.max(45, duration / (target * 2)); // seconds between chapters
  const cands = shift
    .map((sc, i) => ({ i, sc, t: segs[i].start }))
    .slice(1)
    .sort((a, b) => b.sc - a.sc);

  const chosen = [0];
  const times = [segs[0].start];
  for (const c of cands) {
    if (chosen.length >= target) break;
    if (times.every((t) => Math.abs(c.t - t) >= minGap)) {
      chosen.push(c.i);
      times.push(c.t);
    }
  }
  chosen.sort((a, b) => a - b);

  // build each chapter, titled by its most representative segment
  const out = [];
  for (let k = 0; k < chosen.length; k++) {
    const startIdx = chosen[k];
    const endIdx = k + 1 < chosen.length ? chosen[k + 1] : segs.length;
    const spanSegs = segs.slice(startIdx, endIdx);
    const c = normalize(meanVec(vecs.slice(startIdx, endIdx)));
    let best = spanSegs[0],
      bestScore = -Infinity;
    spanSegs.forEach((s, idx) => {
      const rel = dot(vecs[startIdx + idx], c);
      const lenBonus = Math.min(1, s.text.trim().split(/\s+/).length / 12);
      const sc = rel + 0.12 * lenBonus; // prefer central AND reasonably long lines
      if (sc > bestScore) {
        bestScore = sc;
        best = s;
      }
    });
    const title = cleanTitle(best.text) || `Part ${k + 1}`;
    out.push({
      start: Math.round(segs[startIdx].start),
      end: Math.round(k + 1 < chosen.length ? segs[chosen[k + 1]].start : duration),
      title,
    });
  }
  return out;
}

module.exports = { chaptersByEmbedding, cleanTitle };
