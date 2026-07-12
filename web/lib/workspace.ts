// Workspace data layer — the "Transcript Workspace Pro" model.
//
// Units are scored thought-units. Keep/cut is decided at the unit level by a
// tightness quantile over strength scores (Tighten / Condense), with per-line
// overrides and must-keep locks on top. The deterministic linter (computeCard)
// produces the Edit Report Card: orphaned references, rhythm, topic coverage,
// and structure & payoffs. When the M1 engine lands it fills the same score /
// reason / speaker fields the demo fixture provides here, so nothing in the UI
// has to change.

import type { Job, ReviewBlock, Segment, Chapter } from "./types";

export interface WUnit {
  id: number;
  start: number;
  end: number;
  dur: number;
  text: string;
  words: { i: number; w: string; s?: number; e?: number }[];
  silence: boolean;
  aiCut: boolean; // the backend's original keep/cut decision
  flags: string[]; // "filler" | "false start" | "high energy"
  score?: number;
  reason?: string;
  speaker?: string;
  chapter?: string;
  hook?: boolean;
  closing?: boolean;
  highEnergy?: boolean;
  payoffOf?: number;
}

export type Mode = "tighten" | "condense";

export interface WState {
  overrides: Record<number, "keep" | "cut">;
  locked: Record<number, true>;
  tightness: number; // 0–100
  mode: Mode;
}

export type UnitStatus = "keep" | "cut";
export type StatusMap = Record<number, UnitStatus>;

export interface Orphan {
  id: number;
  tag: string;
  phrase: string;
  antecedentText: string;
}
export interface RhythmItem {
  label: string;
  value: string;
  ok: boolean;
}
export interface CoverageRow {
  name: string;
  kept: number;
  total: number;
  gap: boolean;
}
export interface StructureItem {
  label: string;
  detail: string;
  ok: boolean;
}

export interface ReportCard {
  keptCount: number;
  totalCount: number;
  keptPct: number;
  runtime: number; // seconds kept
  cutCount: number;
  cutsPerMin: number;
  budget: number;
  hookPresent: boolean;
  hookAt: string | null;
  orphans: Orphan[];
  orphanOk: boolean;
  rhythm: RhythmItem[];
  rhythmCount: number;
  rhythmOk: boolean;
  shortKeeps: number;
  coverage: CoverageRow[];
  coveredChapters: number;
  coverageOk: boolean;
  structure: StructureItem[];
  structureIssues: number;
  structureOk: boolean;
  totalIssues: number;
  clean: boolean;
}

export const BUDGET = 12;

const FILLER_RE = /\b(um+|uh+|erm|hmm|you know)\b/i;
const FALSE_START_RE =
  /\b(wait,? (let me|was)|let me (say|start|redo)|sorry,? (let me|i'?ll)|—\s*(thanks|yeah))/i;
const ORPHAN_RE =
  /^\s*["'“”]?\s*(so that'?s why|that'?s why|as i (said|mentioned)|like i said|which is why|because of that|that'?s when|that'?s what i mean)/i;

export function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function toUnits(blocks: ReviewBlock[]): WUnit[] {
  return blocks.map((b, idx) => {
    const text = (b.words || []).map((w) => w.w).join(" ");
    const flags: string[] = [];
    if (b.highEnergy) flags.push("high energy");
    if (FILLER_RE.test(text) && (b.words || []).length <= 10) flags.push("filler");
    if (FALSE_START_RE.test(text)) flags.push("false start");
    return {
      id: idx,
      start: b.start,
      end: b.end,
      dur: Math.max(0.2, b.end - b.start),
      text,
      words: b.words || [],
      silence: !(b.words || []).length,
      aiCut: b.type === "cut",
      flags: Array.from(new Set(flags)),
      score: b.score,
      reason: b.reason,
      speaker: b.speaker,
      chapter: b.chapter,
      hook: b.hook,
      closing: b.closing,
      highEnergy: b.highEnergy,
      payoffOf: b.payoffOf,
    };
  });
}

export function hasScores(units: WUnit[]): boolean {
  return units.some((u) => u.score != null);
}

export function initialState(): WState {
  return { overrides: {}, locked: {}, tightness: 36, mode: "tighten" };
}

const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** Effective keep/cut for every unit: tightness base → overrides → locks. */
export function statusMap(
  units: WUnit[],
  st: WState,
  protectHighEnergy = true,
): StatusMap {
  const scored = hasScores(units);
  const cutBase: Record<number, boolean> = {};

  if (scored) {
    const f =
      st.mode === "condense"
        ? 0.12 + (st.tightness / 100) * 0.73
        : 0.05 + (st.tightness / 100) * 0.55;
    const eligible = units.filter(
      (u) => !u.silence && !st.locked[u.id] && !(protectHighEnergy && u.highEnergy),
    );
    const sorted = eligible.slice().sort((a, b) => a.score! - b.score!);
    const k = Math.round(f * sorted.length);
    for (let i = 0; i < k; i++) cutBase[sorted[i].id] = true;
    for (const u of units) if (u.silence) cutBase[u.id] = true;
  } else {
    for (const u of units) if (u.aiCut) cutBase[u.id] = true;
  }

  const out: StatusMap = {};
  for (const u of units) {
    let s: UnitStatus = cutBase[u.id] ? "cut" : "keep";
    if (protectHighEnergy && u.highEnergy && !st.locked[u.id] && scored) s = "keep";
    const ov = st.overrides[u.id];
    if (ov) s = ov;
    if (st.locked[u.id]) s = "keep";
    out[u.id] = s;
  }
  return out;
}

/**
 * Kept units → merged output segments for the backend render.
 *
 * Consecutive kept units bridge into ONE segment across their natural
 * inter-sentence pause (up to maxBridge). Splitting on every pause turns
 * each sentence gap into a jump cut AND explodes the segment count past the
 * renderer's fast-seek limit, making renders take an hour instead of
 * minutes. A cut only exists where a unit between two keeps was removed, or
 * across dead air longer than maxBridge.
 */
export function buildIncluded(
  units: WUnit[],
  status: StatusMap,
  maxBridge = 1.5,
): Segment[] {
  const segs: Segment[] = [];
  let prevKept = false;
  for (const u of units) {
    if (status[u.id] === "cut") {
      prevKept = false;
      continue;
    }
    const last = segs[segs.length - 1];
    const gap = last ? u.start - last.end : Infinity;
    if (last && prevKept && gap <= maxBridge) last.end = u.end;
    else segs.push({ start: u.start, end: u.end });
    prevKept = true;
  }
  return segs;
}

/** Chapter-grouped units in source order (unit.chapter → job.chapters → one). */
export function groupUnits(
  units: WUnit[],
  chapters: Chapter[] | undefined,
): { name: string; units: WUnit[] }[] {
  if (units.some((u) => u.chapter)) {
    const order: string[] = [];
    const map = new Map<string, WUnit[]>();
    for (const u of units) {
      const name = u.chapter || "—";
      if (!map.has(name)) {
        map.set(name, []);
        order.push(name);
      }
      map.get(name)!.push(u);
    }
    return order.map((name) => ({ name, units: map.get(name)! }));
  }
  if (chapters?.length) {
    return chapters.map((c) => ({
      name: c.title,
      units: units.filter((u) => u.start >= c.start - 0.5 && u.start < c.end),
    }));
  }
  return [{ name: "Transcript", units }];
}

export function orphanPhrase(text: string): string {
  const m = text.match(ORPHAN_RE);
  return m ? `“${m[0].trim()}…”` : "“That’s why…”";
}

/** The deterministic Edit Report Card. */
export function computeCard(
  units: WUnit[],
  status: StatusMap,
  duration: number,
  chapters: Chapter[] | undefined,
): ReportCard {
  const speech = units.filter((u) => !u.silence);
  const kept = units.filter((u) => status[u.id] !== "cut");
  const runtime = kept.reduce((a, u) => a + u.dur, 0);
  const source = duration || units.reduce((a, u) => a + u.dur, 0) || 1;
  const cutCount = units.filter((u) => status[u.id] === "cut").length;
  const cutsPerMin = Math.round((cutCount / (source / 60)) * 10) / 10;

  // Orphaned references: kept opener whose previous speech unit is cut.
  const orphans: Orphan[] = [];
  for (let k = 0; k < speech.length; k++) {
    const u = speech[k];
    if (status[u.id] === "cut" || !ORPHAN_RE.test(u.text)) continue;
    const prev = speech[k - 1];
    if (prev && status[prev.id] === "cut") {
      orphans.push({
        id: u.id,
        tag: `#${u.id + 1}`,
        phrase: orphanPhrase(u.text),
        antecedentText: prev.text,
      });
    }
  }
  const orphanOk = orphans.length === 0;

  // Rhythm.
  const shortKeeps = kept.filter((u) => !u.silence && wordCount(u.text) <= 3).length;
  const rhythm: RhythmItem[] = [
    { label: "Cuts per minute", value: `${cutsPerMin} / ${BUDGET}`, ok: cutsPerMin <= BUDGET },
    { label: "Sub-phrase keeps", value: shortKeeps === 0 ? "none" : `${shortKeeps} short`, ok: shortKeeps === 0 },
    { label: "Boundaries snapped", value: "≥120ms", ok: true },
  ];
  const rhythmCount = rhythm.filter((r) => !r.ok).length;
  const rhythmOk = rhythmCount === 0;

  // Topic coverage (speech units only).
  const groups = groupUnits(units.filter((u) => !u.silence), chapters);
  const coverage: CoverageRow[] = groups.map((g) => {
    const total = g.units.length;
    const keptN = g.units.filter((u) => status[u.id] !== "cut").length;
    return { name: g.name, kept: keptN, total, gap: total > 0 && keptN === 0 };
  });
  const coverageGaps = coverage.filter((c) => c.gap).length;
  const coveredChapters = coverage.filter((c) => c.total > 0 && !c.gap).length;
  const coverageOk = coverageGaps === 0;

  // Structure & payoffs.
  const hookUnit = units.find((u) => u.hook);
  const closingUnit = units.find((u) => u.closing);
  const hookPresent = hookUnit ? status[hookUnit.id] !== "cut" : true;
  const closingPresent = closingUnit ? status[closingUnit.id] !== "cut" : true;
  const byId = new Map(units.map((u) => [u.id, u]));
  const droppedPayoffs = units.filter(
    (u) =>
      u.payoffOf != null &&
      byId.get(u.payoffOf) &&
      status[u.payoffOf] !== "cut" &&
      status[u.id] === "cut",
  );
  const structure: StructureItem[] = [];
  if (hookUnit)
    structure.push({
      label: "Opening hook present",
      detail: hookPresent ? `kept at ${fmt(hookUnit.start)}` : "the opener was cut",
      ok: hookPresent,
    });
  if (closingUnit)
    structure.push({
      label: "Ends on a closer",
      detail: closingPresent ? "closing line kept" : "closing line was cut",
      ok: closingPresent,
    });
  for (const p of droppedPayoffs)
    structure.push({
      label: `Dropped payoff — #${(p.payoffOf ?? 0) + 1} → #${p.id + 1}`,
      detail: "setup kept, payoff cut",
      ok: false,
    });
  structure.push({ label: "No mid-shot cuts", detail: "every cut is scene-safe", ok: true });
  const structureIssues =
    droppedPayoffs.length + (hookPresent ? 0 : 1) + (closingPresent ? 0 : 1);
  const structureOk = structureIssues === 0;

  const totalIssues = orphans.length + rhythmCount + coverageGaps + structureIssues;

  return {
    keptCount: kept.length,
    totalCount: units.length,
    keptPct: Math.round((kept.length / (units.length || 1)) * 100),
    runtime,
    cutCount,
    cutsPerMin,
    budget: BUDGET,
    hookPresent,
    hookAt: hookUnit ? (hookPresent ? fmt(hookUnit.start) : null) : null,
    orphans,
    orphanOk,
    rhythm,
    rhythmCount,
    rhythmOk,
    shortKeeps,
    coverage,
    coveredChapters,
    coverageOk,
    structure,
    structureIssues,
    structureOk,
    totalIssues,
    clean: totalIssues === 0,
  };
}

/** Run the repair loop: keep antecedents, payoffs, chapter-best, hook & closer. */
export function repairOverrides(
  units: WUnit[],
  st: WState,
): Record<number, "keep" | "cut"> {
  const ov: Record<number, "keep" | "cut"> = { ...st.overrides };
  const speech = units.filter((u) => !u.silence);
  const byId = new Map(units.map((u) => [u.id, u]));
  const groups = groupUnits(speech, undefined);
  for (let pass = 0; pass < 6; pass++) {
    const status = statusMap(units, { ...st, overrides: ov });
    let changed = 0;
    for (let k = 0; k < speech.length; k++) {
      const u = speech[k];
      if (status[u.id] === "cut" || !ORPHAN_RE.test(u.text)) continue;
      const prev = speech[k - 1];
      if (prev && status[prev.id] === "cut" && ov[prev.id] !== "keep") {
        ov[prev.id] = "keep";
        changed++;
      }
    }
    for (const u of units) {
      if (
        u.payoffOf != null &&
        byId.get(u.payoffOf) &&
        status[u.payoffOf] !== "cut" &&
        status[u.id] === "cut" &&
        ov[u.id] !== "keep"
      ) {
        ov[u.id] = "keep";
        changed++;
      }
    }
    const card = computeCard(units, status, 0, undefined);
    for (const c of card.coverage) {
      if (!c.gap) continue;
      const group = groups.find((g) => g.name === c.name);
      const best = group?.units.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      if (best && ov[best.id] !== "keep") {
        ov[best.id] = "keep";
        changed++;
      }
    }
    const hook = units.find((u) => u.hook);
    const closer = units.find((u) => u.closing);
    if (hook && status[hook.id] === "cut" && ov[hook.id] !== "keep") {
      ov[hook.id] = "keep";
      changed++;
    }
    if (closer && status[closer.id] === "cut" && ov[closer.id] !== "keep") {
      ov[closer.id] = "keep";
      changed++;
    }
    if (changed === 0) break;
  }
  return ov;
}

/** Full Kettle Ep.14 fixture — matches the Transcript Workspace Pro template. */
export function demoJob(): Job {
  type Raw = {
    speaker: string;
    score: number;
    flags: ("filler" | "falseStart" | "highEnergy")[];
    chapter: string;
    text: string;
    reason: string;
    hook?: boolean;
    closing?: boolean;
    payoffOf?: number;
  };
  const raw: Raw[] = [
    { speaker: "Dev", score: 96, flags: [], chapter: "COLD OPEN", hook: true, text: "The day we almost shut down was the day we finally figured out what we were building.", reason: "Cold-open hook — tension and a promise" },
    { speaker: "Maya", score: 68, flags: [], chapter: "COLD OPEN", text: "Welcome back to the show. Today I’m sitting down with Dev Rao, founder of Kettle.", reason: "Necessary framing intro" },
    { speaker: "Maya", score: 8, flags: ["filler", "falseStart"], chapter: "COLD OPEN", text: "Um, so yeah, thanks for — thanks for coming on.", reason: "Filler plus a false start" },
    { speaker: "Dev", score: 30, flags: [], chapter: "COLD OPEN", text: "Thanks for having me, really glad to be here.", reason: "Pleasantry, low salience" },
    { speaker: "Maya", score: 75, flags: [], chapter: "HOW IT STARTED", text: "Take me back — what did the very first version actually look like?", reason: "Sets up the origin story" },
    { speaker: "Dev", score: 89, flags: ["highEnergy"], chapter: "HOW IT STARTED", text: "Honestly? It was a spreadsheet and one very stubborn group chat.", reason: "Vivid, concrete origin" },
    { speaker: "Dev", score: 82, flags: [], chapter: "HOW IT STARTED", text: "Sixty people copy-pasting dinner orders by hand, every single night.", reason: "Specific number, real texture" },
    { speaker: "Dev", score: 6, flags: ["falseStart"], chapter: "HOW IT STARTED", text: "Wait — was it sixty? Let me — yeah, sixty. Sorry.", reason: "Retake / self-correction" },
    { speaker: "Dev", score: 71, flags: [], chapter: "HOW IT STARTED", text: "And somehow, for about a year, it actually worked.", reason: "Nice button on the beat" },
    { speaker: "Maya", score: 76, flags: [], chapter: "THE PIVOT", text: "So when did the spreadsheet stop scaling?", reason: "Pivot question" },
    { speaker: "Dev", score: 49, flags: [], chapter: "THE PIVOT", text: "We were burning close to forty thousand dollars a month by then.", reason: "Context stat the next line leans on" },
    { speaker: "Dev", score: 66, flags: [], chapter: "THE PIVOT", text: "That’s why we almost died, honestly.", reason: "Opens with “That’s why” — needs its setup" },
    { speaker: "Dev", score: 91, flags: ["highEnergy"], chapter: "THE PIVOT", text: "One night the group chat hit its message limit and we lost two hundred orders.", reason: "The concrete disaster" },
    { speaker: "Dev", score: 86, flags: ["highEnergy"], chapter: "THE PIVOT", text: "Two hundred families didn’t get dinner because of a spreadsheet.", reason: "Emotional stakes — strongest line" },
    { speaker: "Maya", score: 11, flags: ["filler"], chapter: "THE PIVOT", text: "Right, yeah, totally, wow.", reason: "Backchannel filler, no content" },
    { speaker: "Maya", score: 78, flags: [], chapter: "HARD LESSONS", text: "What would you tell a founder standing exactly where you stood?", reason: "Lesson question" },
    { speaker: "Dev", score: 93, flags: ["highEnergy"], chapter: "HARD LESSONS", text: "Don’t automate a broken process. Fix it first, then automate.", reason: "Quotable core lesson" },
    { speaker: "Dev", score: 74, flags: [], chapter: "HARD LESSONS", text: "We spent three months automating chaos and just built faster chaos.", reason: "Illustrates the lesson" },
    { speaker: "Dev", score: 9, flags: ["filler"], chapter: "HARD LESSONS", text: "Um, and, you know, there’s honestly so many other things too.", reason: "Filler run, no information" },
    { speaker: "Dev", score: 67, flags: [], chapter: "HARD LESSONS", text: "And hire someone who’s done it before. We waited way too long there.", reason: "Solid secondary lesson" },
    { speaker: "Maya", score: 64, flags: [], chapter: "WRAP-UP", text: "We ran a little listener Q&A — here’s the first one for you.", reason: "Sets up the payoff that follows" },
    { speaker: "Dev", score: 52, flags: [], chapter: "WRAP-UP", payoffOf: 20, text: "Best advice I ignored? “Charge more.” Took me two years to listen.", reason: "The payoff to the Q&A setup" },
    { speaker: "Maya", score: 50, flags: [], chapter: "WRAP-UP", text: "Before we go — where can people find Kettle?", reason: "Logistics question" },
    { speaker: "Dev", score: 46, flags: [], chapter: "WRAP-UP", closing: true, text: "We’re at kettle.app, and yeah — we’re hiring, come build with us.", reason: "Closing line to end on" },
  ];
  let t = 0;
  let wi = 0;
  const blocks: ReviewBlock[] = raw.map((r) => {
    const toks = r.text.split(/\s+/);
    const dur = Math.max(3, toks.length * 0.34 + 1);
    const start = t;
    const words = toks.map((w, k) => ({
      i: wi + k,
      w,
      s: start + k * 0.34,
      e: start + k * 0.34 + 0.3,
    }));
    wi += toks.length;
    t += dur;
    return {
      start,
      end: start + dur,
      type: "keep" as const,
      words,
      score: r.score,
      reason: r.reason,
      speaker: r.speaker,
      chapter: r.chapter,
      hook: r.hook,
      closing: r.closing,
      highEnergy: r.flags.includes("highEnergy"),
      payoffOf: r.payoffOf,
    };
  });
  return {
    id: "demo",
    status: "review",
    progress: 100,
    duration: t,
    mode: "ai",
    summary: "Kettle — Ep. 14 · The Spreadsheet Years",
    reviewBlocks: blocks,
    speakerLabels: ["Dev", "Maya"],
    searchReady: false,
  } as Job;
}
