# edit.ai — Editing Engine Architecture (Final, v2)

**From a transcript summarizer to a real editing engine.**
Scope: transcript-native long-form (podcasts, interviews, talks). Budget: ~₹20–25/video.
Status: approved design, pending build. Supersedes the v1 report; folds in the adversarial research pass.

---

## 0. The problem in one line

> The current engine only ever sees a transcript, so it edits *words* — but editing is an
> audio-visual craft. Every symptom (important parts cut, weird jarring cuts, choppy pacing)
> traces back to that gap plus four structural flaws in how the decision is made.

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
3. **Define intent, don't guess it.** Brief + must-keep locks are hard constraints.
4. **Restraint by default.** Keep when unsure; only high-confidence junk is auto-cut.
5. **See the whole.** One big-context pass for arc, opening, ending, callbacks. *(Human-Inspired Editing Framework, arXiv 2507.02790)*
6. **A second look — with external feedback.** Self-critique alone fails (see §4); a deterministic linter feeds the repair pass.
7. **Measure everything.** No prompt/rubric change ships without passing EditBench.

---

## 3. The new architecture

```
                 ┌────────────────────────────────────────────────────┐
                 │                    EDIT CONTEXT                    │
                 │  thought units · energy curve · pause map ·        │
                 │  disfluency flags · scene cuts · chapters          │
                 └────────────────────────────────────────────────────┘
                        ▲                                   │
  video ──► S0 ANALYZE ─┘                                   ▼
  user  ──► S1 INTENT & LOCKS ──► S2 SCORE & RANK ──► S3 SELECT TO BUDGET
                                   (whole-video,        (quantile threshold,
                                    rubric, ×3 runs)     hook/ending/coverage)
                                        │                       │
                                        ▼                       ▼
                              S2.5 PAIRWISE TOURNAMENT   S4 GUARDS & CUT-CRAFT
                                   (borderline band)      (breath snap, J/L,
                                        │                  rate limit, locks)
                                        └───────┬───────────────┘
                                                ▼
                                   S5 LINT → REPAIR (external feedback loop)
                                                ▼
                                   S6 HUMAN REVIEW (reasons, slider, locks)
                                                ▼
                                   S7 RENDER (existing engine, unchanged)
```

### S0 — Analyze once → build the Edit Context  `[rebuilt · local · free]`

Extract, before any LLM call:

- **Thought units** — sentence-sized complete thoughts from word timestamps (punctuation +
  pause boundaries). The atomic unit; we never cut inside one.
- **Energy curve** — per-unit loudness from ffmpeg (`astats`/`ebur128` over the extracted audio).
  High energy = emphasis/excitement; flat-low = genuine dead air.
- **Pause map** — gap before/after each unit, so *dramatic pause* ≠ *rambling pause*.
- **Disfluency flags** — filler, false starts ("wait, let me redo that"), near-duplicate retakes
  (fuzzy text match between adjacent passages).
- **Scene cuts** — ffmpeg scene-change timestamps; a cut boundary must never land mid-shot.
- **Chapters/topics** — already built.

**Why:** the brain must decide on *data, not vibes*. This is the cheap "ears" — and every
guard in S4 keys off these signals. All local, all free, cached by content hash.

**Contract:**
```json
Unit { "id", "start", "end", "text", "speaker?", "energy": 0-1,
       "pauseBefore", "pauseAfter", "flags": ["filler"|"falseStart"|"retake"],
       "chapter", "sceneSafe": true }
```

### S1 — Intent & locks  `[new]`

A 20-second brief before editing: what is this (podcast tighten / talk / tutorial / condense),
target length **or** "just tighten", tone, *what must never be cut*. In review, any segment or
topic can be **locked** — a hard constraint the engine cannot touch, ever.

**Why:** "importance" is not inferable from text. Asking + locking is the single biggest fix
for "it cut the important parts." Costs nothing; it's UI + prompt constraints.

### S2 — Score & rank every unit  `[rebuilt]`

One structure-first pass over the **whole transcript** (Gemini big-context when a key exists;
outline-then-score fallback on Groq):

1. Model outlines the video's structure (beats, arc, where the hook and payoffs live).
2. Every unit gets a 0–100 **salience score** on an explicit rubric + a one-line reason.

**Rubric (explicit, weighted, explainable):**
`+++ hook/opener · +++ payoff/punchline · ++ complete story · ++ strong claim/number ·
++ high-energy/emotional (from S0) · + Q→A pair · −− redundant/retake · −−− filler/false start ·
−− tangent/dead air`

**Calibration fixes (from the research pass):**
- **Derived confidence, never self-reported.** LLM self-confidence is decoratively
  miscalibrated (clusters at ~0.95 regardless of correctness). Instead: run the cheap scorer
  **3× at temperature** and use *agreement* (variance) as uncertainty, cross-checked against
  the deterministic S0 signals. **Disagreement ⇒ keep** (restraint).
- **Verbosity-bias correction** — length-normalize scores so long segments don't win by default.
- Scores are cached per content-hash; re-editing with a new threshold costs **zero** LLM calls.

### S2.5 — Pairwise tournament in the borderline band  `[new]`

Pointwise scores triage the easy 80%. For units within ±1 quantile-band of the threshold —
where the decision is actually contested — run **pairwise comparisons** ("which of these two
moments earns its place?") with A/B **order-swapping** (position bias) and length
normalization (verbosity bias). Aggregate wins re-rank the band.

**Why:** LLMs judge *comparisons* far more reliably than absolute scores; borderline calls are
exactly where pointwise blurs. Cost stays bounded because only the band is compared.

### S3 — Select to budget: threshold, hook, ending, coverage  `[new]`

- **Quantile threshold, not absolute score.** "Keep the top X% *of this video*" — a 62/100 in
  one video ≠ 62 in another, so an absolute slider would feel inconsistent. The gentle↔tight
  slider maps to a quantile.
- **Two modes:** *Tighten* (default — remove only high-confidence junk) vs *Condense*
  (user-set target length; drop lowest-ranked complete thoughts first).
- **Deliberate opening & ending** — pick the strongest hook for the open and a closing-type
  line for the end, as an explicit step (not a side effect).
- **Topic coverage constraint** — every chapter keeps its best moment; no topic silently vanishes.

**Why:** explicit hook/ending selection is what makes an edit feel *intentional* instead of
"fragments stitched together"; coverage kills the "it deleted a whole section" failure.

### S4 — Deterministic guards & cut-craft  `[rebuilt · the craft]`

Never trust raw LLM timestamps. Hard rules, applied deterministically:

- **Breath-aligned boundaries** — snap every cut into the nearest silence ≥ 120 ms.
- **Speech-safe J/L-cuts** — audio leads (J) or trails (L) the picture cut by ~150–300 ms **only
  when the extension is non-speech** (verified against word timestamps). Never bleed words
  from deleted content across a boundary.
- **Never cut**: locked spans, high-energy spans, laughter spans (phase 2), mid-shot (S0 scene map).
- **Cut-rate limiter** — cap cuts/minute; merge near-adjacent micro-cuts (no stutter-montage).
- **Minimum keep** — no keep-segment shorter than a spoken phrase.

**Why:** correct *selection* with wrong *cut points* still feels bad. Breath alignment + J/L
offsets are the century-old editor's tricks that make a cut read as smooth — and both are
implementable transcript-natively in the existing EDL/ffmpeg layer.

### S5 — Lint → Repair (the second look that actually works)  `[new · keystone]`

Research verdict: **intrinsic self-critique fails** — models can't reliably detect their own
errors and often degrade output on "re-read and improve" prompts. Self-correction works only
with **reliable external feedback**. So we build the feedback:

**The Edit Linter** — deterministic, local, zero-cost analyzer of (transcript + EDL) emitting
concrete findings:

| Check | Catches |
|---|---|
| **Orphaned references** | Kept segment opens with "So that's why…", "as I said…", bare pronoun whose antecedent was cut |
| **Dropped payoffs** | Kept question whose answer was cut; kept setup whose punchline is gone |
| **Coverage gaps** | A chapter that lost 100% of its material |
| **Rhythm violations** | Cuts/min over budget; keeps shorter than a phrase; boundaries not in silence |
| **Structure checks** | Hook present in first N seconds; ending is a closing-type line; no mid-shot cuts |

The **repair pass** then feeds *those specific findings* (not "does it flow?") back to the
model: "Finding: unit #41 opens with an orphaned 'that's why' — restore its antecedent or cut
#41." Targeted correction with external evidence — the one regime where a second pass provably helps.

### S6 — Human review  `[exists · upgraded]`

- Each cut shows its **reason** and derived-confidence tier.
- **Gentle↔tight slider** = the S3 quantile (re-select instantly from cached scores — no LLM call).
- **Must-keep locks**, one-go **filler review**, "restore all low-confidence cuts" button.
- **Edit report card** (linter output, user-facing): "0 orphaned references · 12/12 topics
  covered · hook at 0:04 · 9 cuts/min." Trust repair, post-bad-edit.

**Why:** the honest product target is a **trustworthy first pass + 2-minute human polish** —
autonomous perfection is not the bar anyone (Descript, Opus) clears. The review UI is the
safety net and arguably the real product.

### S7 — Render  `[exists · unchanged]`

Approved EDL → existing single-pass ffmpeg engine (decode-only-kept, HW encode, captions,
reframe, ducked music). The redesign is entirely in the decision layer.

---

## 4. Ground-up components (new builds, in priority order)

### 4.1 Edit Linter + EditBench — *the keystone, built first*

Two halves of one idea: **measurement**.

- **Linter** (runtime): the S5 external-feedback engine + the S6 report card.
- **EditBench** (dev-time): a regression harness. Fixture transcripts + **junk-injection
  tests** — splice duplicated takes, dead air, and filler runs into a known-good edit; the
  engine must remove *exactly those* and nothing else. Every prompt/rubric/threshold change
  runs the bench; a change ships only if scores don't regress.

**Why first:** (a) error *detection* is the proven bottleneck — this is the detector;
(b) it converts prompt-tuning from vibes into engineering; (c) it's pure text-in/JSON-out —
fully buildable **and provable with unit tests in the sandbox**, no video-watching needed;
(d) zero marginal cost forever.

### 4.2 Score cache & instant re-edit

Content-hash-keyed cache of S0 analysis + S2 scores (Supabase). Moving the slider or changing
target length re-runs only S3–S5 — deterministic, local, instant. Also makes the engine
resumable across restarts and rate-limit stalls.

### 4.3 Preference telemetry (the editor learns your taste)

Every review correction (restored cut, re-cut, moved boundary) is a **labeled example** of
user preference. Log them; feed the most recent as few-shot exemplars into S2 prompts
("this user restores personal stories; don't cut them"). Cheap personalization, no training.

### 4.4 Fallback ladder (graceful degradation)

`Gemini big-context → Groq outline-then-score → deterministic-only (silence+disfluency cuts)`.
The engine never hard-fails a job because a provider throttles; it downgrades and reports
which tier produced the edit.

### 4.5 Determinism & reproducibility

Scoring at temperature 0 (the ×3 consistency runs at 0.7 are separate), prompt versions
pinned and logged with each EDL, and the EDL itself stored as the artifact — the same
approved EDL always renders the same video.

---

## 5. What the research changed (v1 → v2 corrections)

| Pillar | v1 (naive) | v2 (research-corrected) |
|---|---|---|
| Confidence | Ask the model "how sure?" | **Derived**: ×3 self-consistency variance + agreement with S0 signals; disagreement ⇒ keep |
| Second look | "Re-read your edit, fix flow" | **Linter findings → targeted repair** (external feedback, the only regime that works) |
| Scoring | Pointwise 0–100 everywhere | **Triage pointwise → pairwise tournament** in the borderline band, order-swapped, length-normalized |
| Threshold | Absolute score slider | **Per-video quantile** slider |
| J/L cuts | Offset audio freely | **Speech-safe only** — extend into silence/room tone, never words |
| Rubric weights | Hand-tuned constants | **Tuned against EditBench**, versioned, regression-gated |

Key sources: [LLMs Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) ·
[DeCRIM](https://arxiv.org/html/2410.06458v1) · [When Can We Trust LLM Graders (2603.29559)](https://arxiv.org/abs/2603.29559) ·
[LLM-as-a-jury / pairwise reliability (2602.16610)](https://arxiv.org/pdf/2602.16610) ·
[RankCut (ACM IUI 2026)](https://dl.acm.org/doi/10.1145/3742413.3789115) ·
[Human-Inspired Video Editing Framework (2507.02790)](https://arxiv.org/html/2507.02790v1)

---

## 6. Cost & latency (2-hour podcast, est.)

| Stage | Compute | Cost | Notes |
|---|---|---|---|
| S0 Analyze | local ffmpeg + JS | ₹0 | minutes; cached forever |
| S2 Score ×3 | LLM, whole transcript | ~₹1–3 | Gemini Flash big-context; cached |
| S2.5 Tournament | LLM, band only | ~₹1 | bounded by band size |
| S5 Lint+Repair | local + 1 LLM call | ~₹0.5 | |
| Re-edit (slider) | local only | ₹0 | instant, from cache |
| **Total decision layer** | | **~₹3–5** | transcription (~₹19) still dominates |

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Gemini key never added | Fallback ladder tier 2 (outline-then-score on Groq) — better than today, worse than M2 |
| Rubric overfits EditBench fixtures | Diverse fixtures (podcast/tutorial/interview) + junk-injection variety; bench grows with every real-world failure you report |
| Pairwise cost blowup on long videos | Band-limited comparisons + hard call budget |
| J/L offsets sound odd on music beds | Only apply to speech-adjacent boundaries; disable when music track present |
| I can't watch renders | You are the eval loop for *feel*; EditBench is the eval loop for *logic* — every milestone ships with both |

---

## 8. Build plan (milestones with acceptance criteria)

| M | Scope | Needs | Done when |
|---|---|---|---|
| **M0** | Edit Linter + EditBench (fixtures, junk-injection, CI-style runner) | nothing | Linter unit tests pass; bench detects 100% of injected junk, flags 0 false orphans on clean fixtures |
| **M1** | S0 Edit Context · quantile ranking + slider · derived confidence · breath-snap + speech-safe J/L · cut-rate limit · lint→repair loop | nothing | EditBench score ≥ target; your test edit shows no mid-thought cuts, no orphaned openers |
| **M1.5** | Pairwise tournament in borderline band | nothing | Band re-ranking beats pointwise on bench borderline fixtures |
| **M2** | Gemini big-context, structure-first (kill chunking) | free Gemini key | Coherent long-video edits; no 413/chunk artifacts |
| **M3** | Intent brief + locks UI · filler review · report card · preference telemetry | nothing | Locked spans never cut (bench-enforced); report card renders |
| **M4** | Document-first editing (delete text = cut · drag to reorder) | nothing | Descript-parity core interaction |

**The honest goal, restated:** not autonomous perfection — a **tight, trustworthy first pass
plus a 2-minute human polish**, with every claim about "better" backed by a bench number, not a vibe.
