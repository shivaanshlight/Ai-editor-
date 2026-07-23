"use client";
import type { Job, Mode } from "@/lib/types";

// Pipeline processing screen in the Pro-template look: a labelled stepper of the
// phases this mode runs through, the active one lit, plus the live progress bar.

const LABELS: Record<string, string> = {
  analyzing: "Analyzing",
  transcribing: "Transcribing",
  planning: "Planning the edit",
  queued: "Queued",
  cutting: "Cutting & encoding",
  finishing: "Captions & audio mix",
};

// Ordered phases per mode (queued is a waiting state, shown inline on the bar).
const PIPELINES: Record<Mode, { key: string; label: string }[]> = {
  ai: [
    { key: "transcribing", label: "Transcribe" },
    { key: "planning", label: "Plan" },
    { key: "cutting", label: "Cut" },
    { key: "finishing", label: "Finish" },
  ],
  highlights: [
    { key: "transcribing", label: "Watch" },
    { key: "planning", label: "Score" },
    { key: "cutting", label: "Stitch" },
    { key: "finishing", label: "Finish" },
  ],
  clips: [
    { key: "transcribing", label: "Transcribe" },
    { key: "planning", label: "Rank" },
    { key: "cutting", label: "Cut" },
    { key: "finishing", label: "Finish" },
  ],
  silence: [
    { key: "analyzing", label: "Detect" },
    { key: "cutting", label: "Trim" },
    { key: "finishing", label: "Finish" },
  ],
};

const RANK: Record<string, number> = {
  analyzing: 0,
  transcribing: 1,
  planning: 2,
  queued: 2,
  cutting: 3,
  finishing: 4,
};

export default function Progress({ job }: { job: Job }) {
  const base = LABELS[job.status] || "Working";
  const label = job.stage ? `${base} — ${job.stage}` : base;
  const queued = job.status === "queued" && job.queuePos ? ` · position ${job.queuePos}` : "";
  const p = Math.max(4, job.progress || 0);
  const steps = PIPELINES[job.mode] || PIPELINES.ai;
  const cur = RANK[job.status] ?? 0;

  return (
    <div className="animate-fade-up">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 15, fontWeight: 700 }}>
          <span style={{ position: "relative", display: "flex", width: 10, height: 10 }}>
            <span className="animate-ping" style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--accent)", opacity: 0.6 }} />
            <span style={{ position: "relative", width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }} />
          </span>
          {label}
          {queued}
        </span>
        <span className="mono" style={{ color: "var(--accent)", fontWeight: 700 }}>{Math.round(job.progress || 0)}%</span>
      </div>

      {/* stepper */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, margin: "16px 0 4px" }}>
        {steps.map((s, i) => {
          const rank = RANK[s.key] ?? i + 1;
          const done = cur > rank;
          const active = cur === rank || (job.status === "queued" && s.key === "planning");
          const on = done || active;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center", flex: i < steps.length - 1 ? 1 : "0 0 auto", minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    display: "grid",
                    placeItems: "center",
                    fontSize: 12,
                    fontWeight: 800,
                    fontFamily: "var(--mono)",
                    color: done ? "#fff" : active ? "var(--accent)" : "var(--txt-3)",
                    background: done ? "var(--accent)" : active ? "var(--accent-soft)" : "var(--chip)",
                    border: "1px solid " + (active && !done ? "var(--accent-line)" : "var(--hair)"),
                  }}
                >
                  {done ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6.5L9.2 17.3 4 12.1" /></svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: on ? "var(--txt)" : "var(--txt-3)", whiteSpace: "nowrap" }}>{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div style={{ flex: 1, height: 2, margin: "0 8px", marginBottom: 22, borderRadius: 2, background: done ? "var(--accent)" : "var(--hair)" }} />
              )}
            </div>
          );
        })}
      </div>

      <div className="progress-track" style={{ marginTop: 14 }}>
        <div className="progress-fill" style={{ width: `${p}%` }} />
      </div>
      {job.originalName && (
        <p style={{ marginTop: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: "var(--txt-3)" }}>
          {job.originalName}
        </p>
      )}
    </div>
  );
}
