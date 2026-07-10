// Workspace data layer: adapts the backend's reviewBlocks into "thought units",
// tracks keep/cut/lock state, and runs the client-side deterministic checks
// that power the Edit Report Card. When the M0 server engine lands, its linter
// supersedes these checks and its scores fill the strength chips — the UI
// contract here is designed to receive that without changes.

import type { Job, ReviewBlock, Segment, Chapter } from "./types";

export interface WUnit {
  id: number;
  start: number;
  end: number;
  text: string;
  words: { i: number; w: string; s?: number; e?: number }[];
  silence: boolean; // block with no words (pure gap)
  aiCut: boolean; // the AI's original decision
  flags: string[]; // "filler" | "falseStart" (heuristic, client-side)
  score?: number; // filled by the M1 engine later
  reason?: string;
}

export interface WState {
  cutWords: Set<number>; // word indices currently cut
  cutSilence: Set<number>; // silence unit ids currently cut
  locked: Set<number>; // unit ids that cannot be toggled
}

export interface CardCheck {
  label: string;
  detail: string;
  ok: boolean;
}

export interface ReportCard {
  keptPct: number;
  runtime: number; // seconds kept
  cuts: number;
  cutsPerMin: number;
  firstKeptAt: number | null;
  checks: CardCheck[];
  coverage: { title: string; kept: number; total: number }[];
  findings: { unitId: number; msg: string }[]; // per-unit flags for the transcript
}

const FILLER_RE = /\b(um+|uh+|erm|hmm)\b/i;
const FALSE_START_RE = /\b(wait,? let me|let me (say|start|redo) (that|this) again|sorry,? (let me|i'll) (start|say))/i;
// Openers that need their antecedent — only flagged when the previous unit was cut.
const ORPHAN_RE =
  /^\s*["'“”]?\s*(so that'?s why|that'?s why|as i (said|mentioned)|like i said|which is why|because of that|that'?s when|that'?s what i mean)/i;

export function toUnits(blocks: ReviewBlock[]): WUnit[] {
  return blocks.map((b, idx) => {
    const text = (b.words || []).map((w) => w.w).join(" ");
    const flags: string[] = [];
    if (FILLER_RE.test(text) && (b.words || []).length <= 8) flags.push("filler");
    if (FALSE_START_RE.test(text)) flags.push("false start");
    return {
      id: idx,
      start: b.start,
      end: b.end,
      text,
      words: b.words || [],
      silence: !(b.words || []).length,
      aiCut: b.type === "cut",
      flags,
    };
  });
}

export function initialState(units: WUnit[]): WState {
  const cutWords = new Set<number>();
  const cutSilence = new Set<number>();
  for (const u of units) {
    if (!u.aiCut) continue;
    if (u.silence) cutSilence.add(u.id);
    else for (const w of u.words) cutWords.add(w.i);
  }
  return { cutWords, cutSilence, locked: new Set() };
}

export type UnitStatus = "keep" | "cut" | "mixed";

export function unitStatus(u: WUnit, st: WState): UnitStatus {
  if (u.silence) return st.cutSilence.has(u.id) ? "cut" : "keep";
  let kept = 0;
  for (const w of u.words) if (!st.cutWords.has(w.i)) kept++;
  if (kept === 0) return "cut";
  if (kept === u.words.length) return "keep";
  return "mixed";
}

/** Runs of kept words become keep-segments (same algorithm the old review used). */
export function buildIncluded(units: WUnit[], st: WState): Segment[] {
  const segs: Segment[] = [];
  for (const u of units) {
    if (u.silence) {
      if (!st.cutSilence.has(u.id)) segs.push({ start: u.start, end: u.end });
      continue;
    }
    const ws = u.words;
    let run: { s: number; e: number } | null = null;
    const flush = () => {
      if (!run) return;
      const start =
        run.s === 0 ? u.start : ((ws[run.s - 1].e ?? u.start) + (ws[run.s].s ?? u.start)) / 2;
      const end =
        run.e === ws.length - 1
          ? u.end
          : ((ws[run.e].e ?? u.end) + (ws[run.e + 1].s ?? u.end)) / 2;
      segs.push({ start, end });
      run = null;
    };
    ws.forEach((w, idx) => {
      if (!st.cutWords.has(w.i)) {
        if (!run) run = { s: idx, e: idx };
        else run.e = idx;
      } else flush();
    });
    flush();
  }
  // merge touching segments
  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.02) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** Deterministic report card computed from the current selection. */
export function computeCard(
  units: WUnit[],
  st: WState,
  duration: number,
  chapters: Chapter[] | undefined,
): ReportCard {
  const included = buildIncluded(units, st);
  const runtime = included.reduce((s, x) => s + (x.end - x.start), 0);
  const cuts = Math.max(0, included.length - 1) + (included.length && included[0].start > 0.5 ? 1 : 0);
  const cutsPerMin = runtime > 0 ? cuts / (runtime / 60) : 0;
  const findings: { unitId: number; msg: string }[] = [];

  // Orphaned openers: kept unit matching ORPHAN_RE whose previous speech unit is fully cut.
  let orphanCount = 0;
  const speech = units.filter((u) => !u.silence);
  for (let k = 0; k < speech.length; k++) {
    const u = speech[k];
    if (unitStatus(u, st) === "cut") continue;
    if (!ORPHAN_RE.test(u.text)) continue;
    const prev = speech[k - 1];
    if (prev && unitStatus(prev, st) === "cut") {
      orphanCount++;
      findings.push({ unitId: u.id, msg: "Opens with a reference whose setup was cut" });
    }
  }

  // Sub-phrase keeps: kept segments shorter than a spoken phrase.
  const tiny = included.filter((s) => s.end - s.start < 1.2).length;

  // Boundary-in-silence: each cut boundary should sit in a word gap >= 120ms.
  let unsnapped = 0;
  const allWords = units.flatMap((u) => u.words).filter((w) => w.s != null && w.e != null);
  allWords.sort((a, b) => (a.s as number) - (b.s as number));
  const inSilence = (t: number) => {
    // t is in silence if no word strictly spans it with margin
    for (const w of allWords) {
      if ((w.s as number) < t - 0.06 && (w.e as number) > t + 0.06) return false;
      if ((w.s as number) > t + 0.06) break;
    }
    return true;
  };
  for (const s of included) {
    if (s.start > 0.1 && !inSilence(s.start)) unsnapped++;
    if (s.end < duration - 0.1 && !inSilence(s.end)) unsnapped++;
  }

  // Topic coverage per chapter.
  const coverage = (chapters || []).map((c) => {
    const inCh = speech.filter((u) => u.start >= c.start - 0.5 && u.start < c.end);
    const kept = inCh.filter((u) => unitStatus(u, st) !== "cut").length;
    return { title: c.title, kept, total: inCh.length };
  });
  const emptyChapters = coverage.filter((c) => c.total > 0 && c.kept === 0);
  for (const c of emptyChapters)
    findings.push({ unitId: -1, msg: `Topic “${c.title}” lost all its material` });

  const firstKeptAt = included.length ? included[0].start : null;

  const checks: CardCheck[] = [
    {
      label: "Orphaned references",
      detail: orphanCount === 0 ? "every kept line has its setup" : `${orphanCount} kept line(s) lost their setup`,
      ok: orphanCount === 0,
    },
    {
      label: "Cuts per minute",
      detail: `${cutsPerMin.toFixed(1)} / 12 budget`,
      ok: cutsPerMin <= 12,
    },
    {
      label: "Sub-phrase keeps",
      detail: tiny === 0 ? "none — all keeps ≥ 1.2s" : `${tiny} keep(s) shorter than a phrase`,
      ok: tiny === 0,
    },
    {
      label: "Boundaries in silence",
      detail: unsnapped === 0 ? "all cuts land in word gaps" : `${unsnapped} boundary(ies) land mid-word`,
      ok: unsnapped === 0,
    },
    {
      label: "Topic coverage",
      detail: emptyChapters.length === 0
        ? `${coverage.filter((c) => c.kept > 0).length}/${coverage.length || "—"} topics kept`
        : `${emptyChapters.length} topic(s) fully cut`,
      ok: emptyChapters.length === 0,
    },
  ];

  return {
    keptPct: duration > 0 ? Math.round((runtime / duration) * 100) : 0,
    runtime,
    cuts,
    cutsPerMin,
    firstKeptAt,
    checks,
    coverage,
    findings,
  };
}

/** Demo fixture so the workspace can be rendered & verified without a backend. */
export function demoJob(): Job {
  const mk = (i: number, s: number, words: string[], type: "keep" | "cut") => ({
    start: s,
    end: s + words.length * 0.38 + 0.3,
    type,
    words: words.map((w, k) => ({
      i: i + k,
      w,
      s: s + k * 0.38,
      e: s + k * 0.38 + 0.3,
    })),
  });
  const blocks: ReviewBlock[] = [
    mk(0, 0, "The day we almost shut down was the day we finally figured out what we were building .".split(" "), "keep"),
    mk(40, 7.2, "Welcome back to the show . Today I'm sitting down with Dev Rao , founder of Kettle .".split(" "), "keep"),
    mk(80, 13.4, "Um , so yeah , thanks for — thanks for coming on .".split(" "), "cut"),
    mk(120, 17.6, "Thanks for having me , really glad to be here .".split(" "), "cut"),
    mk(160, 22.1, "Take me back — what did the very first version actually look like ?".split(" "), "keep"),
    mk(200, 28.3, "Honestly ? It was a spreadsheet and one very stubborn group chat .".split(" "), "keep"),
    mk(240, 35.0, "Sixty people copy-pasting dinner orders by hand , every single night .".split(" "), "keep"),
    mk(280, 41.5, "So that's why we finally wrote real software .".split(" "), "keep"),
  ];
  return {
    id: "demo",
    status: "review",
    progress: 100,
    duration: 144,
    mode: "ai",
    summary: "Cut greetings and filler; kept the origin story tight.",
    reviewBlocks: blocks,
    chapters: [
      { start: 0, end: 13, title: "Cold open" },
      { start: 13, end: 40, title: "How it started" },
      { start: 40, end: 144, title: "The pivot" },
    ],
    searchReady: false,
  } as Job;
}
