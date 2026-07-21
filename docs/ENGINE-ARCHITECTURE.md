# edit.ai — Editing Engine Architecture (Final, v3)

**From a transcript summarizer to a real editing engine.**
Scope: transcript-native long-form (podcasts, interviews, talks). Budget: ~₹20–25/video.
Status: final design. v3 folds in four review passes: two research passes, one external
evaluation (8/10), and a stage-seam engineering pass. Changelog in the Appendix.

---

## 0. The problem in one line

> The current engine only ever sees a transcript, so it edits *words* — but editing is an
> audio-visual craft. Every symptom (important parts cut, weird jarring cuts, choppy pacing)
> traces back to that gap plus the structural flaws below.

---

## 1. Current architecture (kept short)

```
Upload → Whisper → chunk transcript → LLM per chunk → merge → filler/pause → render
         (words)   (token limit)      ("cut 25-50%")   (snap)   (micro-cuts)  (ffmpeg)
```

Six structural flaws — not bugs, design flaws:

| # | Flaw | Consequence |
|---|------|-------------|
| 1 | **Blind** — text only, no audio/visual signal | Dramatic pauses & emotional beats read as "dead air → cut" |
| 2 | **Chunked** — never sees the whole video | No arc, no callbacks, incoherent long-form edits |
| 3 | **Binary** — keep/cut, no ranking | No aggressiveness control; all-or-nothing judgment |
| 4 | **Aggressive by prompt** — "be decisive, remove 25–50%" | Confident destruction of good material |
| 5 | **One greedy pass** — no second look | Dropped payoffs, flow breaks never caught |
| 6 | **Intent-blind** — guesses what matters | The model's idea of "important" ≠ yours |

The **render layer is not the problem** (single-pass ffmpeg, decode-only-kept, HW encode,
captions/reframe/music). It stays.

---

## 2. Design principles (research-grounded)

1. **Rank, don't delete.** Score every moment; aggressiveness becomes a threshold you slide. *(RankCut, ACM IUI 2026)*
2. **Give it senses.** Free local audio energy + pause semantics so emphasis ≠ dead air.
3. **Define intent, don't guess it.** Brief + must-keep locks — enforced **in code**, never by prompt alone.
4. **Restraint by default.** Keep when unsure; only high-confidence junk is auto-cut. Parser gaps and model disagreement also default to keep.
5. **See the whole.** One big-context pass for arc, opening, ending, callbacks. *(Human-Inspired Editing Framework, arXiv 2507.02790)*
6. **A second look — with external feedback.** Self-critique alone fails; a deterministic linter feeds the repair pass, and repairs are re-linted.
7. **Deterministic wherever possible.** The LLM supplies *scores*; segmentation, selection, guards, and linting are exact, tested machinery.
8. **Measure everything.** No prompt/rubric change ships without passing EditBench.

---

## 3. The new architecture

```
                 ┌────────────────────────────────────────────────────┐
                 │                    EDIT CONTEXT                    │
                 │  thought units · energy (per-speaker) · pause map  │
                 │  disfluency flags · scene map · SNR · chapters     │
                 └────────────────────────────────────────────────────┘
                        ▲                                   │
  video ──► S0 ANALYZE ─┘                                   ▼
  user  ──► S1 INTENT & LOCKS ──► S2 SCORE & RANK ──► S3 SELECT (DP optimizer)
                                   (whole-video in,     salience − λ·cuts,
                                    batched out, ×3      s.t. locks · coverage ·
                                    diversified runs)    duration · craft rules
                                        │                       │
                                        ▼                       ▼
                              S2.5 PAIRWISE TOURNAMENT   S4 BOUNDARY CRAFT
                                   (borderline band)      (breath snap, speech-
                                        │                  safe J/L offsets)
                                        └───────┬───────────────┘
                                                ▼
                                   S5 LINT → REPAIR → RE-LINT (fixpoint, ≤2)
                                                ▼
                                   S6 HUMAN REVIEW (reasons, slider, locks, undo)
                                                ▼
                                   S7 RENDER (existing engine, unchanged)
```

### S0 — Analyze once → build the Edit Context  `[rebuilt · local · free]`

Extract, before any LLM call:

- **Thought units** — sentence-sized complete thoughts from word timestamps (punctuation +
  pause boundaries). The atomic unit; we never cut inside one. Segmentation is a **single
  point of failure**, so it gets its own EditBench fixtures (accuracy measured separately),
  and the S2 scorer may return a `mergeWithNext` flag for units it judges incomplete.
- **Energy curve, normalized per speaker** — per-unit loudness from ffmpeg (`astats`/`ebur128`),
  **z-scored within each speaker** (keyed on diarization). Raw loudness is confounded by mic
  gain/distance — global normalization would systematically flag a soft-spoken guest as
  "low energy" and over-cut one side of an interview.
- **Pause map with semantics** — gap before/after each unit, classified deterministically:
  a pause **after a high-salience or high-energy unit** is *dramatic* (protected); a pause
  adjacent to a disfluency or an incomplete unit is *rambling* (compressible); otherwise neutral.
- **Disfluency flags** — filler, false starts ("wait, let me redo that"), near-duplicate retakes
  (fuzzy text match between adjacent passages).
- **Scene map (multicam-aware)** — ffmpeg scene-change timestamps. Cut boundaries *prefer*
  shot changes but this is a **soft preference, not a hard rule**: multicam podcasts auto-switch
  cameras every few seconds, and a hard "never mid-shot" rule becomes unsatisfiable. Detect the
  multicam signature (frequent, regular scene changes) and relax accordingly.
- **Audio-quality (SNR)** — per-unit signal-to-noise / RMS. Flag noisy/distorted/very-low
  units `lowQuality` — surfaced to the user (not auto-cut), never chosen as the hook.
- **Chapters/topics** — already built.

**Why:** the brain must decide on *data, not vibes*. This is the cheap "ears" — and every
constraint in S3/S4 keys off these signals. All local, all free, cached by content hash.

**Contract:**
```json
Unit { "id", "start", "end", "text", "speaker?", "energy": 0-1, "snr": 0-1,
       "pauseBefore": {"s": 1.2, "kind": "dramatic|rambling|neutral"},
       "pauseAfter":  {"s": 0.3, "kind": "neutral"},
       "flags": ["filler"|"falseStart"|"retake"|"lowQuality"|"mergeWithNext"],
       "chapter", "shotBoundaryNear": true }
```

### S1 — Intent & locks  `[new]`

A 20-second brief before editing: what is this (podcast tighten / talk / tutorial / condense),
target length **or** "just tighten", tone, *what must never be cut*. In review, any segment or
topic can be **locked**.

**Enforcement is in code, not prompt.** Locks are hard constraints applied by the S3 optimizer
and re-asserted after every stage that can modify the EDL — the model is *told* about them as an
optimization, but a model that ignores the instruction changes nothing. (v2 said "UI + prompt
constraints," which contradicted "hard"; v3 fixes that.)

**Why:** "importance" is not inferable from text. Asking + locking is the single biggest fix
for "it cut the important parts."

### S2 — Score & rank every unit  `[rebuilt]`

Structure-first pass over the **whole transcript** (Gemini big-context when a key exists;
outline-then-score fallback on Groq):

1. Model outlines the video's structure (beats, arc, where the hook and payoffs live).
2. Every unit gets a 0–100 **salience score** on an explicit rubric + a one-line reason.

**Output at scale — batched, reconciled** *(v3)*: a 2-hour podcast is **1,500–2,500 units**;
one call emitting thousands of scored JSON objects hits output-token limits, long-output
degradation, and **ID drift** (silent misalignment after a skipped unit). So: whole-transcript
*input* every time, but **output batched ~100–150 units per call** as compact `[id, score]`
pairs, deterministically reconciled against the unit list. **Any unit missing from a response
⇒ keep** — restraint applies to parser gaps too.

**Rubric (explicit, weighted, explainable):**
`+++ hook/opener · +++ payoff/punchline · ++ complete story · ++ strong claim/number ·
++ high-energy/emotional (from S0) · + Q→A pair · −− redundant/retake · −−− filler/false start ·
−− tangent/dead air`

**Calibration fixes:**
- **Derived confidence, never self-reported.** LLM self-confidence is decoratively
  miscalibrated (clusters at ~0.95 regardless of correctness). Run the scorer **3× in
  parallel** and use *agreement* as confidence — but **diversify the runs** *(v3)*: same-model,
  same-prompt samples are correlated and agree for the same wrong reasons. Use a paraphrased
  rubric per run and/or one run on a second model (Gemini + Groq). **Disagreement ⇒ keep.**
- **Verbosity-bias correction** — length-normalize scores so long segments don't win by default.
- Scores are cached per content-hash; re-editing with a new threshold costs **zero** LLM calls.

### S2.5 — Pairwise tournament in the borderline band  `[new]`

Pointwise scores triage the easy 80%. For units within ±1 quantile-band of the threshold —
where the decision is actually contested — run **pairwise comparisons** ("which of these two
moments earns its place?") with A/B **order-swapping** (position bias) and length
normalization (verbosity bias). **Merge rule** *(v3)*: each unit's band-local **win rate**
re-ranks it within the band (simple Borda count — no Elo machinery needed at this scale).

**Why:** LLMs judge *comparisons* far more reliably than absolute scores; borderline calls are
exactly where pointwise blurs. Cost stays bounded because only the band is compared.

### S3 — Select: one deterministic optimizer  `[new · replaces threshold + separate rate-limiter]`

v2 selected by threshold (S3) and then rate-limited cuts (S4) — two stages that **fight**:
threshold selection ignores adjacency (keep 5, 7, 9 / cut 6, 8 = stutter), then the limiter
"merges micro-cuts," silently re-including low-ranked material or dropping high-ranked keeps.

**v3 unifies selection into a single exact optimization** — the standard formulation in video
summarization research (0/1-knapsack solved by dynamic programming; see sources):

> **Choose the kept set that maximizes Σ salience − λ·(number of cuts)**, subject to:
> locks (always in) · topic coverage (each chapter keeps its best unit) · target duration
> (Condense mode) or quantile budget (Tighten mode) · minimum-keep length · deliberate
> hook and ending.

- The **per-cut penalty λ** makes contiguity emerge naturally — each extra cut must pay for
  itself — replacing the ad-hoc rate limiter.
- **Known knapsack pitfall, designed around** *(v3)*: naive knapsack over-selects short
  segments (they pack better). We already length-normalize salience at S2 and set a
  minimum-keep length; the cut penalty further favors coherent runs over confetti.
- **Ordering stays chronological.** One deliberate exception: an optional **Cold Open** —
  lift the single strongest hook to the front as a teaser (the workspace design shows this).
  No other reordering in v3; free-form reordering is the M4 document-editing feature.
- Deterministic and local ⇒ the gentle↔tight slider re-runs S3 **instantly** from cached
  scores, and the UI shows the **effective kept %** (locks + coverage make it differ from the
  slider's nominal %).

### S4 — Boundary craft  `[rebuilt · the craft]`

With selection unified into S3, S4 owns only *where exactly* each cut lands:

- **Breath-aligned boundaries** — snap every cut into the nearest silence ≥ 120 ms.
- **Speech-safe J/L-cuts** — audio leads (J) or trails (L) the picture cut by ~150–300 ms **only
  when the extension is non-speech** (verified against word timestamps). Never bleed words
  from deleted content across a boundary.
- **Shot-boundary preference** — snap toward a nearby scene change when one exists (soft, per S0).
- **Protected spans re-asserted** — locked, high-energy, and dramatic-pause spans are
  re-checked here; any violation is corrected deterministically.

**Why:** correct *selection* with wrong *cut points* still feels bad. Breath alignment + J/L
offsets are the century-old editor's tricks that make a cut read as smooth — implementable
transcript-natively in the existing EDL/ffmpeg layer.

### S5 — Lint → Repair → Re-lint (the second look that actually works)  `[new · keystone]`

Research verdict: **intrinsic self-critique fails** — models can't reliably detect their own
errors. Self-correction works only with **reliable external feedback**. So we build the feedback:

**The Edit Linter** — deterministic, local, zero-cost analyzer of (transcript + EDL):

| Check | Catches |
|---|---|
| **Orphaned references** | Kept segment opens with "So that's why…", "as I said…", bare pronoun whose antecedent was cut |
| **Dropped payoffs** | Kept question whose answer was cut; kept setup whose punchline is gone |
| **Coverage gaps** | A chapter that lost 100% of its material |
| **Rhythm violations** | Cuts/min excessive; keeps shorter than a phrase; boundaries not in silence |
| **Structure checks** | Hook present in first N seconds; ending is a closing-type line |

**Flag first, repair only when safe.** Findings are *always* surfaced in the review UI —
the linter's value is detection; auto-repair can hallucinate. Automated repair runs **only**
for trivial, high-agreement cases, and is **monotone** (restore or extend only — never new
cuts) so it cannot oscillate. **Every repair is re-linted** *(v3)* — a fix can introduce a new
violation — looping lint → repair → re-lint to a fixpoint, max 2 iterations, then hand
remaining findings to the human.

### S6 — Human review  `[exists · upgraded]`

- Each cut shows its **reason** and derived-confidence tier.
- **Gentle↔tight slider** = the S3 budget (instant, local re-optimize; shows effective kept %).
- **Must-keep locks**, one-go **filler review**, "restore all low-confidence cuts" button.
- **Decision-layer undo** — snapshot slider/locks/manual flips per session; revert to any
  prior decision state or to "the AI's original plan."
- **Edit report card** (linter output, user-facing): "0 orphaned references · 12/12 topics
  covered · hook at 0:04 · 2.1 cuts/min."

**Why:** the honest product target is a **trustworthy first pass + 2-minute human polish** —
autonomous perfection is not the bar anyone (Descript, Opus) clears. The review UI is the
safety net and arguably the real product.

### S7 — Render  `[exists · unchanged]`

Approved EDL → existing single-pass ffmpeg engine (decode-only-kept, HW encode, captions,
reframe, ducked music). The redesign is entirely in the decision layer.

---

## 4. Ground-up components (new builds, in priority order)

### 4.1 The Deterministic Core — *the keystone, built first*  *(expanded in v3)*

Everything in the engine **except the LLM scoring calls** is deterministic text-in/JSON-out —
buildable and provable with unit tests, no API key, no video-watching:

| Piece | Stage | Proof |
|---|---|---|
| **Segmenter** | S0 (text half) | segmentation fixtures: known transcripts → expected unit boundaries |
| **DP Selector** | S3 | mocked scores → optimal set verified against brute force on small fixtures |
| **Boundary craft** | S4 | word-timestamp fixtures → cuts land in silence, J/L never covers speech |
| **Edit Linter** | S5/S6 | injected violations detected 100%, clean fixtures flag 0 |
| **EditBench** | dev-time | the harness that runs all of the above + junk-injection end-to-end |

**EditBench composite score** *(defined in v3 — M-criteria referenced it, v2 never defined it)*:
- **Junk recall** — % of injected junk (dupes, dead air, filler runs) removed
- **False-cut rate** — % of known-good units incorrectly cut
- **Linter violations** — count on the final EDL (weighted by severity)
- **Runtime deviation** — |actual − target| in Condense mode
- Plus **one human-labeled gold fixture**: ~10 min of a real video labeled once by the user —
  the reality check synthetic injection can't provide.

When the LLM is plugged in later it supplies *only* scores — every other moving part is
already tested machinery.

### 4.2 Score cache & instant re-edit

Content-hash-keyed cache of S0 analysis + S2 scores (Supabase). Slider moves and target
changes re-run only S3–S5 — deterministic, local, instant. Also makes the engine resumable
across restarts and rate-limit stalls.

### 4.3 Preference telemetry (the editor learns your taste)

Every review correction (restored cut, re-cut, moved boundary) is a **labeled example** of
user preference. Log them; feed the most recent as few-shot exemplars into S2 prompts
("this user restores personal stories; don't cut them"). Cheap personalization, no training.

### 4.4 Fallback ladder (graceful degradation)

`Gemini big-context → Groq outline-then-score → deterministic-only (silence+disfluency cuts)`.
The engine never hard-fails a job because a provider throttles; it downgrades and reports
which tier produced the edit.

### 4.5 Determinism & reproducibility

Scoring at temperature 0 (the diversified consistency runs are separate), prompt versions
pinned and logged with each EDL, and the EDL itself stored as the artifact — the same
approved EDL always renders the same video.

### 4.6 Decision-layer history (undo for *decisions*, not just renders)

Snapshot the user-modified EDL + locks + threshold per edit session as simple JSON so a user
can step back to a previous decision state (Ctrl+Z at the edit level, and "revert to the AI's
original plan"). Cheap, local, high-trust.

### 4.7 Multi-language (Phase 2)

English-only today (Whisper). The Indian market needs Hindi, Tamil, and more. Only the
**transcription model** changes (multilingual/Indic Whisper); S0's audio signals and the
deterministic core are **language-agnostic**. The rubric prompts get localized examples, and
the segmenter's punctuation heuristics need per-language fixtures (segmentation is the one
piece where language quality bites — see 4.1).

---

## 5. What review changed (v1 → v2 → v3)

| Pillar | v1 (naive) | v2 (research-corrected) | v3 (seam-corrected) |
|---|---|---|---|
| Confidence | Ask the model | ×3 self-consistency + S0 agreement | **Diversified runs** (paraphrase/second model) — same-model samples are correlated |
| Second look | "Re-read and fix" | Linter findings → targeted repair | **Re-lint after repair** (fixpoint ≤2), monotone repairs only |
| Scoring | Pointwise 0–100 | + pairwise tournament in band | **Batched output + reconciliation** (missing ⇒ keep); Borda merge rule |
| Selection | Binary keep/cut | Quantile threshold + separate rate limiter | **One DP optimizer** (salience − λ·cuts, constrained) — threshold & limiter unified |
| Locks | — | "UI + prompt constraints" | **Enforced in code**, re-asserted after every EDL-modifying stage |
| Energy | — | Global loudness | **Per-speaker normalized** (mic-gain confound) |
| Scene rule | — | "Never cut mid-shot" (hard) | **Soft preference**, multicam-aware |
| Pauses | — | "dramatic ≠ rambling" (asserted) | **Classified deterministically** (post-salience ⇒ dramatic, etc.) |
| Ordering | — | — | **Chronological + optional Cold Open**; free reorder deferred to M4 |
| Bench | — | Junk injection, 100%/0 criteria | **Composite metric defined** + human-labeled gold fixture + segmentation fixtures |

Key sources: [LLMs Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) ·
[DeCRIM](https://arxiv.org/html/2410.06458v1) · [When Can We Trust LLM Graders (2603.29559)](https://arxiv.org/abs/2603.29559) ·
[LLM-as-a-jury / pairwise reliability (2602.16610)](https://arxiv.org/pdf/2602.16610) ·
[RankCut (ACM IUI 2026)](https://dl.acm.org/doi/10.1145/3742413.3789115) ·
[Human-Inspired Video Editing Framework (2507.02790)](https://arxiv.org/html/2507.02790v1) ·
Knapsack/DP selection is the standard in video summarization — [overview](https://www.sciencedirect.com/topics/computer-science/video-summarization) ·
[Rethinking Video-Summary Evaluation (1903.11328)](https://arxiv.org/pdf/1903.11328) ·
[ElasticPlay: dynamic time budgets (1708.06858)](https://arxiv.org/pdf/1708.06858)

---

## 6. Cost & latency (2-hour podcast, est.)

| Stage | Compute | Cost | Notes |
|---|---|---|---|
| S0 Analyze | local ffmpeg + JS | ₹0 | minutes; cached forever |
| S2 Score (3 diversified runs, batched) | LLM | ~₹1–3 | parallel; cached by content hash |
| S2.5 Tournament | LLM, band only | ~₹1 | bounded by band size |
| S5 Lint+Repair | local + ≤1 LLM call | ~₹0.5 | |
| S3 re-select (slider) | local DP | ₹0 | instant, from cache |
| **Total decision layer** | | **~₹3–5** | transcription (~₹19) still dominates |

**Latency:** scoring runs fire in **parallel**, so the decision layer costs roughly one
big-context call. Target < ~1 min on a 2-hour video; slider moves are instant.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Gemini key never added | Fallback ladder tier 2 (outline-then-score on Groq) — better than today, worse than M2 |
| Segmentation errors poison everything downstream | Own bench fixtures; `mergeWithNext` escape hatch; per-language fixtures at M5 |
| Rubric overfits EditBench fixtures | Diverse fixtures + junk variety + the human-labeled gold fixture; bench grows with every real failure |
| Knapsack short-segment bias | Length-normalized salience + min-keep + per-cut penalty |
| Pairwise cost blowup on long videos | Band-limited comparisons + hard call budget |
| J/L offsets sound odd on music beds | Speech-adjacent boundaries only; disabled when a music track is present |
| I can't watch renders | You are the eval loop for *feel*; EditBench is the eval loop for *logic* — every milestone ships with both |

---

## 8. Build plan (milestones with acceptance criteria)

| M | Scope | Needs | Done when |
|---|---|---|---|
| **M0** | **Deterministic core**: Segmenter · DP Selector · Boundary craft · Edit Linter · EditBench (fixtures, junk-injection, composite score, runner) | nothing | All unit tests pass; junk recall 100% / false-cut 0 on fixtures; DP matches brute force on small cases; segmentation fixtures pass |
| **M1** | S0 audio signals (energy/SNR/pauses/scene) · S2 scoring with batched output + diversified runs · lint→repair→re-lint loop wired | nothing | EditBench composite ≥ target; your test edit shows no mid-thought cuts, no orphaned openers |
| **M1.5** | Pairwise tournament in borderline band | nothing | Band re-ranking beats pointwise on bench borderline fixtures |
| **M2** | Gemini big-context, structure-first (kill chunking) | free Gemini key | Coherent long-video edits; no 413/chunk artifacts |
| **M3** | Intent brief + locks UI · filler review · report card · preference telemetry · decision-layer undo · Cold Open toggle | nothing | Locked spans never cut (bench-enforced); report card renders; revert works |
| **M4** | Document-first editing (delete text = cut · drag to reorder) | nothing | Descript-parity core interaction |
| **M5** | Multi-language — Indic/multilingual Whisper swap + per-language segmentation fixtures | multilingual STT | Hindi/Tamil transcript → same core works end-to-end |

**The honest goal, restated:** not autonomous perfection — a **tight, trustworthy first pass
plus a 2-minute human polish**, with every claim about "better" backed by a bench number, not a vibe.

---

## Appendix — review history

- **External evaluation (8/10, "legit, build it")** — adopted: parallel scoring, SNR flags,
  flag-don't-auto-repair, decision-layer undo, multi-language phase. Rejected: a
  *BERTScore(kept, original)* "coherence gate" — a tight edit is *meant* to diverge from the
  original, so source-similarity is the wrong signal; coherence is measured by the linter.
- **Seam-engineering pass (v3)** — found: S2 output-scale/ID-drift (→ batched output +
  missing-⇒-keep reconciliation), soft-locks contradiction (→ code enforcement), correlated
  consistency runs (→ diversified runs), S3/S4 conflict (→ unified DP optimizer, verified as
  the standard knapsack/DP formulation in video-summarization literature, with its
  short-segment bias designed around), mic-gain energy confound (→ per-speaker z-score),
  multicam scene-rule failure (→ soft preference), unspecified pause semantics (→ deterministic
  classification), segmentation as untested SPOF (→ own fixtures + `mergeWithNext`),
  repair-without-re-lint (→ fixpoint ≤2, monotone), undefined bench score (→ composite metric),
  cold-open/reordering ambiguity (→ chronological + optional Cold Open), and effective-kept-%
  display.
