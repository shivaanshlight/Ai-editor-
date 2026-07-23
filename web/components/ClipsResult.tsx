"use client";
import { useState } from "react";
import type { Job } from "@/lib/types";
import { clipPreviewUrl, clipDownloadUrl } from "@/lib/api";
import { fmt } from "@/lib/format";

export default function ClipsResult({
  job,
  vertical,
  onNew,
}: {
  job: Job;
  vertical: boolean;
  onNew: () => void;
}) {
  const clips = job.clips || [];
  const [sel, setSel] = useState(0);
  const cur = clips[sel] || clips[0];

  const lbl: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 650, letterSpacing: "0.09em",
    textTransform: "uppercase", color: "var(--txt-3)",
  };
  const phead: React.CSSProperties = {
    flex: "0 0 auto", height: 38, display: "flex", alignItems: "center",
    justifyContent: "space-between", padding: "0 14px", borderBottom: "1px solid var(--hair)",
  };

  return (
    <div style={{ height: "calc(100vh - 52px)", display: "grid", gridTemplateColumns: "316px 1fr", background: "var(--panel-2)" }}>
      {/* LEFT — clip library */}
      <aside style={{ display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--hair)", background: "var(--panel)" }}>
        <div style={phead}>
          <span style={lbl}>Clips</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--txt-3)" }}>{clips.length}</span>
        </div>
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
              <div style={{ aspectRatio: vertical ? "9 / 16" : "16 / 9", background: "#000", borderRadius: 5, overflow: "hidden", position: "relative", display: "grid", placeItems: "center" }}>
                <span className="mono" style={{ color: i === sel ? "var(--accent)" : "var(--txt-3)", fontSize: 11 }}>{i + 1}</span>
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

      {/* CENTER — selected clip preview + download */}
      <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 24 }}>
          {cur && (
            <video
              key={cur.i}
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
                <div style={{ fontSize: 15, fontWeight: 640 }}>{cur.title || `Clip ${sel + 1}`}</div>
                <div className="mono" style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 3 }}>
                  clip {sel + 1} of {clips.length} · {Math.round(cur.duration)}s · from {fmt(cur.start)}
                </div>
              </div>
              <a className="btn btn-sm btn-primary" href={clipDownloadUrl(job.id, cur.i)}>⤓ Download this clip</a>
            </div>
            {(cur as { text?: string }).text && (
              <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--txt-2)", lineHeight: 1.5, maxWidth: "72ch" }}>
                {(cur as { text?: string }).text}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
