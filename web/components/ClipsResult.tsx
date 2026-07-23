"use client";
import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/types";
import { clipPreviewUrl, clipDownloadUrl, enhanceClip, getJob } from "@/lib/api";
import { fmt } from "@/lib/format";

type Clip = { i: number; title?: string; duration: number; start: number; end: number; enhanced?: boolean; v?: number };

export default function ClipsResult({
  job,
  vertical,
  onNew,
}: {
  job: Job;
  vertical: boolean;
  onNew: () => void;
}) {
  const [clips, setClips] = useState<Clip[]>((job.clips as Clip[]) || []);
  const [sel, setSel] = useState(0);
  const [enh, setEnh] = useState<{ i: number; pct: number; stage: string } | null>(null);
  const [ready, setReady] = useState<boolean>((job as { enhancerReady?: boolean }).enhancerReady ?? true);
  const [err, setErr] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setClips((job.clips as Clip[]) || []), [job.clips]);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const cur = clips[sel] || clips[0];

  const startEnhance = async (i: number) => {
    setErr("");
    try {
      await enhanceClip(job.id, i);
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    setEnh({ i, pct: 0, stage: "starting" });
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const j = (await getJob(job.id)) as Job & {
          enhance?: { i: number; pct: number; stage: string };
          enhanceError?: string;
          clips?: Clip[];
        };
        if (j.clips) setClips(j.clips);
        if (j.enhance) setEnh({ i: j.enhance.i, pct: j.enhance.pct, stage: j.enhance.stage });
        else {
          if (poll.current) clearInterval(poll.current);
          setEnh(null);
          if (j.enhanceError) setErr(j.enhanceError);
        }
      } catch {}
    }, 2000);
  };

  const lbl: React.CSSProperties = { fontSize: 10.5, fontWeight: 650, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--txt-3)" };
  const phead: React.CSSProperties = { flex: "0 0 auto", height: 38, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", borderBottom: "1px solid var(--hair)" };

  return (
    <div style={{ height: "calc(100vh - 52px)", display: "grid", gridTemplateColumns: "316px 1fr", background: "var(--panel-2)" }}>
      {/* LEFT — clip library */}
      <aside style={{ display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--hair)", background: "var(--panel)" }}>
        <div style={phead}><span style={lbl}>Clips</span><span className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)" }}>{clips.length}</span></div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {clips.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "var(--txt-3)" }}>No clips.</div>}
          {clips.map((c, i) => (
            <button
              key={c.i}
              onClick={() => setSel(i)}
              style={{
                display: "grid", gridTemplateColumns: vertical ? "40px 1fr" : "62px 1fr", gap: 10, alignItems: "center",
                padding: 8, borderRadius: 8, cursor: "pointer", textAlign: "left", font: "inherit",
                border: "1px solid " + (i === sel ? "var(--accent)" : "var(--hair)"),
                background: i === sel ? "var(--mix-bg)" : "var(--bg-elev)",
              }}
            >
              <div style={{ aspectRatio: vertical ? "9 / 16" : "16 / 9", background: "#000", borderRadius: 5, position: "relative", display: "grid", placeItems: "center" }}>
                <span className="mono" style={{ color: i === sel ? "var(--accent)" : "var(--txt-3)", fontSize: 11 }}>{i + 1}</span>
                {c.enhanced && <span style={{ position: "absolute", top: 2, right: 2, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.04em", color: "#fff", background: "var(--accent)", padding: "1px 3px", borderRadius: 3 }}>1080p</span>}
                {enh && enh.i === c.i && <span style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, color: "#fff", borderRadius: 5 }}>{enh.pct}%</span>}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--txt)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || `Clip ${i + 1}`}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)", marginTop: 2 }}>{Math.round(c.duration)}s · {fmt(c.start)}</div>
              </div>
            </button>
          ))}
        </div>
        <div style={{ borderTop: "1px solid var(--hair)", padding: 12 }}>
          <button className="btn btn-sm" onClick={onNew} style={{ width: "100%" }}>New video</button>
        </div>
      </aside>

      {/* CENTER — selected clip preview + actions */}
      <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 24 }}>
          {cur && (
            <video
              key={`${cur.i}-${cur.v || 0}`}
              controls
              autoPlay
              playsInline
              preload="metadata"
              src={clipPreviewUrl(job.id, cur.i)}
              style={{ maxHeight: "calc(100vh - 240px)", maxWidth: "100%", borderRadius: 10, border: "1px solid var(--hair-2)", background: "#000", display: "block" }}
            />
          )}
        </div>
        {cur && (
          <div style={{ flex: "0 0 auto", borderTop: "1px solid var(--hair)", background: "var(--panel)", padding: "14px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 640, display: "flex", alignItems: "center", gap: 8 }}>
                  {cur.title || `Clip ${sel + 1}`}
                  {cur.enhanced && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", color: "#fff", background: "var(--accent)", padding: "2px 6px", borderRadius: 5 }}>1080p</span>}
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 3 }}>
                  clip {sel + 1} of {clips.length} · {Math.round(cur.duration)}s · from {fmt(cur.start)}
                </div>
              </div>

              {/* enhance button / progress */}
              {enh && enh.i === cur.i ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 190 }}>
                  <div style={{ fontSize: 11, color: "var(--txt-2)" }}>{enh.stage}</div>
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${enh.pct}%` }} /></div>
                </div>
              ) : cur.enhanced ? (
                <button className="btn btn-sm" onClick={() => startEnhance(cur.i)} disabled={!!enh} title="Enhance again">Re-enhance</button>
              ) : (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => startEnhance(cur.i)}
                  disabled={!!enh || !ready}
                  title={ready ? "AI upscale this clip to 1080p on your GPU (a few minutes)" : "Run: node scripts/setup-upscaler.js"}
                >
                  ⚡ Enhance to 1080p
                </button>
              )}
              <a className="btn btn-sm" href={clipDownloadUrl(job.id, cur.i)}>⤓ Download</a>
            </div>
            {err && <div style={{ marginTop: 8, fontSize: 12, color: "var(--bad)" }}>{err}</div>}
            {!ready && !err && (
              <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--txt-3)" }}>
                Enhancer not installed — run <span className="mono" style={{ color: "var(--txt-2)" }}>node scripts/setup-upscaler.js</span> then restart.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
