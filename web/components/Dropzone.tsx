"use client";
import { useRef, useState } from "react";

// Template-style upload panel: a solid glass panel (not a dashed placeholder)
// with a gradient tile, tactile hover glow, and a clear drop target.
export default function Dropzone({
  onFile,
  disabled,
}: {
  onFile: (f: File) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) input.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !disabled) onFile(f);
      }}
      className={disabled ? "pointer-events-none opacity-50" : ""}
      style={{
        marginTop: 20,
        cursor: "pointer",
        borderRadius: 18,
        border: "1px solid " + (over ? "var(--accent-line)" : "var(--hair)"),
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 40%), var(--panel-2)",
        padding: "44px 24px",
        textAlign: "center",
        transition: "border-color .18s, box-shadow .18s, transform .12s",
        transform: over ? "translateY(-1px)" : "none",
        boxShadow: over ? "0 0 44px -10px var(--glow-color)" : "none",
      }}
    >
      <div
        style={{
          margin: "0 auto 16px",
          width: 62,
          height: 62,
          display: "grid",
          placeItems: "center",
          borderRadius: 16,
          color: "#fff",
          background: "var(--grad)",
          boxShadow: "0 8px 26px -6px var(--glow-color), inset 0 1px 0 rgba(255,255,255,.4)",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 16V4m0 0L7 9m5-5l5 5M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.01em" }}>
        Drop a video, or click to choose
      </div>
      <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--txt-3)" }}>
        mp4 · mov · mkv · webm — up to 2 GB, processed locally on your machine
      </div>
      <input
        ref={input}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
