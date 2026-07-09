"use client";
import { useState } from "react";
import type { Job, ClipPlan } from "@/lib/types";
import { fmt } from "@/lib/format";

export default function ClipReview({
  job,
  onRender,
  onEdit,
}: {
  job: Job;
  onRender: (selected: number[]) => void;
  onEdit: (clip: ClipPlan) => void;
}) {
  const plans = job.clipPlans || [];
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(plans.map((c) => c.i)),
  );

  const toggle = (i: number) =>
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  return (
    <div className="animate-fade-up">
      <p className="mb-3 text-muted">
        Found these standalone moments, ranked best-first. Untick any you don’t
        want, tweak in the timeline, then render.
      </p>
      <div className="flex flex-col gap-2.5">
        {plans.map((c) => (
          <div
            key={c.i}
            className="flex gap-3.5 rounded-xl2 border border-line bg-surface2 p-3.5"
          >
            <input
              type="checkbox"
              className="mt-1 h-[17px] w-[17px] flex-none cursor-pointer accent-[var(--accent)]"
              checked={checked.has(c.i)}
              onChange={() => toggle(c.i)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <b className="font-semibold">{c.title}</b>
                {c.score != null && (
                  <span className="mono flex-none rounded-md bg-[var(--accent)] px-1.5 py-[1px] text-[11px] font-bold text-[var(--accent-ink)]">
                    {c.score}
                  </span>
                )}
              </div>
              <div className="mono my-1 text-[11.5px] text-faint">
                {fmt(c.start)} → {fmt(c.end)} · {Math.round(c.end - c.start)}s
              </div>
              {c.reason && <p className="text-[12.5px] text-ink">{c.reason}</p>}
              {c.text && <p className="mt-1 text-[12.5px] text-muted">{c.text}…</p>}
              <button
                type="button"
                className="btn btn-sm mt-2.5"
                onClick={() => onEdit(c)}
              >
                ✎ Edit in timeline
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <button
          className="btn btn-primary"
          disabled={!checked.size}
          onClick={() => onRender([...checked])}
        >
          Render {checked.size} selected clip{checked.size === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
