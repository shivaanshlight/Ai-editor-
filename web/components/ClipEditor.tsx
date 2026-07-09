"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, ClipPlan, Segment, WordRow } from "@/lib/types";
import { sourceUrl, getWords } from "@/lib/api";
import Timeline, { type TlBlock } from "./Timeline";

export default function ClipEditor({
  job,
  clip,
  onRender,
  onBack,
}: {
  job: Job;
  clip: ClipPlan;
  onRender: (i: number, segments: Segment[], title: string) => void;
  onBack: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [words, setWords] = useState<WordRow[]>([]);
  const [keeps, setKeeps] = useState<Segment[]>([]);
  const [wordEdits, setWordEdits] = useState<Record<number, string>>({});

  const padStart = clip.padStart ?? Math.max(0, clip.start - 120);
  const padEnd = clip.padEnd ?? Math.min(job.duration, clip.end + 120);

  useEffect(() => {
    getWords(job.id).then(setWords).catch(() => setWords([]));
  }, [job.id]);

  const blocks: TlBlock[] = useMemo(() => {
    const regions: { start: number; end: number; type: "keep" | "cut" }[] = [];
    if (clip.start - padStart > 0.05) regions.push({ start: padStart, end: clip.start, type: "cut" });
    regions.push({ start: clip.start, end: clip.end, type: "keep" });
    if (padEnd - clip.end > 0.05) regions.push({ start: clip.end, end: padEnd, type: "cut" });
    return regions.map((r) => ({
      ...r,
      words: words
        .filter((w) => w.s >= r.start && w.s < r.end)
        .map((w) => ({ i: w.i, w: w.w })),
    }));
  }, [clip, padStart, padEnd, words]);

  const onLoaded = () => {
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = clip.start;
      } catch {}
    }
  };

  return (
    <div className="animate-fade-up">
      <p className="mb-3 text-muted">
        Editing <b className="text-ink">“{clip.title}”</b> — drag the clip edges
        (or split / delete) to extend up to 2 min either side, then render.
      </p>

      <video
        ref={videoRef}
        controls
        playsInline
        src={sourceUrl(job.id)}
        onLoadedMetadata={onLoaded}
        className="max-h-[460px] w-full rounded-xl2 border border-line bg-black"
      />

      <Timeline
        blocks={blocks}
        origin={padStart}
        dur={Math.max(1, padEnd - padStart)}
        jobDuration={job.duration}
        mapping="source"
        versionSegs={[]}
        videoRef={videoRef}
        wordEdits={wordEdits}
        onWordEdit={(i, v) => setWordEdits((p) => ({ ...p, [i]: v }))}
        onKeepsChange={setKeeps}
      />

      <div className="mt-5 flex flex-wrap gap-2.5">
        <button
          className="btn btn-primary"
          disabled={!keeps.length}
          onClick={() => onRender(clip.i, keeps, clip.title)}
        >
          Render this clip
        </button>
        <button className="btn" onClick={onBack}>← Back to clips</button>
      </div>
    </div>
  );
}
