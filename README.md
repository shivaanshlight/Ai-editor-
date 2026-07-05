# ClipSurgeon

AI video editor — Phase 1: upload a video, get it back with all the silences and dead air surgically removed, plus a visual cut map showing exactly what was trimmed.

## Setup

You need two things installed:

1. **Node.js 18+**
2. **ffmpeg** (with ffprobe) on your PATH
   - Windows: `winget install ffmpeg` or download from ffmpeg.org and add `bin/` to PATH
   - Verify with `ffmpeg -version` and `ffprobe -version`

Then:

```bash
npm install
npm start
# open http://localhost:3000
```

For **AI edit mode**, create a file named `.env` in the project root (copy `.env.example`) containing:

```
GROQ_API_KEY=gsk_your_key_here
```

Get a fresh key at console.groq.com → API Keys. Never commit `.env` or share this key — anyone who has it can spend your quota. Restart the server after adding it; the startup log will say `AI mode: ready`.

## How it works

1. `POST /api/upload` receives the video (multer), creates a job, responds immediately with a job id.
2. ffmpeg's `silencedetect` audio filter scans the track for stretches below the threshold — no AI needed for this step.
3. The silences are inverted into "keep" segments (with a little padding so cuts don't feel abrupt).
4. A `filter_complex` script (`trim` + `atrim` + `concat`) re-encodes only the kept segments.
5. The frontend polls `GET /api/jobs/:id` for progress, then renders the cut map and offers `GET /api/download/:id`.

Jobs live in an in-memory Map — restart clears them. Fine for Phase 1.

## What's implemented

- [x] **Review before render.** The AI's plan pauses for your approval: toggle any transcript block between keep/cut, double-click words to fix caption text, then render.
- [x] **Timeline editing after render.** Preview the result in the browser, tap any segment on the timeline, nudge its start/end in 0.1 s steps or flip keep/cut, and re-render.
- [x] **Version history.** Every render is a version (v1, v2, …) — switch between them in the preview, download any of them.
- [x] **Export presets.** YouTube / Reels-Shorts / Podcast-clip chips that configure format, captions, pacing and target duration in one tap.
- [x] **Pause shrinking & filler surgery.** Long mid-sentence pauses compress to ~0.4 s; isolated "um"/"uh" are cut at word precision.
- [x] **Karaoke captions, punch-in zooms, loudness normalization, vertical 9:16, ducked music.**

### Earlier foundations

- [x] **Phase 1 — Quick silence cut.** Pure ffmpeg `silencedetect`, no API needed. (`lib/silence.js`)
- [x] **Phase 2 — Edit from a prompt.** Audio → Groq Whisper (word timestamps) → Llama 3.3 70B returns an Edit Decision List → validated, snapped to word boundaries, cut with the same `cutVideo()`. Presets: tighten, highlight reel, 60s short, or write your own instruction + target duration. (`lib/ai.js`)
- [x] **Phase 3 — Captions.** Whisper words are remapped onto the post-cut timeline, grouped into short cues, written as SRT and burned in with libass. Two styles: clean (small, bottom) and bold (shorts style). (`lib/media.js`)
- [x] **Phase 4 — Background music.** Upload any audio file: it loops for the video length, and `sidechaincompress` auto-ducks it under speech. Volume slider in the UI. (`lib/media.js`)

## How AI mode flows

```
video → extract mono 16kHz mp3 → Whisper (words + segments)
      → LLM plans keep-segments from transcript + your instruction
      → validateEdl(): clamp, sort, merge, snap to word edges   ← never trust LLM timestamps
      → cutVideo() stitches the keeps
      → finishing pass: burn SRT + mix ducked music
```

## Known limits (v1)

- Whisper input capped at ~100 min of audio (Groq 25 MB limit) — chunking is a future upgrade.
- Music must be provided by you; the app mixes, it doesn't generate.
- Jobs are in-memory: restarting the server forgets them (files in `outputs/` survive).
- Captions use word timestamps from Whisper; on very mumbly audio, timing can drift slightly.
