/**
 * lib/ai.js — the transcript brain.
 * Whisper (word timestamps) + Llama 3.3 70B (edit plan) via Groq.
 * Reads GROQ_API_KEY from the environment (.env).
 */
const fs = require("fs");

const GROQ_BASE = "https://api.groq.com/openai/v1";

const RETRY_BASE_MS = parseInt(process.env.GROQ_RETRY_BASE_MS || "2000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Groq fetch with exponential backoff. Free-tier rate limits (429) are routine
 * on multi-hour videos — 9+ transcription calls in a row — so failing the whole
 * job on the first 429 is unacceptable. Honors Retry-After when present.
 */
async function groqFetch(url, init) {
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === 4) return res;
    const ra = parseFloat(res.headers?.get?.("retry-after"));
    const wait = Math.min(
      isFinite(ra) ? ra * 1000 : RETRY_BASE_MS * 2 ** attempt,
      60000,
    );
    await sleep(wait);
  }
  return res;
}

function apiKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key)
    throw new Error(
      "GROQ_API_KEY missing — create a .env file (see .env.example).",
    );
  return key;
}

async function transcribe(audioPath) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([fs.readFileSync(audioPath)], { type: "audio/mpeg" }),
    "audio.mp3",
  );
  form.append("model", "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");

  const res = await groqFetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.words?.length && !data.segments?.length)
    throw new Error(
      "Whisper returned no speech — is there talking in this video?",
    );
  return data;
}

const EDL_SYSTEM_PROMPT = `You are a sharp, decisive video editor with the instincts of a
top YouTube editor. You receive a transcript with timestamps in the format
[start-end] text, plus an editing instruction. Gaps between lines are silence.

Return ONLY a JSON object:
{
  "segments": [ { "start": <seconds>, "end": <seconds> } ],
  "summary": "<one sentence: what you cut and why>"
}

EDITING PRINCIPLES — apply all of them:
1. HOOK FIRST. The first kept moment must earn attention. Cut greetings, throat-clearing
   and preamble ("hey guys", "um so today", "before we start") unless the greeting itself
   is the strongest moment. Start where it gets interesting.
2. BE DECISIVE. Timid editing is bad editing. Prefer many precise cuts over few cautious
   ones. Unless told otherwise, expect to remove 25-50% of a raw talking video.
3. ONE TAKE ONLY. When the speaker repeats or restarts a thought ("wait, let me say that
   again"), keep only the best version — usually the last complete one.
4. KILL TANGENTS. If a passage doesn't serve the video's core point, cut the whole
   passage, not just its weakest sentence.
5. STRONG ENDING. End on the best closing line. Cut trailing wind-down ("so yeah,
   that's... that's pretty much it, um") unless it's genuinely charming.
6. NEVER cut mid-sentence. Segments must start and end at sentence boundaries.
7. Timestamps must lie inside the transcript's range. Never invent them.
8. If a target duration is given, hit within ±15% of it by keeping only the strongest
   material. If it forces hard choices, favor the hook and the payoff.
9. Keep segments sorted by start time, non-overlapping.`;

// Keep each transcript request well under Groq's free-tier limit (~12k tokens/
// min). ~30k chars ≈ 7.5k tokens of transcript, leaving room for the prompt +
// response. Long videos are planned in chunks and the keeps are merged.
const PLAN_MAX_CHARS = 30000;

/** Split segment lines into chunks under PLAN_MAX_CHARS, tracking time span. */
function chunkSegmentLines(segments) {
  const chunks = [];
  let cur = [],
    chars = 0,
    start = null,
    end = null;
  const flush = () => {
    if (cur.length) chunks.push({ lines: cur, start, end });
    cur = [];
    chars = 0;
    start = null;
  };
  for (const s of segments) {
    const line = `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text.trim()}`;
    if (chars + line.length > PLAN_MAX_CHARS && cur.length) flush();
    if (start === null) start = s.start;
    cur.push(line);
    chars += line.length + 1;
    end = s.end;
  }
  flush();
  return chunks;
}

/** One planning request for a set of transcript lines. */
async function runPlan(lines, instruction, targetDuration, duration, partNote) {
  const userMsg = [
    `Video duration: ${duration.toFixed(1)} seconds.`,
    partNote || "",
    `Editing instruction: ${instruction || "Tighten this video: remove dead air, filler, false starts and rambling. Make it feel fast and intentional."}`,
    targetDuration
      ? `Target duration: about ${Math.round(targetDuration)} seconds.`
      : "",
    "",
    "Transcript:",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await groqFetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EDL_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Edit planning failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse((await res.json()).choices[0].message.content);
  } catch {
    throw new Error("The LLM returned invalid JSON — try again.");
  }
}

async function planEdit(
  transcript,
  instruction,
  targetDuration,
  duration,
  onProgress,
) {
  const chunks = chunkSegmentLines(transcript.segments || []);

  // Short video → single request (original behavior).
  if (chunks.length <= 1) {
    const plan = await runPlan(
      chunks[0]?.lines || [],
      instruction,
      targetDuration,
      duration,
    );
    if (!Array.isArray(plan.segments) || !plan.segments.length)
      throw new Error(
        "The LLM returned no segments to keep — try a different instruction.",
      );
    return plan;
  }

  // Long video → plan each chunk (distributing any target duration), merge keeps.
  const segments = [];
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i, chunks.length);
    const ch = chunks[i];
    const chunkTarget = targetDuration
      ? Math.max(3, targetDuration * ((ch.end - ch.start) / duration))
      : null;
    const note = `This is part ${i + 1} of ${chunks.length} of a long recording (this part covers ${Math.round(ch.start)}s–${Math.round(ch.end)}s). Edit THIS part only; use the timestamps exactly as given.`;
    const plan = await runPlan(ch.lines, instruction, chunkTarget, duration, note);
    if (Array.isArray(plan.segments)) segments.push(...plan.segments);
    if (plan.summary) summaries.push(plan.summary);
  }
  if (!segments.length)
    throw new Error(
      "The LLM returned no segments to keep — try a different instruction.",
    );
  return {
    segments,
    summary: summaries[0] || "Tightened a long recording section by section.",
  };
}

/**
 * Never trust LLM timestamps blindly:
 * - clamp, sort, merge overlaps
 * - directional word snapping (starts snap back to word starts, ends forward to word ends)
 * - asymmetric padding so sentence endings breathe
 * - bridge micro-gaps: a cut under `minCut` seconds isn't worth a jump cut
 */
function validateEdl(segments, duration, words = [], opts = {}) {
  const { leadPad = 0.1, tailPad = 0.3, minKeep = 0.4, minCut = 0.6 } = opts;

  const snapStart = (t) => {
    for (const w of words) {
      if (w.end > t) return Math.abs(w.start - t) <= 1.0 ? w.start : t;
    }
    return t;
  };
  const snapEnd = (t) => {
    let last = null;
    for (const w of words) {
      if (w.start < t) last = w.end;
      else break;
    }
    return last !== null && Math.abs(last - t) <= 1.0 ? last : t;
  };

  let clean = segments
    .map((s) => ({
      start: Math.max(0, snapStart(+s.start) - leadPad),
      end: Math.min(duration, snapEnd(+s.end) + tailPad),
    }))
    .filter(
      (s) => isFinite(s.start) && isFinite(s.end) && s.end - s.start >= minKeep,
    )
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const s of clean) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minCut)
      last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  if (!merged.length)
    throw new Error("Edit plan had no usable segments after validation.");
  return merged;
}

const FILLER_WORDS = new Set([
  "um",
  "uh",
  "umm",
  "uhh",
  "er",
  "erm",
  "hmm",
  "mmm",
  "ah",
  "uhm",
]);

/**
 * Descript-style filler surgery: cut "um"/"uh" out of the keep-segments using
 * word timestamps. Runs AFTER validateEdl (so gap-bridging doesn't undo it) and
 * relies on the 30 ms audio fades in cutVideo to make the micro-cuts inaudible.
 * Conservative: only removes fillers >= 0.18 s that sit fully inside a segment.
 */
function removeFillers(segments, words) {
  const fillers = words.filter((w) => {
    const clean = w.word
      .trim()
      .toLowerCase()
      .replace(/[.,!?]/g, "");
    return FILLER_WORDS.has(clean) && w.end - w.start >= 0.18;
  });
  if (!fillers.length) return segments;

  let out = [];
  for (const seg of segments) {
    let pieces = [{ ...seg }];
    for (const f of fillers) {
      const cutStart = f.start - 0.04,
        cutEnd = f.end + 0.04;
      pieces = pieces.flatMap((p) => {
        if (cutEnd <= p.start || cutStart >= p.end) return [p]; // no overlap
        const result = [];
        if (cutStart - p.start >= 0.3)
          result.push({ start: p.start, end: cutStart });
        if (p.end - cutEnd >= 0.3) result.push({ start: cutEnd, end: p.end });
        return result.length ? result : [p]; // never delete a whole piece over a filler
      });
    }
    out = out.concat(pieces);
  }
  return out.length ? out : segments;
}

/**
 * Shrink long pauses INSIDE kept segments. The LLM keeps whole sentences (rule 6),
 * so a dramatic 3-second mid-sentence pause survives editing. This pass finds
 * word gaps longer than `maxGap` inside a segment and compresses them to ~`keep`
 * seconds by splitting the segment around the gap.
 */
function shrinkPauses(segments, words, { maxGap = 0.8, keep = 0.4 } = {}) {
  const out = [];
  for (const seg of segments) {
    const inside = words.filter(
      (w) => w.start >= seg.start - 0.05 && w.end <= seg.end + 0.05,
    );
    if (inside.length < 2) {
      out.push(seg);
      continue;
    }
    let pieces = [];
    let cursor = seg.start;
    for (let i = 0; i < inside.length - 1; i++) {
      const gap = inside[i + 1].start - inside[i].end;
      if (gap > maxGap) {
        const cutFrom = inside[i].end + keep / 2;
        const cutTo = inside[i + 1].start - keep / 2;
        if (cutTo - cutFrom > 0.1 && cutFrom - cursor >= 0.3) {
          pieces.push({ start: cursor, end: cutFrom });
          cursor = cutTo;
        }
      }
    }
    if (seg.end - cursor >= 0.2) pieces.push({ start: cursor, end: seg.end });
    out.push(...(pieces.length ? pieces : [seg]));
  }
  return out;
}

/**
 * Transcribe a long video from pre-split audio chunks, shifting every
 * timestamp by the chunk's offset so words land on the full-video timeline.
 */
async function transcribeLong(chunks, onProgress) {
  const all = { text: "", words: [], segments: [] };
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i, chunks.length);
    const t = await transcribe(chunks[i].path);
    const off = chunks[i].offset;
    all.text += (all.text ? " " : "") + (t.text || "").trim();
    for (const w of t.words || [])
      all.words.push({ ...w, start: w.start + off, end: w.end + off });
    for (const s of t.segments || [])
      all.segments.push({ ...s, start: s.start + off, end: s.end + off });
  }
  if (!all.words.length && !all.segments.length)
    throw new Error(
      "Whisper returned no speech — is there talking in this video?",
    );
  return all;
}

const CLIPS_SYSTEM_PROMPT = `You are a viral clips producer for a podcast/long-form channel.
You receive a transcript with timestamps in the format [start-end] text.
Find the BEST self-contained moments that work as standalone short videos.

Return ONLY a JSON object:
{
  "clips": [
    {
      "start": <seconds>, "end": <seconds>,
      "title": "<punchy title, max 60 chars>",
      "score": <0-100 integer: how strong this is as a standalone short>,
      "reason": "<one concrete sentence: WHY it scores that — the specific hook/payoff>"
    }
  ]
}

SCORING (be honest and calibrated, not everything is a 90):
- 85-100: a complete story or hot take with a gripping hook AND a clear payoff/punchline.
- 60-84: solid and self-contained, but the hook or ending is softer.
- <60: interesting but needs context, or trails off. Don't return clips below ~45.
The reason must name the actual hook or payoff, not generic praise.

RULES:
1. SELF-CONTAINED: each clip must make complete sense to someone with ZERO context —
   a full story, a hot take, a surprising fact, a strong exchange. Never start mid-thought.
2. HOOK: the first sentence of each clip must grab attention on its own.
3. COMPLETE: end on a resolution or punchline, never mid-sentence.
4. Duration per clip must be within the requested range.
5. Clips must not overlap. Rank them best-first (highest score first).
6. Timestamps must lie inside the transcript's range.
7. Titles are curiosity-driven, not clickbait lies.`;

/** One clip-finding request for a set of transcript lines. */
async function runFindClips(lines, { count, minLen, maxLen, instruction }, duration, partNote) {
  const userMsg = [
    `Video duration: ${Math.round(duration)} seconds.`,
    partNote || "",
    `Find ${count === "auto" ? "the 3 to 8 best" : count} clips.`,
    `Each clip must be between ${minLen} and ${maxLen} seconds long.`,
    instruction ? `What to look for: ${instruction}` : "",
    "",
    "Transcript:",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await groqFetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLIPS_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clip finding failed (${res.status}): ${body.slice(0, 300)}`);
  }
  try {
    const plan = JSON.parse((await res.json()).choices[0].message.content);
    return Array.isArray(plan.clips) ? plan.clips : [];
  } catch {
    throw new Error("The LLM returned invalid JSON — try again.");
  }
}

/** Find standalone clips; chunks a long transcript to stay under the token cap. */
async function findClips(transcript, opts, duration, onProgress) {
  const chunks = chunkSegmentLines(transcript.segments || []);

  if (chunks.length <= 1) {
    const clips = await runFindClips(chunks[0]?.lines || [], opts, duration);
    if (!clips.length)
      throw new Error("No clips found — try a longer video or different guidance.");
    return clips;
  }

  // Long video → scan each part, then keep the strongest overall.
  const per =
    opts.count === "auto"
      ? "the 1 to 3 best"
      : Math.max(1, Math.ceil((parseInt(opts.count) || 6) / chunks.length));
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i, chunks.length);
    const ch = chunks[i];
    const note = `This is part ${i + 1} of ${chunks.length} (covering ${Math.round(ch.start)}s–${Math.round(ch.end)}s) of a long recording. Find clips in THIS part only.`;
    try {
      all.push(...(await runFindClips(ch.lines, { ...opts, count: per }, duration, note)));
    } catch (e) {
      console.error("findClips chunk:", e.message); // skip a failed part
    }
  }
  if (!all.length)
    throw new Error("No clips found — try a longer video or different guidance.");
  all.sort((a, b) => (b.score || 0) - (a.score || 0));
  const cap = opts.count === "auto" ? 12 : Math.max(1, parseInt(opts.count) || 8);
  return all.slice(0, cap);
}

/** Clamp/snap clip boundaries, enforce duration bounds, drop heavy overlaps. */
function validateClips(
  clips,
  duration,
  words,
  { minLen = 10, maxLen = 240 } = {},
) {
  const snapped = clips
    .map((c) => {
      const seg = validateEdl(
        [{ start: c.start, end: c.end }],
        duration,
        words,
      )[0];
      return {
        ...seg,
        title: String(c.title || "Clip").slice(0, 80),
        reason: String(c.reason || "").slice(0, 200),
        score: Math.max(0, Math.min(100, Math.round(+c.score) || 0)),
      };
    })
    .filter(
      (c) => c.end - c.start >= minLen && c.end - c.start <= maxLen * 1.4,
    );
  const out = [];
  for (const c of snapped) {
    const overlaps = out.some(
      (o) =>
        Math.min(o.end, c.end) - Math.max(o.start, c.start) >
        0.5 * (c.end - c.start),
    );
    if (!overlaps) out.push(c);
  }
  if (!out.length) throw new Error("No usable clips after validation.");
  return out;
}

const CHAPTERS_SYSTEM_PROMPT = `You segment long-form video transcripts into chapters.
You receive a transcript with timestamps [start-end] text.
Return ONLY JSON: { "chapters": [ { "start": <sec>, "end": <sec>, "title": "<3-6 word topic label>" } ] }
Rules: chapters cover the whole video in order without overlap, 4-12 chapters for
an hour of content (scale accordingly), titles are concrete topics not vague labels
("GPU pricing debate" not "Discussion"), boundaries at natural topic shifts.`;

/** Detect topic chapters. Non-critical: callers should catch and continue without. */
async function detectChapters(transcript, duration) {
  const lines = (transcript.segments || []).map(
    (s) => `[${s.start.toFixed(0)}-${s.end.toFixed(0)}] ${s.text.trim()}`,
  );
  const res = await groqFetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CHAPTERS_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Video duration: ${Math.round(duration)}s.\n\nTranscript:\n` +
            lines.join("\n"),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Chapter detection failed (${res.status})`);
  const plan = JSON.parse((await res.json()).choices[0].message.content);
  if (!Array.isArray(plan.chapters)) return [];
  return plan.chapters
    .map((c) => ({
      start: Math.max(0, +c.start || 0),
      end: Math.min(duration, +c.end || 0),
      title: String(c.title || "Chapter").slice(0, 60),
    }))
    .filter((c) => c.end - c.start >= 5)
    .sort((a, b) => a.start - b.start)
    .slice(0, 40);
}

module.exports = {
  transcribe,
  transcribeLong,
  planEdit,
  findClips,
  validateClips,
  validateEdl,
  removeFillers,
  shrinkPauses,
  detectChapters,
};
