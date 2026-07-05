/**
 * lib/edl.js — PHASE 2 (not wired in yet, read this to understand the architecture)
 *
 * This is how every "AI video editor" (Descript, OpusClip, etc.) actually works.
 * The AI never watches pixels. The pipeline is:
 *
 *   video ──ffmpeg──▶ audio.wav ──Whisper──▶ transcript with word timestamps
 *   transcript + user's instruction ──LLM──▶ Edit Decision List (EDL, plain JSON)
 *   EDL ──ffmpeg──▶ final video   (reuse cutVideo() from silence.js — same function!)
 *
 * An EDL is just:  [{ start: 12.40, end: 48.20, action: "keep" }, ...]
 * Once you have that, Phase 1's cutVideo() already does the rest.
 *
 * TO IMPLEMENT:
 * 1. Extract audio:   ffmpeg -i in.mp4 -vn -ar 16000 -ac 1 audio.wav
 * 2. Transcribe:      Groq's whisper-large-v3 API (you already have a Groq key
 *                     from KaryaSetu/SpeakWell) with response_format:"verbose_json"
 *                     and timestamp_granularities:["word"] — free tier is generous.
 * 3. Call the LLM with the prompt below.
 * 4. Parse the JSON, feed segments into cutVideo().
 *
 * For captions: the Whisper output IS your captions. Convert to .srt and burn in:
 *   ffmpeg -i cut.mp4 -vf "subtitles=captions.srt:force_style='FontSize=24'" out.mp4
 */

const EDL_SYSTEM_PROMPT = `You are a video editor. You receive a transcript with
timestamps in the format [start-end] text, plus an editing instruction from the user.

Return ONLY a JSON object, no markdown, no explanation:
{
  "segments": [ { "start": <sec>, "end": <sec>, "reason": "<why kept>" } ],
  "summary": "<one sentence describing the edit you made>"
}

Rules:
- segments are the parts to KEEP, in playback order.
- Never invent timestamps outside the transcript range.
- Preserve sentence boundaries — never cut mid-word.
- If asked for a highlight reel, pick the most engaging/complete moments.
- If asked to "remove rambling", keep the tightest version that preserves meaning.`;

/** Example user message you'd send alongside the system prompt: */
function buildUserMessage(transcriptLines, instruction, targetDuration) {
  return [
    `Editing instruction: ${instruction}`,
    targetDuration ? `Target duration: about ${targetDuration} seconds.` : "",
    "",
    "Transcript:",
    ...transcriptLines, // e.g. "[12.40-15.88] So today I want to show you..."
  ].join("\n");
}

module.exports = { EDL_SYSTEM_PROMPT, buildUserMessage };
