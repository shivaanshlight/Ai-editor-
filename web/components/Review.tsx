"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, ReviewBlock, BlockWord, Segment } from "@/lib/types";
import { fmt, pct } from "@/lib/format";
import Search from "./Search";

function PlanCard({ job }: { job: Job }) {
  const p = job.planStats;
  if (!p) return null;
  const tiles = [
    ...(p.speakers ? [["speakers", p.speakers] as const] : []),
    ["topics", p.topics] as const,
    ["long pauses", p.longPauses] as const,
    ["filler words", p.fillers] as const,
    ["kept segments", p.cuts] as const,
  ];
  const saved = pct(p.originalRuntime - p.estRuntime, p.originalRuntime);
  return (
    <div className="mb-4 rounded-xl2 border border-line bg-surface2 p-4">
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold tracking-tight">Here’s what I found</h3>
        <span className="flex items-center gap-2 text-[12px] font-medium text-keep">
          <span className="h-[7px] w-[7px] rounded-full bg-keep shadow-[0_0_0_3px_var(--keep-bg)]" />
          Analysis complete
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-5">
        {tiles.map(([label, n]) => (
          <div key={label} className="bg-surface px-4 py-3">
            <div className="mono text-[21px] font-medium tracking-tight">{n}</div>
            <div className="mt-0.5 text-[11.5px] text-muted">{label}</div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-3.5 rounded-xl border border-line bg-surface px-4 py-3">
        <span className="mono text-muted">{fmt(p.originalRuntime)}</span>
        <span className="text-accent">→</span>
        <span className="mono text-[19px] font-medium">{fmt(p.estRuntime)}</span>
        <span className="ml-auto text-[13px] font-medium text-keep">−{saved}% runtime</span>
      </div>
    </div>
  );
}

function Word({
  word,
  cut,
  edited,
  onToggle,
  onEdit,
}: {
  word: BlockWord;
  cut: boolean;
  edited?: string;
  onToggle: () => void;
  onEdit: (v: string) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <span
      className={`word ${cut ? "cut" : ""} ${edited ? "edited" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(onToggle, 210);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (timer.current) clearTimeout(timer.current);
        const nv = prompt("Fix this word:", edited ?? word.w);
        if (nv !== null && nv.trim()) onEdit(nv.trim());
      }}
    >
      {edited ?? word.w}
    </span>
  );
}

export default function Review({
  job,
  onRender,
}: {
  job: Job;
  onRender: (included: Segment[], wordEdits: Record<number, string>) => void;
}) {
  const blocks: ReviewBlock[] = useMemo(() => job.reviewBlocks || [], [job.reviewBlocks]);
  const [cut, setCut] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, string>>({});
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Seed word-cut state from the AI's block decisions when the job arrives.
  useEffect(() => {
    const s = new Set<number>();
    for (const b of blocks) if (b.type === "cut") for (const w of b.words || []) s.add(w.i);
    setCut(s);
    setEdits({});
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const blockState = (b: ReviewBlock): "keep" | "cut" | "mixed" => {
    const ws = b.words || [];
    if (!ws.length) return b.type;
    const kept = ws.filter((w) => !cut.has(w.i)).length;
    if (kept === 0) return "cut";
    if (kept === ws.length) return "keep";
    return "mixed";
  };

  const included: Segment[] = useMemo(() => {
    const segs: Segment[] = [];
    for (const b of blocks) {
      const ws = b.words || [];
      if (!ws.length) {
        if (b.type !== "cut") segs.push({ start: b.start, end: b.end });
        continue;
      }
      let run: { s: number; e: number } | null = null;
      const flush = () => {
        if (!run) return;
        const start = run.s === 0 ? b.start : ((ws[run.s - 1].e ?? b.start) + (ws[run.s].s ?? b.start)) / 2;
        const end =
          run.e === ws.length - 1
            ? b.end
            : ((ws[run.e].e ?? b.end) + (ws[run.e + 1].s ?? b.end)) / 2;
        segs.push({ start, end });
        run = null;
      };
      ws.forEach((w, idx) => {
        if (!cut.has(w.i)) {
          if (!run) run = { s: idx, e: idx };
          else run.e = idx;
        } else flush();
      });
      flush();
    }
    return segs;
  }, [blocks, cut]);

  const keptDur = included.reduce((s, x) => s + (x.end - x.start), 0);

  const toggleWord = (i: number) =>
    setCut((prev) => {
      const n = new Set(prev);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  const flipBlock = (b: ReviewBlock) => {
    const ws = b.words || [];
    if (!ws.length) return; // silence blocks: nothing to flip at word level
    const anyKept = ws.some((w) => !cut.has(w.i));
    setCut((prev) => {
      const n = new Set(prev);
      for (const w of ws) (anyKept ? n.add(w.i) : n.delete(w.i));
      return n;
    });
  };

  const jump = (t: number) => {
    const i = blocks.findIndex((b) => t >= b.start && t < b.end);
    const node = blockRefs.current[i];
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.style.outline = "2px solid var(--accent)";
      setTimeout(() => (node.style.outline = ""), 1300);
    }
  };

  return (
    <div className="animate-fade-up">
      {job.summary && (
        <p className="mb-3 text-muted">AI editor’s plan: {job.summary}</p>
      )}
      <PlanCard job={job} />

      <Search jobId={job.id} ready={!!job.searchReady} onJump={jump} />

      <div className="my-3 flex flex-wrap justify-between gap-3 text-[12.5px] text-faint">
        <span>
          Click a word to cut/keep just it · click a block to flip the whole
          block · double-click a word to fix its caption
        </span>
        <span className="mono font-medium text-accent">
          keeping {fmt(keptDur)} of {fmt(job.duration)}
        </span>
      </div>

      <div className="flex max-h-[440px] flex-col gap-2 overflow-y-auto pr-1">
        {blocks.map((b, i) => {
          const st = blockState(b);
          const border =
            st === "keep"
              ? "border-l-keep bg-[var(--keep-bg)]"
              : st === "cut"
                ? "border-l-cut bg-[var(--cut-bg)]"
                : "border-l-[var(--accent)] bg-[var(--mix-bg)]";
          return (
            <div
              key={i}
              ref={(el) => {
                blockRefs.current[i] = el;
              }}
              onClick={() => flipBlock(b)}
              className={`cursor-pointer rounded-[10px] border border-line border-l-[3px] px-3.5 py-2.5 text-[13.5px] leading-relaxed transition-colors ${border}`}
            >
              <span className="mono mb-1 block text-[10.5px] tracking-wide text-faint">
                {fmt(b.start)} → {fmt(b.end)}
                {st === "cut" ? "  (cut)" : st === "mixed" ? "  (partly cut)" : ""}
              </span>
              <span className={st === "cut" ? "text-muted" : ""}>
                {(b.words || []).length === 0 ? (
                  <em className="text-faint">(silence)</em>
                ) : (
                  (b.words || []).map((w, k) => (
                    <span key={w.i}>
                      <Word
                        word={w}
                        cut={cut.has(w.i)}
                        edited={edits[w.i]}
                        onToggle={() => toggleWord(w.i)}
                        onEdit={(v) => setEdits((p) => ({ ...p, [w.i]: v }))}
                      />
                      {k < (b.words || []).length - 1 ? " " : ""}
                    </span>
                  ))
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap gap-2.5">
        <button
          className="btn btn-primary"
          disabled={!included.length}
          onClick={() => onRender(included, edits)}
        >
          Render video
        </button>
      </div>
    </div>
  );
}
