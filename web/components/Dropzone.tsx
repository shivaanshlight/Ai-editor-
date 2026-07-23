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
        borderRadius: 12,
        border: "1px dashed " + (over ? "var(--accent)" : "var(--hair-2)"),
        background: over ? "var(--accent-soft)" : "var(--panel)",
        padding: "40px 24px",
        textAlign: "center",
        transition: "border-color .15s, background .15s",
      }}
    >
      <div
        style={{
          margin: "0 auto 14px",
          width: 48,
          height: 48,
          display: "grid",
          placeItems: "center",
          borderRadius: 11,
          color: "var(--accent)",
          background: "var(--accent-soft)",
          border: "1px solid var(--hair)",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 16V4m0 0L7 9m5-5l5 5M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div style={{ fontSize: 15, fontWeight: 620, letterSpacing: "-.01em" }}>
        Drop a video, or click to choose
      </div>
      <div style={{ marginTop: 5, fontSize: 12, color: "var(--txt-3)" }}>
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
