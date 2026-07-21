"use client";
// Transcript Workspace — the review screen, built to the "Transcript Workspace
// Pro" template. Left: a video-preview strip tied to the transcript, with
// chapter-grouped thought-units (strength score, reason, speaker avatar, flag
// tags, keep/cut, must-keep lock). Right: the deterministic Edit Report Card
// (orphaned refs, rhythm, topic coverage, structure & payoffs, one-click
// Repair). A floating Tighten/Condense bar drives a live tightness quantile.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Job, Segment } from "@/lib/types";
import { sourceUrl } from "@/lib/api";
import {
  type WUnit,
  type WState,
  type Mode,
  fmt,
  toUnits,
  hasScores,
  initialState,
  statusMap,
  buildIncluded,
  groupUnits,
  computeCard,
  repairOverrides,
  repairableCount,
} from "@/lib/workspace";

/* ---------------------------------- icons --------------------------------- */
type IconName =
  | "export" | "check" | "lock" | "unlock" | "info" | "link" | "pulse"
  | "flag" | "play" | "pause" | "sparkle" | "reset" | "scan" | "coverage"
  | "frame" | "check-c" | "warn-c";

function Icon({ name, size = 18, sw = 1.7, fill = false }: {
  name: IconName; size?: number; sw?: number; fill?: boolean;
}) {
  const P = (d: string, k: number) => <path key={k} d={d} />;
  const C = (cx: number, cy: number, r: number, k: number) => (
    <circle key={k} cx={cx} cy={cy} r={r} />
  );
  let kids: React.ReactNode[] = [];
  switch (name) {
    case "export": kids = [P("M12 3v11", 1), P("M8 7l4-4 4 4", 2), P("M4 14v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3", 3)]; break;
    case "check": kids = [P("M20 6.5L9.2 17.3 4 12.1", 1)]; break;
    case "lock": kids = [<rect key={1} x={5} y={10.5} width={14} height={10} rx={2} />, P("M8 10.5V7.4a4 4 0 0 1 8 0v3.1", 2)]; break;
    case "unlock": kids = [<rect key={1} x={5} y={10.5} width={14} height={10} rx={2} />, P("M8 10.5V7.4a4 4 0 0 1 7.4-1.6", 2)]; break;
    case "info": kids = [C(12, 12, 9, 1), P("M12 11.5v5", 2), P("M12 8h.01", 3)]; break;
    case "link": kids = [P("M9.2 14.8l5.6-5.6", 1), P("M10.8 6.6l1.4-1.4a3.6 3.6 0 0 1 5.1 5.1l-1.4 1.4", 2), P("M13.2 17.4l-1.4 1.4a3.6 3.6 0 0 1-5.1-5.1l1.4-1.4", 3)]; break;
    case "pulse": kids = [P("M3 12h3.4l2-6 3.6 12 2-6H21", 1)]; break;
    case "flag": kids = [P("M6 21V4", 1), P("M6 4.5h11l-2.4 3.4L17 11.5H6", 2)]; break;
    case "play": kids = [P("M8 5.5v13l11-6.5z", 1)]; break;
    case "pause": kids = [<rect key={1} x={7} y={5} width={3.3} height={14} rx={1} />, <rect key={2} x={13.7} y={5} width={3.3} height={14} rx={1} />]; break;
    case "sparkle": kids = [P("M12 3.4l1.7 5.1 5.1 1.7-5.1 1.7L12 17l-1.7-5.1L5.2 10.2l5.1-1.7z", 1)]; break;
    case "reset": kids = [P("M4.5 12a7.5 7.5 0 1 0 2.1-5.2", 1), P("M4 4.5V9h4.5", 2)]; break;
    case "scan": kids = [P("M4 8V6a2 2 0 0 1 2-2h2", 1), P("M16 4h2a2 2 0 0 1 2 2v2", 2), P("M20 16v2a2 2 0 0 1-2 2h-2", 3), P("M8 20H6a2 2 0 0 1-2-2v-2", 4), P("M4 12h16", 5)]; break;
    case "coverage": kids = [P("M4 6h16", 1), P("M4 12h11", 2), P("M4 18h7", 3)]; break;
    case "frame": kids = [C(12, 12, 8, 1), <path key={2} d="M10.5 9.5v5l4-2.5z" fill="currentColor" stroke="none" />]; break;
    case "check-c": kids = [C(12, 12, 9, 1), P("M8.5 12.2l2.4 2.4 4.6-4.8", 2)]; break;
    case "warn-c": kids = [C(12, 12, 9, 1), P("M12 8v4.5", 2), P("M12 15.6h.01", 3)]; break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"} strokeWidth={sw} strokeLinecap="round"
      strokeLinejoin="round" style={{ display: "block", flex: "0 0 auto" }}>
      {kids}
    </svg>
  );
}

/* --------------------------------- helpers -------------------------------- */
const SPK_GRADS = [
  "linear-gradient(135deg,#4C8DFF,#8B7CFF)",
  "linear-gradient(135deg,#38DDF6,#4C8DFF)",
  "linear-gradient(135deg,#8B7CFF,#38DDF6)",
];
function scoreStyle(score: number | undefined, isCut: boolean): CSSProperties {
  let bg = "var(--chip)", col = "var(--txt-2)";
  if (score != null) {
    if (score >= 75) { bg = "var(--accent-soft)"; col = "var(--accent)"; }
    else if (score >= 50) { bg = "var(--chip)"; col = "var(--txt-2)"; }
    else if (score >= 30) { bg = "var(--warn-soft)"; col = "var(--warn)"; }
    else { bg = "var(--bad-soft)"; col = "var(--bad)"; }
  }
  return {
    display: "inline-flex", alignItems: "center", fontSize: "10.5px", fontWeight: 700,
    fontFamily: "var(--mono)", padding: "1px 7px", borderRadius: "6px",
    background: bg, color: col, opacity: isCut ? 0.6 : 1, cursor: "help",
  };
}
const tagStyle = (label: string): CSSProperties => {
  const he = label === "high energy";
  return {
    fontSize: "9.5px", fontWeight: 700, letterSpacing: ".02em", padding: "2px 7px",
    borderRadius: "999px", border: "1px solid var(--hair)",
    background: he ? "var(--accent-soft)" : "var(--chip)",
    color: he ? "var(--accent)" : "var(--txt-3)",
  };
};

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "10px",
      fontWeight: 700, padding: "3px 9px", borderRadius: "999px",
      background: ok ? "var(--good-soft)" : "var(--bad-soft)",
      color: ok ? "var(--good)" : "var(--bad)",
    }}>{children}</span>
  );
}
const cardStyle = (ok: boolean): CSSProperties => ({
  borderRadius: "14px", padding: "13px 14px", background: "var(--panel-2)",
  border: "1px solid " + (ok ? "var(--hair)" : "var(--bad-soft)"),
});
const miniBtn = (enabled: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "6px 11px",
  borderRadius: 9,
  border: "1px solid var(--hair)",
  background: "var(--chip)",
  color: enabled ? "var(--txt-2)" : "var(--txt-3)",
  fontFamily: "inherit",
  fontWeight: 700,
  fontSize: 11.5,
  cursor: enabled ? "pointer" : "not-allowed",
  whiteSpace: "nowrap",
  opacity: enabled ? 1 : 0.5,
});

const iconWrap = (ok: boolean): CSSProperties => ({
  width: "34px", height: "34px", flex: "0 0 auto", borderRadius: "10px",
  display: "flex", alignItems: "center", justifyContent: "center",
  background: ok ? "var(--good-soft)" : "var(--bad-soft)",
  color: ok ? "var(--good)" : "var(--bad)",
});

/* ================================ component ================================ */
export default function Workspace({
  job,
  onRender,
}: {
  job: Job;
  onRender: (
    included: Segment[],
    wordEdits: Record<number, string>,
    speakerNames?: Record<string, string>,
    coldOpen?: boolean,
  ) => void;
}) {
  const isDemo = job.id === "demo";
  const units = useMemo(() => toUnits(job.reviewBlocks || []), [job.reviewBlocks]);
  const scored = useMemo(() => hasScores(units), [units]);

  const [st, setSt] = useState<WState>(() => initialState());
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [coldOpen, setColdOpen] = useState(false);
  const [focused, setFocused] = useState<number | null>(null); // keyboard-review cursor (unit id)
  const [phrase, setPhrase] = useState(""); // "cut this phrase everywhere" query
  // Decision-layer undo: every decision mutation snapshots the previous state.
  const histRef = useRef<WState[]>([]);
  const [histLen, setHistLen] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"track" | "scrub" | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setSt(initialState());
    setCurrentTime(0);
    histRef.current = [];
    setHistLen(0);
  }, [units]);

  /** Snapshot + apply a decision mutation (undoable). */
  const applyDecision = (next: WState | ((s: WState) => WState)) => {
    setSt((cur) => {
      histRef.current.push({
        overrides: { ...cur.overrides },
        locked: { ...cur.locked },
        tightness: cur.tightness,
        mode: cur.mode,
      });
      if (histRef.current.length > 50) histRef.current.shift();
      setHistLen(histRef.current.length);
      return typeof next === "function" ? next(cur) : next;
    });
  };
  const undo = () => {
    const prev = histRef.current.pop();
    if (prev) {
      setHistLen(histRef.current.length);
      setSt(prev);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = useMemo(() => statusMap(units, st), [units, st]);
  const card = useMemo(
    () => computeCard(units, status, job.duration, job.chapters),
    [units, status, job.duration, job.chapters],
  );
  const included = useMemo(() => buildIncluded(units, status), [units, status]);
  const groups = useMemo(() => groupUnits(units, job.chapters), [units, job.chapters]);
  const source = job.duration || units.reduce((a, u) => a + u.dur, 0) || 1;
  const findingByUnit = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of card.orphans) m.set(o.id, "opens with a reference whose setup was cut");
    return m;
  }, [card.orphans]);

  const speakerColor = useMemo(() => {
    const names = Array.from(new Set(units.map((u) => u.speaker).filter(Boolean))) as string[];
    const map: Record<string, string> = {};
    names.forEach((n, i) => (map[n] = i % 2 === 0 ? "var(--accent-2)" : "var(--accent)"));
    return map;
  }, [units]);
  const speakerGrad = useMemo(() => {
    const names = Array.from(new Set(units.map((u) => u.speaker).filter(Boolean))) as string[];
    const map: Record<string, string> = {};
    names.forEach((n, i) => (map[n] = SPK_GRADS[i % SPK_GRADS.length]));
    return map;
  }, [units]);

  /* -------- playback / scrub -------- */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (dragRef.current === "track") trackFromX(e.clientX);
      else if (dragRef.current === "scrub") scrubFromX(e.clientX);
    };
    const up = () => (dragRef.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (playTimer.current) clearInterval(playTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrubFromX = (x: number) => {
    const el = scrubRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (x - r.left) / r.width));
    seek(f * source);
  };
  const trackFromX = (x: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (x - r.left) / r.width));
    setSt((s) => ({ ...s, tightness: Math.round(f * 100) }));
  };
  const seek = (t: number) => {
    setCurrentTime(t);
    if (!isDemo && videoRef.current) {
      try { videoRef.current.currentTime = t; } catch {}
    }
  };
  const togglePlay = () => {
    if (!isDemo && videoRef.current) {
      const v = videoRef.current;
      if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
      return;
    }
    if (playing) {
      if (playTimer.current) clearInterval(playTimer.current);
      setPlaying(false);
      return;
    }
    setPlaying(true);
    playTimer.current = setInterval(() => {
      setCurrentTime((t) => {
        const nt = t + 0.4;
        if (nt >= source) { if (playTimer.current) clearInterval(playTimer.current); setPlaying(false); return source; }
        return nt;
      });
    }, 200);
  };
  useEffect(() => {
    const v = videoRef.current;
    if (!v || isDemo) return;
    const on = () => setCurrentTime(v.currentTime);
    v.addEventListener("timeupdate", on);
    return () => v.removeEventListener("timeupdate", on);
  }, [isDemo]);

  const activeUnit = useMemo(() => {
    let a: WUnit | undefined = units[0];
    for (const u of units) if (currentTime >= u.start) a = u;
    return a;
  }, [units, currentTime]);

  /* -------- edits -------- */
  const toggleKeep = (u: WUnit, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (st.locked[u.id]) return;
    const next: "keep" | "cut" = status[u.id] === "keep" ? "cut" : "keep";
    applyDecision((s) => ({ ...s, overrides: { ...s.overrides, [u.id]: next } }));
  };
  const toggleLock = (u: WUnit, e?: React.MouseEvent) => {
    e?.stopPropagation();
    applyDecision((s) => {
      const locked = { ...s.locked };
      if (locked[u.id]) delete locked[u.id];
      else locked[u.id] = true;
      return { ...s, locked };
    });
  };
  const reset = () => applyDecision((s) => ({ ...s, overrides: {}, locked: {} }));
  // One-go filler review: cut every disfluency-flagged unit that isn't locked.
  const sweepFillers = () => {
    const targets = units.filter(
      (u) => u.flags.some((f) => ["filler", "false start"].includes(f)) && !st.locked[u.id],
    );
    if (!targets.length) {
      setToast("No filler-flagged lines to sweep.");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 2600);
      return;
    }
    applyDecision((s) => {
      const overrides = { ...s.overrides };
      for (const u of targets) overrides[u.id] = "cut";
      return { ...s, overrides };
    });
    setToast(`Swept ${targets.length} filler line${targets.length === 1 ? "" : "s"} — Undo to revert.`);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };
  // Cut this phrase EVERYWHERE: cut every unkept-locked line whose text contains
  // the phrase, in one go (e.g. remove every "you know" aside across the video).
  const cutPhrase = () => {
    const q = phrase.trim().toLowerCase();
    if (!q) return;
    const targets = units.filter(
      (u) => !st.locked[u.id] && status[u.id] !== "cut" && (u.text || "").toLowerCase().includes(q),
    );
    const flash = (msg: string) => {
      setToast(msg);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3200);
    };
    if (!targets.length) return flash(`No kept lines contain “${phrase}”.`);
    applyDecision((s) => {
      const overrides = { ...s.overrides };
      for (const u of targets) overrides[u.id] = "cut";
      return { ...s, overrides };
    });
    flash(`Cut ${targets.length} line${targets.length === 1 ? "" : "s"} containing “${phrase}” — Undo to revert.`);
  };
  const runRepair = () => {
    // Honest accounting: count what the repair ACTUALLY restores, and say so.
    const restored = repairableCount(units, st);
    const ov = repairOverrides(units, st);
    applyDecision((s) => ({ ...s, overrides: ov }));
    const msg =
      restored > 0
        ? `Repair restored ${restored} line${restored === 1 ? "" : "s"}.`
        : "Nothing auto-fixable — the remaining findings need your judgment.";
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  };
  const render = () =>
    onRender(included, {}, job.speakerNames || undefined, coldOpen || undefined);

  // Keyboard review: j/k (or ↓/↑) move the cursor, x cuts/keeps, l locks, space
  // previews. Editors who live on the keyboard can review a whole video fast.
  const scrollToUnit = (id: number) => {
    if (typeof document !== "undefined")
      document.getElementById(`wu-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") return; // handled elsewhere
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const idx = focused == null ? -1 : units.findIndex((u) => u.id === focused);
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const n = units[Math.min(units.length - 1, idx + 1)];
        if (n) { setFocused(n.id); scrollToUnit(n.id); }
      } else if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = units[Math.max(0, idx < 0 ? 0 : idx - 1)];
        if (n) { setFocused(n.id); scrollToUnit(n.id); }
      } else if (k === "x" && focused != null) {
        e.preventDefault();
        const u = units.find((x) => x.id === focused);
        if (u) toggleKeep(u);
      } else if (k === "l" && focused != null) {
        e.preventDefault();
        const u = units.find((x) => x.id === focused);
        if (u) toggleLock(u);
      } else if (k === " " && focused != null) {
        e.preventDefault();
        const u = units.find((x) => x.id === focused);
        if (u) seek(u.start);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, focused, status, st]);

  // Findings split into auto-fixable vs judgment-only; the repair button
  // must never promise fixes it cannot make.
  const fixable = useMemo(
    () => (card.clean ? 0 : repairableCount(units, st)),
    [units, st, card.clean],
  );

  /* --------------------------------- view --------------------------------- */
  const keepQuantilePct = Math.round((card.keptCount / (units.length || 1)) * 100);
  const prog = Math.max(0, Math.min(1, currentTime / source));

  return (
    <div className="tw-root animate-fade-up" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* header */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 14, padding: "2px 4px 14px",
      }}>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {job.summary || "Review your edit"}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--txt-3)", fontWeight: 500 }}>
            rough cut · transcript-native
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "0 0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 13px", borderRadius: 999, background: "var(--chip)", border: "1px solid var(--hair)" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--txt-2)" }}>{card.keptCount}/{card.totalCount} kept</span>
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--txt-3)" }} />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent)", fontFamily: "var(--mono)" }}>{fmt(card.runtime)}</span>
          </div>
          <button onClick={render} disabled={!included.length} style={{
            display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 18px",
            border: "none", borderRadius: 10, cursor: included.length ? "pointer" : "not-allowed",
            fontFamily: "inherit", fontWeight: 700, fontSize: 13.5, color: "#fff",
            background: "var(--grad)", boxShadow: "0 2px 14px var(--glow-color)", opacity: included.length ? 1 : 0.5,
          }}>
            <Icon name="export" size={16} /> {isDemo ? "Export" : "Render video"}
          </button>
        </div>
      </header>

      {/* body */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 356px", gap: 16, alignItems: "start" }} className="tw-body">
        {/* transcript column */}
        <main style={{
          display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--panel-2)",
          border: "1px solid var(--hair)", overflow: "hidden", minWidth: 0,
          height: "calc(100vh - 200px)", minHeight: 560,
        }}>
          {/* video preview strip */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", background: "var(--bg-elev)", borderBottom: "1px solid var(--hair)" }}>
            <div style={{ position: "relative", width: 104, height: 59, flex: "0 0 auto", borderRadius: 9, overflow: "hidden", border: "1px solid var(--hair-2)", background: "radial-gradient(120% 120% at 30% 20%, #1b2740, #0a1120)" }}>
              {!isDemo ? (
                <video ref={videoRef} src={sourceUrl(job.id)} playsInline preload="metadata"
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <>
                  <div style={{ position: "absolute", inset: 0, background: "var(--grad)", opacity: 0.14 }} />
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,.9)" }}>
                    <Icon name="frame" size={22} />
                  </div>
                </>
              )}
              <div style={{ position: "absolute", left: 7, top: 6, fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", color: "rgba(255,255,255,.7)", fontFamily: "var(--mono)" }}>CAM A</div>
              <div style={{ position: "absolute", right: 7, bottom: 6, fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,.85)", fontFamily: "var(--mono)" }}>{fmt(currentTime)}</div>
            </div>
            <button onClick={togglePlay} title="Play / pause" style={{ width: 40, height: 40, flex: "0 0 auto", borderRadius: 11, border: "1px solid var(--hair-2)", background: "var(--chip)", color: "var(--txt)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name={playing ? "pause" : "play"} size={18} fill />
            </button>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {activeUnit?.speaker && (
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase", color: speakerColor[activeUnit.speaker] || "var(--txt-3)", flex: "0 0 auto" }}>{activeUnit.speaker}</span>
                )}
                <span style={{ fontSize: 12, color: "var(--txt-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {activeUnit ? activeUnit.text : "Click a line to preview it."}
                </span>
              </div>
              <div ref={scrubRef} onPointerDown={(e) => { dragRef.current = "scrub"; scrubFromX(e.clientX); }}
                style={{ position: "relative", height: 16, display: "flex", alignItems: "center", cursor: "pointer", touchAction: "none" }}>
                <div style={{ position: "absolute", left: 0, right: 0, height: 4, borderRadius: 999, background: "var(--hair)", overflow: "hidden" }}>
                  <div style={{ width: `${prog * 100}%`, height: "100%", background: "var(--grad)", borderRadius: 999 }} />
                </div>
                {groups.map((g, i) => {
                  const u = g.units[0];
                  if (!u) return null;
                  const p = (u.start / source) * 100;
                  return <div key={i} style={{ position: "absolute", left: `${p}%`, width: 2, height: 10, background: "var(--hair-2)", borderRadius: 1, transform: "translateX(-1px)", pointerEvents: "none" }} />;
                })}
                <div style={{ position: "absolute", left: `calc(${prog * 100}% - 6px)`, width: 12, height: 12, borderRadius: "50%", background: "#fff", border: "2px solid var(--accent-2)", boxShadow: "0 1px 4px rgba(0,0,0,.4)", pointerEvents: "none" }} />
              </div>
            </div>
            <div style={{ flex: "0 0 auto", fontSize: 11.5, fontFamily: "var(--mono)", color: "var(--txt-3)" }}>{fmt(currentTime)} / {fmt(source)}</div>
          </div>

          {/* transcript header */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", borderBottom: "1px solid var(--hair)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".02em" }}>Transcript</span>
              <span style={{ fontSize: 11, color: "var(--txt-3)" }}>click a line to preview · check to keep or cut</span>
            </div>
            {scored && (
              <div title="Strength runs 0–100. Higher = a stronger moment; low scores are safe to cut." style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--txt-2)" }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: "var(--accent)" }} />Strength <Icon name="info" size={13} />
              </div>
            )}
          </div>

          {/* text tools: cut a phrase everywhere + keyboard-review hint */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", borderBottom: "1px solid var(--hair)", flexWrap: "wrap" }}>
            <input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") cutPhrase(); }}
              placeholder="Cut a phrase everywhere… e.g. “you know”"
              style={{ flex: "1 1 220px", minWidth: 150, maxWidth: 320, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--hair-2)", background: "var(--chip)", color: "var(--txt)", fontSize: 12.5, fontFamily: "inherit" }}
            />
            <button onClick={cutPhrase} disabled={!phrase.trim()} style={miniBtn(!!phrase.trim())}>Cut everywhere</button>
            <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--txt-3)", whiteSpace: "nowrap" }}>
              ⌨ <b style={{ color: "var(--txt-2)" }}>j/k</b> move · <b style={{ color: "var(--txt-2)" }}>x</b> cut · <b style={{ color: "var(--txt-2)" }}>l</b> lock
            </span>
          </div>

          {/* transcript scroll */}
          <div className="tw-scroll" style={{ flex: 1, overflowY: "auto", padding: "6px 12px 20px" }}>
            {groups.map((g) => {
              const kept = g.units.filter((u) => status[u.id] !== "cut").length;
              const gap = g.units.length > 0 && kept === 0;
              return (
                <div key={g.name} style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 8px 8px" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".13em", color: "var(--txt-2)", whiteSpace: "nowrap" }}>{g.name}</span>
                    <div style={{ flex: 1, height: 1, background: "var(--hair)" }} />
                    {gap && (
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "var(--bad)", padding: "2px 8px", borderRadius: 999, background: "var(--bad-soft)" }}>emptied</span>
                    )}
                    <span style={{ fontSize: 11, fontWeight: 600, fontFamily: "var(--mono)", color: gap ? "var(--bad)" : "var(--txt-3)", whiteSpace: "nowrap" }}>{kept}/{g.units.length} kept</span>
                  </div>
                  {g.units.map((u) => {
                    const isCut = status[u.id] === "cut";
                    const isKept = !isCut;
                    const locked = !!st.locked[u.id];
                    const active = activeUnit?.id === u.id;
                    const finding = findingByUnit.get(u.id);
                    return (
                      <div key={u.id} id={`wu-${u.id}`} className="tw-row" tabIndex={0}
                        onClick={() => { setFocused(u.id); seek(u.start); }} style={{
                        position: "relative", display: "flex", gap: 12, padding: "10px 12px 10px 14px",
                        borderRadius: 12, cursor: "pointer", alignItems: "flex-start", marginBottom: 1,
                        opacity: isCut ? 0.42 : 1, transform: isCut ? "scale(0.988)" : "scale(1)",
                        transformOrigin: "left center",
                        background: focused === u.id ? "var(--accent-soft)" : active ? "var(--accent-soft)" : "transparent",
                        boxShadow: focused === u.id ? "inset 0 0 0 1.5px var(--accent)" : "none",
                        transition: "opacity .18s ease, transform .18s cubic-bezier(.2,.8,.2,1), background .15s ease",
                      }}>
                        <div style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 999, background: active ? "var(--grad)" : "transparent" }} />
                        <div style={{ flex: "0 0 auto", width: 74, display: "flex", flexDirection: "column", alignItems: "center", gap: 7, paddingTop: 1 }}>
                          <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--txt-3)" }}>{fmt(u.start)}</span>
                          {u.speaker && (
                            <div style={{ width: 24, height: 24, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#fff", background: speakerGrad[u.speaker] || SPK_GRADS[0] }}>{u.speaker[0]}</div>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
                            {u.speaker && <span style={{ fontSize: 11.5, fontWeight: 700, color: speakerColor[u.speaker] || "var(--txt-2)" }}>{u.speaker}</span>}
                            {u.score != null && <span style={scoreStyle(u.score, isCut)} title={`Strength ${u.score}/100 · higher = stronger moment`}>{u.score}</span>}
                            {u.flags.map((f) => <span key={f} style={tagStyle(f)}>{f}</span>)}
                          </div>
                          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, fontWeight: isCut ? 400 : 450, color: isCut ? "var(--txt-3)" : "var(--txt)", textDecoration: isCut ? "line-through" : "none" }}>
                            {u.silence ? <em style={{ color: "var(--txt-3)" }}>(silence · {u.dur.toFixed(1)}s)</em> : u.text}
                          </p>
                          {(u.reason || finding) && (
                            <div style={{ fontSize: 11.5, color: finding ? "var(--bad)" : "var(--txt-3)", marginTop: 4, fontStyle: "italic" }}>
                              — {finding || u.reason}
                            </div>
                          )}
                        </div>
                        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, paddingTop: 2 }}>
                          <button className="tw-lock" onClick={(e) => toggleLock(u, e)} title={locked ? "Locked — click to unlock" : "Lock as must-keep"} style={{
                            width: 26, height: 26, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                            border: "1px solid " + (locked ? "var(--accent-line)" : "var(--hair)"), background: locked ? "var(--accent-soft)" : "transparent",
                            color: locked ? "var(--accent)" : "var(--txt-3)", opacity: locked ? 1 : 0, transition: "opacity .12s ease",
                          }}>
                            <Icon name={locked ? "lock" : "unlock"} size={14} />
                          </button>
                          <button onClick={(e) => toggleKeep(u, e)} aria-pressed={isKept} title={isKept ? "Kept — click to cut" : "Cut — click to keep"} style={{
                            width: 26, height: 26, borderRadius: 8, cursor: locked ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                            border: "1.5px solid " + (isKept ? "transparent" : "var(--hair-2)"), background: isKept ? "var(--grad)" : "transparent",
                            color: isKept ? "#fff" : "var(--txt-3)", opacity: locked ? 0.5 : 1,
                          }}>
                            {isKept && <Icon name="check" size={15} sw={2.4} />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* floating tightness bar */}
          {scored && (
            <div style={{ flex: "0 0 auto", display: "flex", justifyContent: "center", padding: "0 14px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 14, rowGap: 10, maxWidth: "100%", padding: "10px 14px 10px 12px", borderRadius: 16, background: "var(--panel)", border: "1px solid var(--hair-2)", boxShadow: "0 18px 50px rgba(0,0,0,.4)", backdropFilter: "blur(26px) saturate(150%)", WebkitBackdropFilter: "blur(26px) saturate(150%)" }}>
                <div style={{ display: "flex", background: "var(--chip)", borderRadius: 11, padding: 3, gap: 2, border: "1px solid var(--hair)" }}>
                  {(["tighten", "condense"] as Mode[]).map((m) => {
                    const on = st.mode === m;
                    return (
                      <button key={m} onClick={() => applyDecision((s) => ({ ...s, mode: m }))} style={{
                        padding: "6px 14px", border: "none", borderRadius: 8, fontFamily: "inherit", fontWeight: 700,
                        fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
                        background: on ? "var(--grad)" : "transparent", color: on ? "#fff" : "var(--txt-2)",
                        boxShadow: on ? "0 2px 10px var(--glow-color)" : "none", textTransform: "capitalize",
                      }}>{m}</button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 220px", minWidth: 180, maxWidth: 320 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".11em", textTransform: "uppercase", color: "var(--txt-3)" }}>keep top {keepQuantilePct}%</span>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--accent)" }}>{card.cutCount} cuts · {card.cutsPerMin}/min</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--txt-3)", flex: "0 0 auto" }}>Gentle</span>
                    <div ref={trackRef} onPointerDown={(e) => {
                      // snapshot once per drag so one slider gesture = one undo step
                      histRef.current.push({ overrides: { ...st.overrides }, locked: { ...st.locked }, tightness: st.tightness, mode: st.mode });
                      if (histRef.current.length > 50) histRef.current.shift();
                      setHistLen(histRef.current.length);
                      dragRef.current = "track";
                      trackFromX(e.clientX);
                    }}
                      style={{ position: "relative", flex: 1, height: 20, display: "flex", alignItems: "center", cursor: "pointer", touchAction: "none" }}>
                      <div style={{ position: "absolute", left: 0, right: 0, height: 5, borderRadius: 999, background: "var(--hair)" }} />
                      <div style={{ position: "absolute", left: 0, width: `${st.tightness}%`, height: 5, borderRadius: 999, background: "var(--grad)", boxShadow: "0 0 10px var(--glow-color)", pointerEvents: "none" }} />
                      <div style={{ position: "absolute", left: `calc(${st.tightness}% - 9px)`, width: 18, height: 18, borderRadius: 999, background: "#fff", border: "2px solid var(--accent-2)", boxShadow: "0 2px 6px rgba(0,0,0,.35)", pointerEvents: "none" }} />
                    </div>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--txt-3)", flex: "0 0 auto" }}>Tight</span>
                  </div>
                </div>
                {/* M3 controls: undo · filler sweep · cold open */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, borderLeft: "1px solid var(--hair)", paddingLeft: 12 }}>
                  <button onClick={undo} disabled={histLen === 0} title="Undo (Ctrl+Z)" style={miniBtn(histLen > 0)}>
                    <Icon name="reset" size={13} /> Undo
                  </button>
                  <button onClick={sweepFillers} title="Cut every filler-flagged line in one go" style={miniBtn(true)}>
                    Sweep fillers
                  </button>
                  {units.some((u) => u.hook) && (
                    <button
                      onClick={() => setColdOpen((v) => !v)}
                      title="Open the export with the hook as a teaser, then play chronologically"
                      style={{
                        ...miniBtn(true),
                        background: coldOpen ? "var(--grad)" : "var(--chip)",
                        color: coldOpen ? "#fff" : "var(--txt-2)",
                        boxShadow: coldOpen ? "0 2px 10px var(--glow-color)" : "none",
                      }}
                    >
                      Cold open {coldOpen ? "on" : "off"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* non-scored render bar */}
          {!scored && (
            <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderTop: "1px solid var(--hair)", background: "var(--bg-elev)" }}>
              <span style={{ fontSize: 12.5, fontFamily: "var(--mono)", color: "var(--txt-2)" }}>
                keeping <b style={{ color: "var(--txt)" }}>{fmt(card.runtime)}</b> of {fmt(source)} · {card.cutCount} cuts · {card.cutsPerMin}/min
              </span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button onClick={undo} disabled={histLen === 0} className="btn btn-sm">Undo</button>
                <button onClick={sweepFillers} className="btn btn-sm">Sweep fillers</button>
                <button onClick={reset} className="btn btn-sm">Reset to AI plan</button>
              </span>
            </div>
          )}
        </main>

        {/* report card rail */}
        <aside style={{
          display: "flex", flexDirection: "column", borderRadius: 18, background: "var(--panel)",
          backdropFilter: "blur(22px) saturate(140%)", WebkitBackdropFilter: "blur(22px) saturate(140%)",
          border: "1px solid var(--hair)", boxShadow: "0 24px 60px rgba(0,0,0,.28)", overflow: "hidden",
          height: "calc(100vh - 200px)", minHeight: 560,
        }}>
          <div style={{ flex: "0 0 auto", padding: "16px 18px 14px", borderBottom: "1px solid var(--hair)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--hair)" }}>
                  <Icon name="scan" size={15} />
                </div>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>Edit Report Card</span>
              </div>
              <Pill ok={card.clean}><Icon name={card.clean ? "check-c" : "warn-c"} size={13} />{card.clean ? "All clear" : `${card.totalIssues} issue${card.totalIssues === 1 ? "" : "s"}`}</Pill>
            </div>
          </div>

          <div className="tw-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {/* server-engine linter findings — the engine's own second look,
                shown verbatim when the backend ran the M1+ pipeline */}
            {(job.engineFindings?.length ?? 0) > 0 && (
              <div style={cardStyle(false)}>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <div style={iconWrap(false)}><Icon name="scan" size={17} /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>Engine findings</span>
                      <Pill ok={false}>{job.engineFindings!.length} open</Pill>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--txt-3)", marginTop: 2 }}>left for your judgment by the server linter</div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}>
                  {job.engineFindings!.map((f, i) => (
                    <div key={i} style={{ padding: "9px 11px", borderRadius: 10, background: f.severity >= 3 ? "var(--bad-soft)" : "var(--warn-soft)", border: "1px solid var(--hair)" }}>
                      <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--txt-2)" }}>
                        <b style={{ color: f.severity >= 3 ? "var(--bad)" : "var(--warn)" }}>{f.rule}</b> — {f.msg}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* stat tiles */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              <Tile value={`${card.keptPct}%`} label="material kept" />
              <Tile value={fmt(card.runtime)} label="runtime" color="var(--accent)" />
              <Tile value={card.hookPresent ? card.hookAt || "0:00" : "cut"} label="opening hook" color={card.hookPresent ? "var(--good)" : "var(--bad)"} icon={<Icon name={card.hookPresent ? "check-c" : "warn-c"} size={15} />} />
              <Tile value={String(card.cutsPerMin)} label="cuts / min" color={card.cutsPerMin > card.budget ? "var(--bad)" : "var(--txt)"} />
            </div>

            {/* orphaned refs */}
            <div style={cardStyle(card.orphanOk)}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <div style={iconWrap(card.orphanOk)}><Icon name="link" size={18} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>Orphaned references</span>
                    <Pill ok={card.orphanOk}>{card.orphanOk ? "clean" : `${card.orphans.length} found`}</Pill>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt-3)", marginTop: 2 }}>{card.orphanOk ? "every kept line has its setup" : "kept lines missing their setup"}</div>
                </div>
              </div>
              {card.orphans.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}>
                  {card.orphans.map((o) => (
                    <div key={o.id} style={{ padding: "9px 11px", borderRadius: 10, background: "var(--bad-soft)", border: "1px solid var(--hair)" }}>
                      <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--txt-2)" }}>Kept <b style={{ color: "var(--bad)" }}>{o.tag}</b> opens with <b style={{ color: "var(--bad)" }}>{o.phrase}</b> — setup was cut.</div>
                      <div style={{ fontSize: 10.5, color: "var(--txt-3)", marginTop: 3, fontStyle: "italic" }}>missing: “{o.antecedentText}”</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* rhythm */}
            <div style={cardStyle(card.rhythmOk)}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <div style={iconWrap(card.rhythmOk)}><Icon name="pulse" size={18} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>Rhythm violations</span>
                    <Pill ok={card.rhythmOk}>{card.rhythmOk ? "in budget" : `${card.rhythmCount} issue${card.rhythmCount === 1 ? "" : "s"}`}</Pill>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt-3)", marginTop: 2 }}>cadence &amp; pacing</div>
                </div>
              </div>
              <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 8 }}>
                {card.rhythm.map((r) => (
                  <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span style={{ color: r.ok ? "var(--good)" : "var(--bad)", display: "flex", flex: "0 0 auto" }}><Icon name={r.ok ? "check-c" : "warn-c"} size={15} /></span>
                    <span style={{ flex: 1, fontSize: 11.5, color: "var(--txt-2)" }}>{r.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)", color: r.ok ? "var(--good)" : "var(--bad)", whiteSpace: "nowrap" }}>{r.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* coverage */}
            <div style={{ borderRadius: 14, padding: 14, background: "var(--panel-2)", border: "1px solid var(--hair)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <div style={iconWrap(card.coverageOk)}><Icon name="coverage" size={17} /></div>
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>Topic coverage</span>
                </div>
                <Pill ok={card.coverageOk}>{card.coveredChapters}/{card.coverage.length}</Pill>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {card.coverage.map((c) => {
                  const ratio = c.total ? c.kept / c.total : 0;
                  return (
                    <div key={c.name}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 11.5, color: "var(--txt-2)", fontWeight: 500 }}>{c.name}</span>
                        <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: c.gap ? "var(--bad)" : "var(--txt-2)" }}>{c.kept}/{c.total}</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 999, background: "var(--hair)", overflow: "hidden" }}>
                        <div style={{ width: `${ratio * 100}%`, height: "100%", borderRadius: 999, background: c.gap ? "var(--bad)" : "var(--grad)" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* structure */}
            <div style={cardStyle(card.structureOk)}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <div style={iconWrap(card.structureOk)}><Icon name="flag" size={17} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>Structure &amp; payoffs</span>
                    <Pill ok={card.structureOk}>{card.structureOk ? "clean" : `${card.structureIssues} issue${card.structureIssues === 1 ? "" : "s"}`}</Pill>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt-3)", marginTop: 2 }}>hook · closer · payoffs</div>
                </div>
              </div>
              <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 9 }}>
                {card.structure.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                    <span style={{ color: s.ok ? "var(--good)" : "var(--bad)", display: "flex", flex: "0 0 auto", marginTop: 1 }}><Icon name={s.ok ? "check-c" : "warn-c"} size={16} /></span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--txt)" }}>{s.label}</div>
                      <div style={{ fontSize: 10.5, color: "var(--txt-3)", marginTop: 1 }}>{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* repair footer */}
          <div style={{ flex: "0 0 auto", padding: "13px 14px", borderTop: "1px solid var(--hair)", background: "var(--bg-elev)" }}>
            <button onClick={runRepair} disabled={card.clean || fixable === 0} style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: 44,
              borderRadius: 12, border: "none", fontFamily: "inherit", fontWeight: 700, fontSize: 13,
              cursor: card.clean || fixable === 0 ? "default" : "pointer",
              color: card.clean || fixable === 0 ? "var(--txt-3)" : "#fff",
              background: card.clean || fixable === 0 ? "var(--chip)" : "var(--grad)",
              boxShadow: card.clean || fixable === 0 ? "none" : "0 4px 16px var(--glow-color)",
            }}>
              <Icon name="sparkle" size={16} fill />
              <span>
                {card.clean
                  ? "Linter clean — nothing to repair"
                  : fixable > 0
                    ? `Run repair · ${fixable} fixable`
                    : `${card.totalIssues} finding${card.totalIssues === 1 ? "" : "s"} — needs your judgment`}
              </span>
            </button>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 9 }}>
              <span style={{ fontSize: 10.5, color: "var(--txt-3)" }}>Repairs restore antecedents, payoffs &amp; coverage.</span>
              <button onClick={reset} style={{ background: "none", border: "none", color: "var(--txt-2)", fontFamily: "inherit", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                <Icon name="reset" size={13} />Reset
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* toast */}
      {toast && (
        <div style={{ position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)", zIndex: 40, display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 13, background: "var(--bg-elev)", border: "1px solid var(--hair-2)", boxShadow: "0 18px 50px rgba(0,0,0,.4)", maxWidth: 420 }}>
          <span style={{ color: "var(--accent)" }}><Icon name="sparkle" size={17} fill /></span>
          <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.45, color: "var(--txt)" }}>{toast}</span>
        </div>
      )}
    </div>
  );
}

function Tile({ value, label, color, icon }: { value: string; label: string; color?: string; icon?: React.ReactNode }) {
  return (
    <div style={{ borderRadius: 13, padding: "12px 13px", background: "var(--panel-2)", border: "1px solid var(--hair)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", fontFamily: "var(--mono)", color: color || "var(--txt)" }}>
        {icon}{value}
      </div>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: ".02em", textTransform: "uppercase", color: "var(--txt-3)", marginTop: 2 }}>{label}</div>
    </div>
  );
}
