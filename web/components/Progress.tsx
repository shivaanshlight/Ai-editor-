"use client";
import type { Job } from "@/lib/types";

const LABELS: Record<string, string> = {
  analyzing: "Analyzing",
  transcribing: "Transcribing",
  planning: "Planning the edit",
  queued: "Queued",
  cutting: "Cutting & encoding",
  finishing: "Captions & audio mix",
};

// A friendly, weighted status line + bar for the non-interactive phases.
export default function Progress({ job }: { job: Job }) {
  const base = LABELS[job.status] || "Working";
  const label = job.stage ? `${base} — ${job.stage}` : base;
  const queued = job.status === "queued" && job.queuePos ? ` (position ${job.queuePos})` : "";
  const p = Math.max(4, job.progress || 0);

  return (
    <div className="animate-fade-up">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
          </span>
          {label}
          {queued}
        </span>
        <span className="mono text-accent">{Math.round(job.progress || 0)}%</span>
      </div>
      <div className="progress-track mt-3">
        <div className="progress-fill" style={{ width: `${p}%` }} />
      </div>
      {job.originalName && (
        <p className="mt-2.5 truncate text-[12.5px] text-faint">{job.originalName}</p>
      )}
    </div>
  );
}
