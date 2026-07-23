"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, Segment, Version } from "@/lib/types";
import { previewUrl, downloadUrl, sourceUrl, fetchWords } from "@/lib/api";
import { useLivePreview } from "./useLivePreview";
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
  const [live, setLive] = useState(true); // live preview vs the last rendered file
  const [words, setWords] = useState<{ s: number; e: number; w: string }[]>([]);
  const [caption, setCaption] = useState("");

  // stable source URL (don't remint every render — that would reload the video)
  const liveSrc = useMemo(() => sourceUrl(job.id), [job.id]);
  useEffect(() => {
    let alive = true;
    fetchWords(job.id).then((w) => alive && setWords(w));
    return () => {
      alive = false;
    };
  }, [job.id]);

  const versions: Version[] = job.versions?.length
    ? job.versions
    : [{ v: 1, keptDuration: job.keptDuration || 0, segments: job.segments || [] }];

  const curSegs =
    versions.find((v) => v.v === curVersion)?.segments || job.segments || [];
  const curKept =
    versions.find((v) => v.v === curVersion)?.keptDuration ?? job.keptDuration ?? 0;

  // keeps sorted for the live player; fall back to the rendered version's segs
  const liveKeeps = useMemo(
    () => (keeps.length ? [...keeps] : curSegs).slice().sort((a, b) => a.start - b.start),
    [keeps, curSegs],
  );
  useLivePreview(videoRef, liveKeeps, gains, words, live, setCaption);

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
      .map((c) => ({ title: c.title, srcT: c.start, outT: srcToOut(c.start, curSegs) }))
      .filter((c): c is { title: string; srcT: number; outT: number } => c.outT !== null && isFinite(c.outT))
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

  const lbl: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 650, letterSpacing: "0.09em",
    textTransform: "uppercase", color: "var(--txt-3)",
  };
  const phead: React.CSSProperties = {
    flex: "0 0 auto", height: 38, display: "flex", alignItems: "center",
    justifyContent: "space-between", padding: "0 14px", borderBottom: "1px solid var(--hair)",
  };

  return (
    <div style={{ height: "calc(100vh - 52px)", display: "grid", gridTemplateRows: "1fr 236px", background: "var(--panel-2)" }}>
      {/* ---- top: three panels ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "266px 1fr 350px", minHeight: 0 }}>
        {/* LEFT — chapters + stats */}
        <aside style={{ display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--hair)", background: "var(--panel)" }}>
          <div style={phead}><span style={lbl}>Chapters</span><span className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)" }}>{outChapters.length}</span></div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}>
            {outChapters.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "var(--txt-3)" }}>No chapters.</div>}
            {outChapters.map((c, i) => (
              <div
                key={i}
                onClick={() => { if (videoRef.current) videoRef.current.currentTime = live ? c.srcT : c.outT; }}
                style={{ display: "grid", gridTemplateColumns: "46px 1fr", gap: 10, alignItems: "baseline", padding: "9px 10px", borderRadius: 7, cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-elev)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>{fmtClock(c.outT)}</span>
                <span style={{ fontSize: 12.5, color: "var(--txt)", lineHeight: 1.35 }}>{c.title}</span>
              </div>
            ))}
          </div>
          {/* stats */}
          <div style={{ borderTop: "1px solid var(--hair)", padding: "12px 14px", background: "var(--panel-2)" }}>
            <div style={{ ...lbl, marginBottom: 8 }}>This version</div>
            {[["Original", fmt(job.duration), "var(--txt)"], ["Kept", fmt(curKept), "var(--txt)"], ["Removed", `−${fmt(saved)} · ${pct(saved, job.duration)}%`, "var(--accent)"]].map(([k, v, col]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 }}>
                <span style={{ color: "var(--txt-3)" }}>{k}</span>
                <span className="mono" style={{ color: col as string }}>{v}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* CENTER — preview + transport */}
        <section style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--panel-2)" }}>
          <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 20, position: "relative" }}>
            <div style={{ position: "relative", maxHeight: "100%", maxWidth: "100%" }}>
              <video
                ref={videoRef}
                controls
                playsInline
                src={live ? liveSrc : previewUrl(job.id, curVersion)}
                style={{ maxHeight: "calc(100vh - 400px)", maxWidth: "100%", borderRadius: 10, border: "1px solid var(--hair-2)", background: "#000", display: "block" }}
              />
              {live && caption && (
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 46, display: "flex", justifyContent: "center", padding: "0 16px", pointerEvents: "none" }}>
                  <span style={{ background: "rgba(0,0,0,0.72)", padding: "3px 10px", borderRadius: 6, textAlign: "center", fontSize: 15, fontWeight: 600, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.9)", maxWidth: "88%" }}>{caption}</span>
                </div>
              )}
            </div>
          </div>
          {/* transport bar */}
          <div style={{ flex: "0 0 auto", height: 52, display: "flex", alignItems: "center", gap: 12, padding: "0 16px", borderTop: "1px solid var(--hair)", background: "var(--panel)" }}>
            <div style={{ display: "inline-flex", padding: 2, gap: 2, background: "var(--panel-2)", border: "1px solid var(--hair)", borderRadius: 8 }}>
              <button onClick={() => setLive(true)} style={{ border: 0, font: "inherit", fontSize: 11.5, fontWeight: 550, padding: "4px 11px", borderRadius: 6, cursor: "pointer", color: live ? "#fff" : "var(--txt-2)", background: live ? "var(--accent)" : "transparent" }}>⚡ Live</button>
              <button onClick={() => setLive(false)} style={{ border: 0, font: "inherit", fontSize: 11.5, fontWeight: 550, padding: "4px 11px", borderRadius: 6, cursor: "pointer", color: !live ? "#fff" : "var(--txt-2)", background: !live ? "var(--accent)" : "transparent" }}>Rendered</button>
            </div>
            <span style={{ fontSize: 11.5, color: "var(--txt-3)" }}>{live ? "edits play instantly — no render" : "last exported file"}</span>
            {versions.length > 1 && (
              <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
                {versions.map((v) => (
                  <button key={v.v} onClick={() => setCurVersion(v.v)} className="mono" style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, cursor: "pointer", border: "1px solid " + (v.v === curVersion ? "var(--accent)" : "var(--hair)"), background: v.v === curVersion ? "var(--mix-bg)" : "var(--bg-elev)", color: v.v === curVersion ? "var(--ink)" : "var(--txt-2)" }}>v{v.v}</button>
                ))}
              </div>
            )}
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <a className="btn btn-sm" href={downloadUrl(job.id, curVersion)}>Download</a>
              <button className="btn btn-sm" onClick={onNew}>New</button>
              <button className="btn btn-sm btn-primary" disabled={!keeps.length} onClick={() => onRerender(keeps, wordEdits, undefined, undefined, gains)} title="Bake your edits into a final MP4">⤓ Export</button>
            </div>
          </div>
        </section>

        {/* RIGHT — tools (search / chat / content kit) */}
        <aside style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--panel)" }}>
          <div style={phead}><span style={lbl}>Tools</span></div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14 }}>
            {job.summary && <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--txt-2)", lineHeight: 1.5 }}><b style={{ color: "var(--txt)" }}>Note:</b> {job.summary}</p>}
            <Search jobId={job.id} ready={!!job.searchReady} onJump={jump} />
            {job.mode !== "silence" && (
              <>
                <Chat jobId={job.id} ready={!!job.searchReady} onJump={jump} />
                <ContentKit jobId={job.id} />
              </>
            )}
          </div>
        </aside>
      </div>

      {/* ---- docked timeline ---- */}
      <footer style={{ borderTop: "1px solid var(--hair)", background: "var(--panel-2)", minHeight: 0, overflow: "hidden", padding: "0 14px" }}>
        <Timeline
          blocks={blocks}
          origin={0}
          dur={job.duration}
          jobDuration={job.duration}
          mapping={live ? "source" : "output"}
          versionSegs={curSegs}
          videoRef={videoRef}
          wordEdits={wordEdits}
          onWordEdit={(i, v) => setWordEdits((p) => ({ ...p, [i]: v }))}
          onKeepsChange={setKeeps}
          onGainsChange={setGains}
          jobId={job.id}
        />
      </footer>
    </div>
  );
}
