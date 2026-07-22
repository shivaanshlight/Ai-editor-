"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, Segment, Version } from "@/lib/types";
import { previewUrl, downloadUrl } from "@/lib/api";
import { fmt, pct, fmtClock } from "@/lib/format";
import Timeline, { type TlBlock } from "./Timeline";
import ContentKit from "./ContentKit";
import Search from "./Search";
import Chat from "./Chat";

function srcToOut(srcT: number, segs: Segment[]): number | null {
  let acc = 0;
  for (const s of segs) {
    if (srcT >= s.start && srcT <= s.end) return acc + (srcT - s.start);
    if (srcT < s.start) return acc;
    acc += s.end - s.start;
  }
  return null;
}

export default function Result({
  job,
  onRerender,
  onNew,
}: {
  job: Job;
  onRerender: (
    included: Segment[],
    wordEdits: Record<number, string>,
    speakerNames?: Record<string, string>,
    coldOpen?: boolean,
    gains?: { start: number; end: number; db: number }[],
  ) => void;
  onNew: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [curVersion, setCurVersion] = useState(job.version || 1);
  const [wordEdits, setWordEdits] = useState<Record<number, string>>({});
  const [keeps, setKeeps] = useState<Segment[]>([]);
  const [gains, setGains] = useState<{ start: number; end: number; db: number }[]>([]);

  const versions: Version[] = job.versions?.length
    ? job.versions
    : [{ v: 1, keptDuration: job.keptDuration || 0, segments: job.segments || [] }];

  const curSegs =
    versions.find((v) => v.v === curVersion)?.segments || job.segments || [];
  const curKept =
    versions.find((v) => v.v === curVersion)?.keptDuration ?? job.keptDuration ?? 0;

  const blocks: TlBlock[] = useMemo(
    () =>
      (job.reviewBlocks || []).map((b) => ({
        start: b.start,
        end: b.end,
        type: b.type,
        words: (b.words || []).map((w) => ({ i: w.i, w: w.w })),
      })),
    [job.reviewBlocks],
  );

  useEffect(() => {
    setCurVersion(job.version || 1);
  }, [job.version, job.id]);

  const jump = (t: number) => {
    const o = srcToOut(t, curSegs);
    if (o !== null && isFinite(o) && videoRef.current) {
      videoRef.current.currentTime = o;
      videoRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  // Chapters are computed on the SOURCE timeline, but the player shows the
  // EDITED cut — so remap each chapter to its output time and drop any whose
  // moment was cut entirely. This keeps the labels in sync with the video.
  const outChapters = useMemo(() => {
    const list = (job.chapters || [])
      .map((c) => ({ title: c.title, outT: srcToOut(c.start, curSegs) }))
      .filter((c): c is { title: string; outT: number } => c.outT !== null && isFinite(c.outT))
      .sort((a, b) => a.outT - b.outT);
    // collapse near-duplicate times created when several cut chapters map to the
    // same surviving boundary
    const out: typeof list = [];
    for (const c of list) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(c.outT - prev.outT) < 2) continue;
      out.push(c);
    }
    return out;
  }, [job.chapters, curSegs]);

  const saved = job.duration - curKept;

  return (
    <div className="animate-fade-up">
      {job.summary && (
        <p className="mb-3 text-muted">Editor’s note: {job.summary}</p>
      )}

      <video
        ref={videoRef}
        controls
        playsInline
        src={previewUrl(job.id, curVersion)}
        className="max-h-[460px] w-full rounded-xl2 border border-line bg-black"
      />

      {versions.length > 1 && (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {versions.map((v) => (
            <button
              key={v.v}
              onClick={() => setCurVersion(v.v)}
              className={`mono rounded-full border px-3 py-1.5 text-[12.5px] ${
                v.v === curVersion
                  ? "border-[var(--accent)] bg-[var(--mix-bg)] text-ink"
                  : "border-line bg-surface2 text-muted"
              }`}
            >
              v{v.v} · {fmt(v.keptDuration)}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-xl2 border border-line bg-line">
        <div className="bg-surface px-4 py-3.5">
          <div className="mono text-[20px] font-medium">{fmt(job.duration)}</div>
          <div className="mt-0.5 text-[12px] text-muted">original</div>
        </div>
        <div className="bg-surface px-4 py-3.5">
          <div className="mono text-[20px] font-medium">{fmt(curKept)}</div>
          <div className="mt-0.5 text-[12px] text-muted">this version</div>
        </div>
        <div className="bg-surface px-4 py-3.5">
          <div className="mono text-[20px] font-medium text-accent">
            −{fmt(saved)} ({pct(saved, job.duration)}%)
          </div>
          <div className="mt-0.5 text-[12px] text-muted">removed</div>
        </div>
      </div>

      {outChapters.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.09em] text-muted">
            Chapters — click to jump
          </div>
          <div className="flex flex-wrap gap-2">
            {outChapters.map((c, i) => (
              <button
                key={i}
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.currentTime = c.outT;
                    videoRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
                  }
                }}
                className="flex items-center gap-2 rounded-full border border-line bg-surface2 px-3 py-1.5 text-[12.5px] hover:border-[var(--accent-2)]"
              >
                <span className="mono text-accent2">{fmtClock(c.outT)}</span>
                <span className="text-muted">{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Search jobId={job.id} ready={!!job.searchReady} onJump={jump} />

      <Timeline
        blocks={blocks}
        origin={0}
        dur={job.duration}
        jobDuration={job.duration}
        mapping="output"
        versionSegs={curSegs}
        videoRef={videoRef}
        wordEdits={wordEdits}
        onWordEdit={(i, v) => setWordEdits((p) => ({ ...p, [i]: v }))}
        onKeepsChange={setKeeps}
        onGainsChange={setGains}
        jobId={job.id}
      />

      <div className="mt-5 flex flex-wrap gap-2.5">
        <button
          className="btn btn-primary"
          disabled={!keeps.length}
          onClick={() => onRerender(keeps, wordEdits, undefined, undefined, gains)}
        >
          Re-render with changes
        </button>
        <a className="btn" href={downloadUrl(job.id, curVersion)}>Download</a>
        <button className="btn" onClick={onNew}>New video</button>
      </div>

      {job.mode !== "silence" && (
        <>
          <Chat jobId={job.id} ready={!!job.searchReady} onJump={jump} />
          <ContentKit jobId={job.id} />
        </>
      )}
    </div>
  );
}
