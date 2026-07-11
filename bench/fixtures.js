/**
 * bench/fixtures.js — EditBench synthetic fixtures + junk injection.
 *
 * Fixtures are built at the sentence level with known ground truth (which
 * sentences are junk), then compiled to word streams with timestamps — the
 * same shape Whisper produces. Junk injection is seeded and reproducible.
 */

/* --------------------------- seeded RNG (mulberry32) ---------------------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ base fixtures ----------------------------- */

// A clean two-speaker interview across 4 chapters. Every sentence is a
// complete thought; the first is the hook, the last is the closer.
function interviewSentences() {
  return [
    { sp: "A", ch: "OPEN", hook: true, t: "The night our servers died was the night the business finally made sense." },
    { sp: "B", ch: "OPEN", t: "Welcome back to the show, today I'm joined by the founder of Brightline." },
    { sp: "B", ch: "OPEN", t: "Take me back to the very beginning of the company?" },
    { sp: "A", ch: "OPEN", t: "We started in a garage with two laptops and a whiteboard." },
    { sp: "B", ch: "GROWTH", t: "When did you know the product was actually working?" },
    { sp: "A", ch: "GROWTH", t: "A customer called us at midnight begging us not to shut down the beta." },
    { sp: "A", ch: "GROWTH", t: "We grew forty percent every month for a year after that call." },
    { sp: "A", ch: "GROWTH", t: "That's why we raised the second round so early." },
    { sp: "B", ch: "CRISIS", t: "Tell me about the outage everyone remembers?" },
    { sp: "A", ch: "CRISIS", t: "Our database melted during the biggest demo of our lives." },
    { sp: "A", ch: "CRISIS", t: "Two hundred customers watched our dashboard go blank in real time." },
    { sp: "A", ch: "CRISIS", t: "We rebuilt the whole pipeline in seventy two hours without sleeping." },
    { sp: "B", ch: "LESSONS", t: "What would you tell a founder facing their own disaster week?" },
    { sp: "A", ch: "LESSONS", t: "Ship the boring fix first and save the clever rewrite for later." },
    { sp: "A", ch: "LESSONS", t: "Your customers forgive outages but they never forgive silence." },
    { sp: "B", ch: "LESSONS", t: "Where can people find Brightline today?" },
    { sp: "A", ch: "LESSONS", closing: true, t: "We're at brightline.dev and yes, we are hiring, come build with us." },
  ];
}

// A single-speaker tutorial — different rhythm, no speaker changes.
function tutorialSentences() {
  return [
    { sp: "T", ch: "INTRO", hook: true, t: "By the end of this video you will deploy a site in under five minutes." },
    { sp: "T", ch: "INTRO", t: "You only need a terminal and a free account to follow along." },
    { sp: "T", ch: "SETUP", t: "First install the command line tool with a single command." },
    { sp: "T", ch: "SETUP", t: "Run the login command and paste the token from your dashboard." },
    { sp: "T", ch: "BUILD", t: "Create the project folder and add the starter template." },
    { sp: "T", ch: "BUILD", t: "The config file controls the build output and the routes." },
    { sp: "T", ch: "BUILD", t: "Change the title field so your site has a proper name." },
    { sp: "T", ch: "DEPLOY", t: "Now run the deploy command and watch the logs stream by." },
    { sp: "T", ch: "DEPLOY", t: "Your site is live on a real domain with a certificate already attached." },
    { sp: "T", ch: "DEPLOY", closing: true, t: "That's all for today, subscribe for the next part of the series." },
  ];
}

/* ------------------------------ junk injection ---------------------------- */

const JUNK_FILLER = [
  "Um, you know, like, honestly, yeah.",
  "So, uh, I mean, right, okay.",
  "Well, um, basically, sort of, you know.",
];
const JUNK_FALSE_START = [
  "Wait — let me redo that whole answer.",
  "Sorry, let me start over on this one.",
  "Let me say that again, scratch that.",
];

/**
 * Inject junk into a sentence list. Kinds:
 *  - filler runs      (new junk sentences)
 *  - false starts     (new junk sentences)
 *  - retakes          (near-duplicate of the FOLLOWING good sentence — the
 *                      inserted earlier copy is the junk)
 *  - dead air         (long gaps attached before a sentence; ground truth for
 *                      boundary handling, not a unit)
 * Marks junk with { junk: kind }. Returns a new list + counts.
 */
function injectJunk(sentences, seed = 1, opts = {}) {
  const R = rng(seed);
  const o = { fillers: 2, falseStarts: 2, retakes: 2, deadAirs: 2, ...opts };
  const out = sentences.map((s) => ({ ...s }));
  const counts = { filler: 0, falseStart: 0, retake: 0, deadAir: 0 };

  const insertAt = () => 1 + Math.floor(R() * (out.length - 2)); // never before hook / after closer

  for (let k = 0; k < o.fillers; k++) {
    const i = insertAt();
    out.splice(i, 0, { sp: out[i].sp, ch: out[i].ch, t: JUNK_FILLER[Math.floor(R() * JUNK_FILLER.length)], junk: "filler" });
    counts.filler++;
  }
  for (let k = 0; k < o.falseStarts; k++) {
    const i = insertAt();
    out.splice(i, 0, { sp: out[i].sp, ch: out[i].ch, t: JUNK_FALSE_START[Math.floor(R() * JUNK_FALSE_START.length)], junk: "falseStart" });
    counts.falseStart++;
  }
  for (let k = 0; k < o.retakes; k++) {
    // duplicate a good sentence, insert the duplicate right BEFORE it
    let i = insertAt();
    while (out[i].junk) i = insertAt();
    const dup = { sp: out[i].sp, ch: out[i].ch, t: out[i].t.replace(/\.$/, ", right."), junk: "retake" };
    out.splice(i, 0, dup);
    counts.retake++;
  }
  for (let k = 0; k < o.deadAirs; k++) {
    let i = insertAt();
    out[i] = { ...out[i], gapBefore: 2.5 + R() * 2 }; // seconds of dead air
    counts.deadAir++;
  }
  return { sentences: out, counts };
}

/* ----------------------------- compile to words ---------------------------- */

/**
 * Sentences → word stream with timestamps (Whisper-like). Word cadence
 * 0.30s, in-sentence spacing 0.02s, between sentences 0.9s (so the segmenter
 * has honest pause+punctuation boundaries), plus any injected dead air.
 * Returns { words, spans } where spans[i] = {start, end, meta} per sentence.
 */
function compile(sentences) {
  const words = [];
  const spans = [];
  let t = 0.5;
  for (const s of sentences) {
    if (s.gapBefore) t += s.gapBefore;
    const toks = s.t.split(/\s+/);
    const start = t;
    for (const tok of toks) {
      words.push({ w: tok, s: round3(t), e: round3(t + 0.28), speaker: s.sp });
      t += 0.3;
    }
    const end = t - 0.02;
    spans.push({ start: round3(start), end: round3(end), meta: s });
    t += 0.9; // inter-sentence pause
  }
  return { words, spans, duration: round3(t) };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Map segmenter units onto fixture sentences by time-overlap majority. */
function labelUnits(units, spans) {
  return units.map((u) => {
    let best = null;
    let bestOv = 0;
    for (const sp of spans) {
      const ov = Math.min(u.end, sp.end) - Math.max(u.start, sp.start);
      if (ov > bestOv) {
        bestOv = ov;
        best = sp;
      }
    }
    return { unit: u, meta: best ? best.meta : null };
  });
}

function buildFixture(kind, seed) {
  const base = kind === "tutorial" ? tutorialSentences() : interviewSentences();
  const { sentences, counts } = injectJunk(base, seed);
  const { words, spans, duration } = compile(sentences);
  return { kind, seed, sentences, counts, words, spans, duration };
}

module.exports = { buildFixture, interviewSentences, tutorialSentences, injectJunk, compile, labelUnits, rng };
