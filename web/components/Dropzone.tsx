"use client";
import { useRef, useState } from "react";

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
        if (!disabled && (e.key === "Enter" || e.key === " "))
          input.current?.click();
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
      className={`mt-6 cursor-pointer rounded-2xl border-[1.5px] border-dashed bg-surface px-5 py-12 text-center transition-all ${
        over
          ? "border-[var(--accent)] bg-[var(--mix-bg)] scale-[1.005]"
          : "border-line2 hover:border-[var(--accent)]"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface2 text-accent">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 16V4m0 0L7 9m5-5l5 5M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="text-[16px] font-semibold">Drop a video, or click to choose</div>
      <div className="mt-1.5 text-[12.5px] text-faint">
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
