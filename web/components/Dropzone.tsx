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
      className={`glass mt-6 cursor-pointer rounded-[22px] border-[1.5px] border-dashed px-5 py-14 text-center transition-all ${
        over
          ? "scale-[1.006] border-[var(--accent-2)] shadow-[0_0_44px_-8px_rgba(55,224,255,.6)]"
          : "border-line2 hover:border-[var(--accent-2)] hover:shadow-[0_0_36px_-14px_rgba(55,224,255,.55)]"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <div
        className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl text-white"
        style={{
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          boxShadow: "0 0 30px -4px rgba(55,224,255,.7), inset 0 1px 0 rgba(255,255,255,.45)",
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
      <div className="text-[17px] font-semibold">Drop a video, or click to choose</div>
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
