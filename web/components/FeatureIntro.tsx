"use client";
import type { Mode } from "@/lib/types";

// Per-feature hero + "how it works" step strip, in the Pro-template look.
// Gives every mode its own identity instead of one generic upload page.

type Step = { icon: IconName; title: string; sub: string };
type Feature = {
  tag: string;
  h1: string;
  h2: string; // gradient accent line
  sub: string;
  steps: Step[];
};

const FEATURES: Record<Mode, Feature> = {
  ai: {
    tag: "AI EDIT",
    h1: "Raw footage in.",
    h2: "Finished edit out.",
    sub: "Describe the edit in plain English. The AI transcribes, plans the cut, and hands you a review timeline — fix anything, then render as many versions as you want.",
    steps: [
      { icon: "wave", title: "Transcribe", sub: "Whisper, word-level" },
      { icon: "brain", title: "Plan the cut", sub: "LLM scores each line" },
      { icon: "check", title: "Review & fix", sub: "keep / cut / lock" },
      { icon: "film", title: "Render", sub: "captions + audio" },
    ],
  },
  highlights: {
    tag: "HIGHLIGHTS",
    h1: "Hours of recording.",
    h2: "One tight highlights cut.",
    sub: "The AI watches the entire session, scores every moment, and stitches only the best into a single watchable episode at the runtime you choose.",
    steps: [
      { icon: "eye", title: "Watch it all", sub: "chunked, no limit" },
      { icon: "spark", title: "Score moments", sub: "salience ranking" },
      { icon: "stitch", title: "Stitch best", sub: "to target length" },
      { icon: "film", title: "Render recap", sub: "one episode" },
    ],
  },
  clips: {
    tag: "FIND CLIPS",
    h1: "Find the moments",
    h2: "worth posting.",
    sub: "The AI scans your whole video for self-contained, high-scoring clips — then you pick, trim, and export them vertical or wide.",
    steps: [
      { icon: "scan", title: "Scan video", sub: "full pass" },
      { icon: "rank", title: "Rank clips", sub: "self-contained" },
      { icon: "crop", title: "Trim & reframe", sub: "9:16 or wide" },
      { icon: "export", title: "Export", sub: "post-ready" },
    ],
  },
  silence: {
    tag: "QUICK CUT",
    h1: "Cut the dead air.",
    h2: "Instantly.",
    sub: "No transcription, no waiting — detect silent gaps and remove them, fully offline. Then fine-tune every cut on the timeline before export.",
    steps: [
      { icon: "wave", title: "Detect silence", sub: "offline, fast" },
      { icon: "scissors", title: "Trim gaps", sub: "with breathing room" },
      { icon: "check", title: "Review timeline", sub: "every cut" },
      { icon: "export", title: "Export", sub: "no upload" },
    ],
  },
};

export default function FeatureIntro({ mode }: { mode: Mode }) {
  const f = FEATURES[mode];
  return (
    <section className="animate-fade-up" style={{ paddingTop: 10 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontSize: 10.5,
          fontWeight: 650,
          letterSpacing: ".12em",
          color: "var(--txt-3)",
          marginBottom: 14,
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--accent)" }} />
        {f.tag}
      </div>
      <h1
        style={{
          margin: 0,
          maxWidth: "20ch",
          fontSize: "clamp(26px,3.6vw,38px)",
          fontWeight: 680,
          lineHeight: 1.08,
          letterSpacing: "-.03em",
          textWrap: "balance" as any,
          color: "var(--ink)",
        }}
      >
        <span>{f.h1}</span>{" "}
        <span style={{ color: "var(--accent)" }}>{f.h2}</span>
      </h1>
      <p style={{ marginTop: 13, maxWidth: "58ch", fontSize: 14, lineHeight: 1.6, color: "var(--txt-2)" }}>
        {f.sub}
      </p>

      <div
        style={{
          marginTop: 20,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
          gap: 10,
        }}
      >
        {f.steps.map((s, i) => (
          <div
            key={s.title}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "11px 12px",
              borderRadius: 9,
              background: "var(--panel)",
              border: "1px solid var(--hair)",
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                flex: "0 0 auto",
                borderRadius: 8,
                display: "grid",
                placeItems: "center",
                background: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              <Icon name={s.icon} size={17} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--txt-3)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{s.title}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--txt-3)", marginTop: 1 }}>{s.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------- icons ---------------------------------- */
type IconName =
  | "wave" | "brain" | "check" | "film" | "eye" | "spark" | "stitch"
  | "scan" | "rank" | "crop" | "export" | "scissors";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const P = (d: string, k: number) => <path key={k} d={d} />;
  const C = (cx: number, cy: number, r: number, k: number) => <circle key={k} cx={cx} cy={cy} r={r} />;
  let kids: React.ReactNode[] = [];
  switch (name) {
    case "wave": kids = [P("M3 12h2l2-6 3 12 2-9 2 5 2-2h5", 1)]; break;
    case "brain": kids = [P("M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 9 18V4z", 1), P("M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8A3 3 0 0 1 15 18V4z", 2)]; break;
    case "check": kids = [C(12, 12, 9, 1), P("M8.4 12.3l2.4 2.4 4.7-4.9", 2)]; break;
    case "film": kids = [<rect key={1} x={4} y={5} width={16} height={14} rx={2.5} />, P("M4 10h16M4 14h16M9 5v14M15 5v14", 2)]; break;
    case "eye": kids = [P("M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", 1), C(12, 12, 3, 2)]; break;
    case "spark": kids = [P("M12 3.4l1.7 5.1 5.1 1.7-5.1 1.7L12 17l-1.7-5.1L5.2 10.2l5.1-1.7z", 1)]; break;
    case "stitch": kids = [P("M4 8h4l2 8h4l2-8h4", 1), P("M4 16h4M16 8h4", 2)]; break;
    case "scan": kids = [P("M4 8V6a2 2 0 0 1 2-2h2", 1), P("M16 4h2a2 2 0 0 1 2 2v2", 2), P("M20 16v2a2 2 0 0 1-2 2h-2", 3), P("M8 20H6a2 2 0 0 1-2-2v-2", 4), P("M4 12h16", 5)]; break;
    case "rank": kids = [P("M5 20V10M12 20V4M19 20v-7", 1)]; break;
    case "crop": kids = [P("M6 2v14a2 2 0 0 0 2 2h14", 1), P("M2 6h14a2 2 0 0 1 2 2v14", 2)]; break;
    case "export": kids = [P("M12 3v11", 1), P("M8 7l4-4 4 4", 2), P("M4 14v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3", 3)]; break;
    case "scissors": kids = [C(6, 6, 2.4, 1), C(6, 18, 2.4, 2), P("M8.1 7.7L20 19", 3), P("M8.1 16.3L20 5", 4)]; break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      {kids}
    </svg>
  );
}
