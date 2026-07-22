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
async function groqFetch(url, init, onRetry, timeoutMs) {
  let res;
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // timeoutMs is opt-in (chat calls only). Transcription uploads push large
      // audio bodies and must NEVER get a timeout — a slow upload isn't a hang.
      res = await fetch(
        url,
        timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init,
      );
    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1)
        throw new Error(`Groq call failed after ${MAX_ATTEMPTS} attempts: ${e.message}`);
      const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, 300000);
      if (onRetry) onRetry(attempt, wait, 0);
      await sleep(wait);
      continue;
    }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === MAX_ATTEMPTS - 1) return res;
    const ra = parseFloat(res.headers?.get?.("retry-after"));
    // Honor long Retry-After values (free-tier audio-per-hour throttling can ask
    // for several minutes) up to a 5-minute cap, so we wait it out instead of
    // giving up early.
    const wait = Math.min(
      isFinite(ra) ? ra * 1000 + 500 : RETRY_BASE_MS * 2 ** attempt,
      300000,
    );
    if (onRetry) onRetry(attempt, wait, res.status);
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

/**
 * Generic JSON-mode chat call — the adapter the M1 engine scorer injects.
 * messages in, parsed JSON object out. Rides the same 429-aware groqFetch.
 */
async function chatJSON(messages, { temperature = 0.2, model = "llama-3.3-70b-versatile" } = {}) {
  const res = await groqFetch(
    `${GROQ_BASE}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        response_format: { type: "json_object" },
        messages,
      }),
    },
    null,
    parseInt(process.env.GROQ_TIMEOUT_MS || "120000"), // hung chat call → retry, not stall
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM call failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return JSON.parse((await res.json()).choices[0].message.content);
}

async function transcribe(audioPath, onRetry) {
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

  const res = await groqFetch(
    `${GROQ_BASE}/audio/transcriptions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: form,
    },
    onRetry,
  );
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

// Keep each transcript request well under Groq's free-tier limit (12k tokens/
// min). Timestamped transcript lines are token-dense (~2 chars/token), so cap
// conservatively at 16k chars per chunk and use whole-second timestamps (the
// LLM's boundaries get snapped to word edges later anyway). Long videos are
// planned in chunks and the keeps are merged.
const PLAN_MAX_CHARS = 16000;

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
    const line = `[${Math.round(s.start)}-${Math.round(s.end)}] ${s.text.trim()}`;
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
async function transcribeLong(chunks, onProgress, cache) {
  const all = { text: "", words: [], segments: [] };
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i, chunks.length);
    // Resume from cached chunks so a throttled retry never re-spends the
    // free-tier audio-per-hour budget on work already done.
    let t = cache ? await cache.get(i).catch(() => null) : null;
    if (!t) {
      const onRetry = (attempt, waitMs) => {
        if (onProgress)
          onProgress(
            i,
            chunks.length,
            `rate-limited — retrying in ${Math.ceil(waitMs / 1000)}s`,
          );
      };
      t = await transcribe(chunks[i].path, onRetry);
      if (cache)
        await cache
          .set(i, { text: t.text, words: t.words, segments: t.segments })
          .catch(() => {});
    }
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
/** One call → chapters for a single transcript window. Uses the injected
 *  provider (local LLM) when given — key-free, no rate-limit stalls — else Groq. */
async function runChapters(lines, duration, note = "", llm) {
  const messages = [
    { role: "system", content: CHAPTERS_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Video duration: ${Math.round(duration)}s.\n` +
        (note ? note + "\n" : "") +
        `\nTranscript:\n` +
        lines.join("\n"),
    },
  ];
  if (llm) {
    const plan = await llm(messages, { temperature: 0.2 });
    return Array.isArray(plan.chapters) ? plan.chapters : [];
  }
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
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Chapter detection failed (${res.status})`);
  const plan = JSON.parse((await res.json()).choices[0].message.content);
  return Array.isArray(plan.chapters) ? plan.chapters : [];
}

// Feeding the WHOLE transcript to one call blows past the context window on a
// long video and times out — so we chunk it into ~16k-char windows, detect
// chapters per window, and merge. A window that fails is skipped, not fatal, so
// a long recording still gets most of its chapters instead of none.
async function detectChapters(transcript, duration, opts = {}) {
  const budgetMs = opts.budgetMs || Infinity;
  const llm = opts.llm; // injected local LLM (preferred), else Groq
  const t0 = Date.now();
  const chunks = chunkSegmentLines(transcript.segments || []);
  let raw = [];
  if (chunks.length <= 1) {
    raw = await runChapters(chunks[0]?.lines || [], duration, "", llm);
  } else {
    for (let i = 0; i < chunks.length; i++) {
      // Out of time — return the chapters gathered so far instead of nothing.
      if (Date.now() - t0 > budgetMs) {
        console.error(`detectChapters: budget hit after ${i}/${chunks.length} parts — using partial.`);
        break;
      }
      const ch = chunks[i];
      const note = `This is part ${i + 1} of ${chunks.length} of a long recording (covering ${Math.round(ch.start)}s–${Math.round(ch.end)}s). Give chapters for THIS part only, using the timestamps exactly as shown.`;
      try {
        raw.push(...(await runChapters(ch.lines, duration, note, llm)));
      } catch (e) {
        console.error(`detectChapters part ${i + 1}:`, e.message); // skip, keep going
      }
    }
  }

  const chapters = raw
    .map((c) => ({
      start: Math.max(0, +c.start || 0),
      end: Math.min(duration, +c.end || 0),
      title: String(c.title || "Chapter").slice(0, 60),
    }))
    .filter((c) => c.end - c.start >= 5)
    .sort((a, b) => a.start - b.start);

  // Drop near-duplicate boundaries where two adjacent windows both titled the
  // same moment (keep the earlier one).
  const merged = [];
  for (const c of chapters) {
    const prev = merged[merged.length - 1];
    if (prev && c.start - prev.start < 8) continue;
    merged.push(c);
  }
  // GUARANTEE chapters for every video: if the LLM produced nothing usable
  // (timeout / bad JSON / empty), build them deterministically from the
  // transcript so the UI always shows a chapter list.
  if (merged.length < 2) return fallbackChapters(transcript, duration);
  return merged.slice(0, 40);
}

/**
 * Deterministic chapters — no LLM. Split the video into evenly-spaced spans and
 * title each from the most substantive line spoken in it. Rough, but always
 * present and always time-accurate, so no video is left without chapters.
 */
function fallbackChapters(transcript, duration) {
  const segs = (transcript.segments || []).filter((s) => (s.text || "").trim());
  if (!segs.length || !duration) return [];
  const count = Math.max(3, Math.min(12, Math.round(duration / 150))); // ~1 per 2.5 min
  const span = duration / count;
  const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const clean = (t) =>
    titleCase(
      String(t)
        .replace(/\b(um+|uh+|like|you know|so|okay|right|actually|basically)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim(),
    ).slice(0, 55);
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = i * span;
    const to = (i + 1) * span;
    const inSpan = segs.filter((s) => s.start >= from && s.start < to);
    if (!inSpan.length) continue;
    // pick the wordiest line in this span as the most "topic-bearing"
    const best = inSpan.slice().sort((a, b) => (b.text || "").length - (a.text || "").length)[0];
    const title = clean(best.text) || `Part ${i + 1}`;
    out.push({ start: Math.round(from), end: Math.round(Math.min(duration, to)), title });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Repurposing pack — turn the transcript into everything you publish
 * AROUND the video: YouTube title options + description + tags, a show-notes
 * summary, memorable pull-quotes, and per-platform social captions.
 *
 * This is pure text work, so it's cheap (~cents) and never touches the render
 * pipeline. A long podcast can't fit in one prompt, so we map-reduce: summarize
 * each transcript chunk to bullets, then write the pack from the combined
 * bullets. Generated on demand (not on every job) and cached on the job.
 * ------------------------------------------------------------------ */
const DIGEST_SYSTEM_PROMPT = `You compress a section of a long-form video transcript
into tight factual bullet points for later summarization. Return ONLY JSON:
{ "bullets": ["<concrete point, name the specific topic/claim/story>"] }
Rules: 5-9 bullets, each a real point actually said (not meta-description like
"the speaker talks about X"). Capture hooks, strong opinions, stories, numbers,
and memorable lines. No preamble.`;

/** Map step: compress one transcript chunk to bullet points. Uses the injected
 *  provider (local LLM) when given — key-free and no rate limits — else Groq. */
async function digestChunk(lines, llm) {
  if (llm) {
    const data = await llm(
      [
        { role: "system", content: DIGEST_SYSTEM_PROMPT },
        { role: "user", content: "Transcript section:\n" + lines.join("\n") },
      ],
      { temperature: 0.2 },
    );
    return Array.isArray(data.bullets) ? data.bullets : [];
  }
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
        { role: "system", content: DIGEST_SYSTEM_PROMPT },
        { role: "user", content: "Transcript section:\n" + lines.join("\n") },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Digest failed (${res.status})`);
  const data = JSON.parse((await res.json()).choices[0].message.content);
  return Array.isArray(data.bullets) ? data.bullets : [];
}

const REPURPOSE_SYSTEM_PROMPT = `You are a content strategist and copywriter for a
podcast/long-form YouTube channel. From a digest of the episode, write the full
publishing pack. Return ONLY this JSON shape (fill every field):
{
  "titles": ["<5 curiosity-driven YouTube titles, <=70 chars, no lies>"],
  "summary": "<2-3 sentence episode summary, plain and specific>",
  "description": "<3-4 paragraph YouTube description written for a viewer, ending with a soft CTA to subscribe. Do NOT include timestamps — they are added separately.>",
  "tags": ["<12-18 YouTube search tags, lowercase, no # >"],
  "hashtags": ["<6-10 hashtags including the # >"],
  "pullQuotes": ["<4-6 short, punchy, verbatim-style memorable lines from the episode>"],
  "tweet": "<one strong standalone tweet/X post hook, <=270 chars, no hashtags>",
  "thread": ["<3-5 tweet thread: hook, 2-3 insight tweets, a closing line with a nudge to watch>"],
  "linkedin": "<a professional LinkedIn post: a hook line, 2-3 short takeaways as lines, a reflective close. Use line breaks.>",
  "instagram": "<a warm Instagram caption with 1-2 emoji and a question to drive comments, then hashtags on a new line>",
  "blog": "<a 400-600 word blog post / newsletter version of the episode in Markdown: a hook intro, 3-4 short sections with '## ' subheadings, and a closing takeaway. Specific and readable, not fluffy.>"
}
STYLE: specific over generic (name the actual topics/takeaways), confident,
never clickbait that lies. Match a smart, friendly creator voice.`;

/** Reduce step: write the publishing pack from the episode digest. */
async function writePack(digest, meta, llm) {
  const userMsg = [
    meta.title ? `Working title: ${meta.title}` : "",
    meta.duration
      ? `Episode length: about ${Math.round(meta.duration / 60)} minutes.`
      : "",
    meta.chapters?.length
      ? "Chapters: " + meta.chapters.map((c) => c.title).join("; ")
      : "",
    "",
    "Episode digest:",
    digest,
  ]
    .filter(Boolean)
    .join("\n");

  // Injected big-context provider (Gemini): one call, returns parsed JSON.
  // If it fails (dead model / quota / rate limit) we DON'T give up — fall
  // through to the Groq path below so the content kit still generates.
  if (llm) {
    try {
      return await llm(
        [
          { role: "system", content: REPURPOSE_SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        { temperature: 0.6 },
      );
    } catch (e) {
      console.error(`content kit: primary LLM failed (${e.message}) — falling back to Groq.`);
    }
  }

  const res = await groqFetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REPURPOSE_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Repurpose failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return JSON.parse((await res.json()).choices[0].message.content);
}

/** Normalize/clamp the pack so the UI always gets clean arrays and strings. */
function cleanPack(p) {
  const arr = (v, n, len) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .map((x) => x.slice(0, len))
      .slice(0, n);
  const str = (v, len) => String(v || "").trim().slice(0, len);
  return {
    titles: arr(p.titles, 6, 100),
    summary: str(p.summary, 600),
    description: str(p.description, 5000),
    tags: arr(p.tags, 20, 40).map((t) => t.replace(/^#/, "")),
    hashtags: arr(p.hashtags, 12, 40).map((t) => (t.startsWith("#") ? t : "#" + t)),
    pullQuotes: arr(p.pullQuotes, 8, 240),
    tweet: str(p.tweet, 400),
    thread: arr(p.thread, 8, 400),
    linkedin: str(p.linkedin, 3000),
    instagram: str(p.instagram, 2200),
    blog: str(p.blog, 8000),
  };
}

/**
 * Build the full repurposing pack for an episode. `chapters` (if already
 * detected) sharpen the summary and are returned to the UI for timestamp lines.
 */
async function repurpose(transcript, meta = {}, onProgress, opts = {}) {
  const llm = opts.llm; // injected provider (local LLM or Gemini), optional
  // oneShot: this provider can swallow the WHOLE transcript in one call
  // (Gemini's huge context). Local models can't, so they take the chunked
  // map-reduce path below — which, being local, has no rate limits to flood.
  const oneShot = !!opts.oneShot && !!llm;
  const chunks = chunkSegmentLines(transcript.segments || []);
  let digest;
  if (oneShot) {
    // Big-context path: feed the whole transcript straight to the writer in ONE
    // call instead of dozens of map-reduce calls.
    digest = (transcript.segments || [])
      .map((s) => (s.text || "").trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 200000);
    if (!digest.trim()) throw new Error("No transcript to summarize.");
  } else if (chunks.length <= 1) {
    digest = (chunks[0]?.lines || []).join("\n").slice(0, 14000);
  } else {
    // Map: summarize each chunk to bullets, then reduce over the bullets. Passes
    // the injected llm (local) into digestChunk so the whole thing stays local
    // and key-free; falls back to Groq inside digestChunk when llm is absent.
    const bullets = [];
    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) onProgress(i, chunks.length + 1);
      try {
        const b = await digestChunk(chunks[i].lines, llm);
        bullets.push(`Part ${i + 1}:`, ...b.map((x) => `- ${x}`));
      } catch (e) {
        console.error("digestChunk:", e.message); // skip a failed part
      }
    }
    digest = bullets.join("\n").slice(0, 14000);
    if (!digest.trim())
      throw new Error("Could not summarize the transcript — try again.");
  }
  if (onProgress) onProgress(chunks.length, chunks.length + 1);
  // writePack uses the injected llm (local/Gemini) and, on failure, falls back
  // to Groq internally — so the kit generates as long as any provider works.
  const raw = await writePack(digest, meta, llm);
  return cleanPack(raw);
}

/* ------------------------------------------------------------------ *
 * Highlights Reel — assemble ONE condensed "best-of" cut of a long video.
 * Unlike findClips (separate shorts), this returns keep-segments in
 * chronological order that concat into a single watchable recap.
 * ------------------------------------------------------------------ */
const HIGHLIGHTS_SYSTEM_PROMPT = `You are assembling a CONDENSED HIGHLIGHTS cut of a
long video — like a "best of" recap that someone could watch instead of the full
thing. You receive a transcript with [start-end] text lines.

Return ONLY JSON:
{ "segments": [ { "start": <seconds>, "end": <seconds> } ], "summary": "<one sentence>" }

RULES:
1. Keep only the most engaging, informative, funny, or surprising passages — the
   moments that make the video worth watching.
2. Every kept segment must be a COMPLETE thought (start and end at sentence
   boundaries). Never cut mid-sentence.
3. Chronological order, non-overlapping.
4. Hit close to the requested total duration by keeping only the strongest material.
   If forced to choose, favor self-contained stories, strong opinions and payoffs.
5. Timestamps must lie inside the transcript's range. Never invent them.`;

async function runHighlights(lines, target, duration, partNote) {
  const userMsg = [
    `Full video duration: ${Math.round(duration)} seconds.`,
    partNote || "",
    `Assemble a highlights cut of about ${Math.round(target)} seconds total.`,
    "",
    "Transcript:",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await groqFetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: HIGHLIGHTS_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Highlights failed (${res.status}): ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse((await res.json()).choices[0].message.content);
  } catch {
    throw new Error("The LLM returned invalid JSON — try again.");
  }
}

async function findHighlights(transcript, { targetDuration }, duration, onProgress) {
  const chunks = chunkSegmentLines(transcript.segments || []);
  const target = Math.max(30, Math.min(targetDuration || Math.round(duration * 0.15), duration));

  if (chunks.length <= 1) {
    const plan = await runHighlights(chunks[0]?.lines || [], target, duration);
    if (!Array.isArray(plan.segments) || !plan.segments.length)
      throw new Error("No highlights found — try a longer video.");
    return plan;
  }

  const segments = [];
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i, chunks.length);
    const ch = chunks[i];
    const chunkTarget = Math.max(8, target * ((ch.end - ch.start) / duration));
    const note = `This is part ${i + 1} of ${chunks.length} (covering ${Math.round(ch.start)}s–${Math.round(ch.end)}s) of a long recording. Pick highlights from THIS part only.`;
    try {
      const plan = await runHighlights(ch.lines, chunkTarget, duration, note);
      if (Array.isArray(plan.segments)) segments.push(...plan.segments);
      if (plan.summary) summaries.push(plan.summary);
    } catch (e) {
      console.error("highlights chunk:", e.message);
    }
  }
  if (!segments.length) throw new Error("No highlights found — try a longer video.");
  segments.sort((a, b) => (+a.start || 0) - (+b.start || 0));
  return { segments, summary: summaries[0] || "A condensed highlights cut of the best moments." };
}

/* ------------------------------------------------------------------ *
 * Chat with your video — answer a question from retrieved transcript
 * passages, citing the timestamps it used.
 * ------------------------------------------------------------------ */
const CHAT_SYSTEM_PROMPT = `You answer questions about a video using ONLY the provided
transcript excerpts. Each excerpt is tagged with its start time in seconds.

Return ONLY JSON:
{ "answer": "<concise, direct answer in 1-4 sentences>",
  "citations": [ { "start": <seconds>, "quote": "<short verbatim snippet you used>" } ] }

RULES:
- Base the answer strictly on the excerpts. If they don't contain the answer, say
  so plainly in "answer" and return an empty citations array.
- Cite the 1-3 excerpts you actually used, with their real start times.
- Never invent timestamps or facts.`;

async function answerQuestion(question, passages, llm) {
  const lines = passages.map((p) => `[${Math.round(p.start)}s] ${p.text}`);
  const userMsg = [
    `Question: ${question}`,
    "",
    "Transcript excerpts:",
    ...lines,
  ].join("\n");
  const messages = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    { role: "user", content: userMsg },
  ];
  // Injected provider (local LLM) — key-free; else Groq.
  const data = llm
    ? await llm(messages, { temperature: 0.2 })
    : await (async () => {
        const res = await groqFetch(`${GROQ_BASE}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages,
          }),
        });
        if (!res.ok) throw new Error(`Chat failed (${res.status})`);
        return JSON.parse((await res.json()).choices[0].message.content);
      })();
  return {
    answer: String(data.answer || "").slice(0, 1200),
    citations: (Array.isArray(data.citations) ? data.citations : [])
      .map((c) => ({ start: Math.max(0, +c.start || 0), quote: String(c.quote || "").slice(0, 240) }))
      .slice(0, 4),
  };
}

module.exports = {
  transcribe,
  transcribeLong,
  chatJSON,
  planEdit,
  findClips,
  validateClips,
  validateEdl,
  removeFillers,
  shrinkPauses,
  detectChapters,
  repurpose,
  findHighlights,
  answerQuestion,
};
