# Speed & Quality Playbook

Thorough survey of every lever that reduces pipeline time or improves edit
quality, grounded in this codebase and in the measured behavior on a real
Windows machine (2h+ upload, free-tier APIs). Each lever gets: what it is,
expected gain, effort, and risk. Ordered inside each section by
impact-per-effort.

---

## A. Where the time actually goes

Anatomy of a 2-hour upload, current code, typical laptop:

| Stage | What runs | Time today | Bound by |
|---|---|---|---|
| 1. Audio extract | ffmpeg → wav/mp3 | 1–3 min | disk/CPU decode |
| 2. **Transcribe** | local whisper.cpp small (or Groq free) | **10–25 min local · HOURS on Groq free** | CPU (or API quota) |
| 3. Diarize (opt) | AssemblyAI | 2–5 min | API |
| 4. S0 signals | energy + scene ffmpeg passes | 2–4 min | CPU decode |
| 5. Chapters | 1 Groq call | <1 min | API |
| 6. **S2 scoring** | 3 sequential runs × batches | 2–8 min | API latency × sequential |
| 7. **Tournament** | up to 80 sequential tiny calls | 3–8 min | API rate limit × sequential |
| 8. Decide/lint | local DP + linter | seconds | — |
| 9. **Render** | fast-seek decode + encode | 5–20 min (HW) / 20–60 (CPU x264) | encoder |

Three structural observations:

1. **Transcription and render are compute; scoring and tournament are
   latency.** Compute scales with hardware; latency scales with call COUNT.
   The call count is under our control and is currently wasteful.
2. **Stages 2 and 4 both read the source file and are independent** — they
   can run at the same time. Today they run back to back.
3. Everything downstream of scoring is already effectively free (cached
   scores, local DP, instant slider).

---

## B. Speed levers

### B1. Batch the tournament (80 calls → ~4) — biggest API win
**What:** the S2.5 tournament judges each borderline pair with its own API
call, twice (order swap): up to 80 requests, sequential. Free tiers allow
10–30 requests/min, so this stage is pure rate-limit waiting.
**Fix:** send all pairs of a pass in ONE prompt ("here are 20 numbered
pairs; return JSON array of winners"), one call per direction = 2–4 calls
total. LLMs handle batched pairwise judgments fine; order-swap and Borda
merging stay identical.
**Gain:** tournament 3–8 min → **~15–30 s**. Effort: small (prompt +
parse). Risk: low — the merge rule is unchanged, failures still degrade to
pointwise order.

### B2. Run the 3 diversified scoring passes in parallel
**What:** `scoreUnits` awaits run 1, then run 2, then run 3.
**Fix:** `Promise.all` across runs (each run's batches can also interleave).
**Gain:** scoring wall-clock ÷ ~3 when the provider allows concurrency
(Gemini paid/most tiers: yes; deep free-tier RPM limits: partial).
Effort: small. Risk: low; on 429 the ladder already degrades.

### B3. Start S0 signals during transcription
**What:** energy + scene ffmpeg passes run after transcription finishes,
though they don't need the transcript.
**Fix:** kick both off when the job starts; await them at plan time.
**Gain:** hides 2–4 min entirely. Effort: small. Risk: none.

### B4. GPU / better whisper — the transcription ceiling
Local whisper.cpp small on CPU ≈ 5–15× realtime. Options, in order:
- **Vulkan build of whisper.cpp** — works on nearly ANY GPU (NVIDIA, AMD,
  Intel iGPU). 3–10× faster than CPU. The release page ships
  `whisper-vulkan-bin-x64.zip`-style assets; the setup script can prefer it
  and fall back to CPU. Effort: small–medium (setup script + fallback).
- **CUDA build** (NVIDIA only): similar or better gains.
- **Quantized models** (`ggml-small-q5_1.bin`): ~1.5–2× faster, ~40% less
  RAM, negligible accuracy loss. One-line model swap.
- **`base` model**: ~2× faster than small; noticeably weaker on accents /
  noisy audio. Fine for drafts.
- **faster-whisper (CTranslate2, Python)**: typically 2–4× faster than
  whisper.cpp on CPU at equal accuracy AND gives true per-word timestamps
  (see Q6). Cost: a Python dependency — packaging pain for a shipped app.
  Verdict: best per-machine numbers, worst distribution story; revisit when
  packaging the desktop app.
**Gain:** 2h video: 10–25 min → **3–8 min** (Vulkan small) or ~5–12 min
(quantized CPU).

### B5. Render: confirm the hardware path is actually taken
The renderer already auto-detects `h264_nvenc` / `h264_qsv` /
`h264_videotoolbox` and only falls back to libx264. Two gaps:
- **AMD GPUs (`h264_amf`) are not in the ladder** — an AMD user silently
  drops to CPU x264. One case-statement to add.
- **No visibility**: the render log should state which encoder ran, so "it
  was slow" is diagnosable. (If your renders are slow, first question:
  which encoder did ffmpeg pick?)
**Gain:** HW vs libx264 = 5–20× on the encode portion. Effort: tiny.

### B6. Two-tier render: instant preview, one final export
Draft mode exists but is a checkbox. Better product shape: the review
screen's "Render" always produces a fast draft (HW encoder, low bitrate,
720p) in ~1–3 min for a 90-min output; "Export final" runs full quality
once at the end. Iteration cost collapses; final cost paid once.
Effort: small (wire draft as the default for re-renders). Risk: none.

### B7. Smart-cut (stream-copy + boundary re-encode) — the endgame
**What:** today every kept frame is re-encoded. Smart-cut re-encodes only
~1–2 s around each cut boundary and **stream-copies** the untouched middle
of every kept run (what LosslessCut "smart cut" and Avidemux do).
For a 90-min output with 40 cuts: re-encode ≈ 2–3 min of video, copy the
rest → **render in ~2–5 min at SOURCE quality** (no generation loss).
**Effort: high.** The re-encoded bridge segments must match the source
stream's exact codec parameters (profile/level/pixel format/timebase) for
concat to be seamless, and audio must be handled across the joins. Known
pitfalls, well-documented by the LosslessCut project. Not compatible with
burned-in captions/punch-in (those force re-encode anyway) — so it applies
to the "clean cut" path only.
**Verdict:** the single biggest render win available; schedule as its own
milestone after correctness is trusted.

### B8. Already done (for completeness)
Content-hash score cache (re-edits are zero-API) · transcript cache (same
file never transcribed twice) · segment bridging (fast-seek path restored)
· sampled scene pass · fast-seek decode of kept regions only.

**Stacked effect for a 2-hour video** (B1+B2+B3+B4-Vulkan+B6 draft):
today ~25–50 min → **~8–15 min to a reviewable draft**. Final export adds
one full-quality render.

---

## C. Quality levers

### C1. A gold fixture from YOUR footage — the highest-value hour you can spend
Label ~10 minutes of a real video (mark each line keep/cut yourself) and
check it in as an EditBench fixture. Every rubric tweak, model swap, or
prompt change is then measured against ground truth that actually looks
like your content — synthetic junk-injection can't tell you the rubric
over-cuts soft-spoken guests or under-cuts product demos. The bench
runner already supports labeled fixtures; this is data entry + one loader.
**This is the doc's M-criteria item that's still open, and it gates
honest tuning of everything below.**

### C2. Make `mergeWithNext` actually merge
The scorer already returns `mergeWithNext` for incomplete thoughts, and
the segmenter flags them — but the selector still treats such units as
independently cuttable. Merging flagged units into their successor BEFORE
selection removes a whole class of mid-thought cuts the linter currently
has to catch afterward. Effort: small (fold units in plan.js).

### C3. Neighbor context in scoring prompts
Each batch line is a bare unit. Adding the previous/next unit text (or
scoring in overlapping windows) measurably improves borderline judgments —
"That's why we almost died" scores very differently when the model can see
the setup line. Costs tokens, not calls; Gemini big-context absorbs it.
Effort: small.

### C4. Detect Q→A payoff pairs upfront
Today payoff protection relies on the linter's regex after the fact. With
diarization on, a question unit (ends with "?", speaker A) followed by
speaker B's answer is detectable deterministically at S0 — set
`payoffOf` links before selection so the DP protects the pair from the
start. Effort: small; measurable on the bench (dropped-payoff count).

### C5. Honor dramatic pauses at the boundary layer
`upgradePauses` marks post-peak pauses "dramatic", but `shrinkPauses`
(render option) and boundary snapping don't consult the pause map yet — a
protected pause can still be tightened at render. Thread the pause kinds
through so dramatic air is never compressed. Effort: small–medium.

### C6. Better word timestamps → cleaner cuts
whisper.cpp `-ml 1` word timing is approximate (token-boundary, not
acoustic). Boundary snapping inherits that error. Options: faster-whisper
(true word timestamps), WhisperX-style forced alignment, or simply the
`medium` model (better tokens ≈ better times). Directly improves the
"boundaries in silence" guarantee on real audio. Effort: bundled with B4's
choice.

### C7. Stronger model for the outline only
The outline (hook/closer/beats) steers everything but is ONE call — spend
quality there: Gemini 2.5 Pro (free tier allows a few calls/day) for the
outline, Flash for unit scoring, Flash-Lite for tournament pairs. Effort:
tiny (per-stage model param).

### C8. Let the preference telemetry compound
Already shipped — but it only learns if renders happen. Every real edit
you correct makes the next first-pass better. No action; usage note.

### C9. Language & multilingual (M5 later)
Hindi/Tamil/mixed-language footage needs the multilingual model (not
`.en`), per-language segmentation fixtures, and orphan-opener regexes per
language. Parked as M5, unchanged.

---

## D. Cost & scale (recap, unchanged)
Local whisper kills the only per-minute API cost. Scoring a 2h video on
paid Gemini Flash ≈ ₹1–5. Ladder: user's local compute → BYOK →
your paid key behind quotas. Nothing here changes the speed/quality plan.

---

## E. Recommended order

**Wave 1 — quick wins, hours of work, no risk (do now):**
B1 batched tournament · B2 parallel scoring runs · B3 signals during
transcription · B5 AMF + encoder logging · C2 mergeWithNext · C3 neighbor
context · C7 per-stage models.

**Wave 2 — setup/tooling:**
B4 Vulkan/quantized whisper in setup script · B6 draft-first rendering ·
C4 Q→A pairing · C5 dramatic-pause threading · C1 gold fixture (needs ~1
hour of YOUR labeling — the only item I can't do alone).

**Wave 3 — the big one:**
B7 smart-cut render (own milestone, biggest remaining render win).

Every wave lands behind the existing gates: 45 unit tests + 6 EditBench
targets must stay green.
