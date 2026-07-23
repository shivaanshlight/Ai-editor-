"use client";
import { useEffect, useState } from "react";
import type { Mode } from "@/lib/types";

const MODES: { id: Mode; label: string }[] = [
  { id: "ai", label: "AI Edit" },
  { id: "highlights", label: "Highlights" },
  { id: "clips", label: "Find Clips" },
  { id: "silence", label: "Quick Cut" },
];

export default function Nav({
  mode,
  onMode,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
}) {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const t =
      (document.documentElement.getAttribute("data-theme") as
        | "dark"
        | "light") || "dark";
    setTheme(t);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("cs-theme", next);
    } catch {}
    setTheme(next);
  };

  return (
    <nav
      className="sticky top-0 z-30 flex h-[52px] items-center gap-4 px-4"
      style={{ background: "var(--panel)", borderBottom: "1px solid var(--hair)" }}
    >
      {/* brand */}
      <div className="flex items-center gap-2.5" style={{ fontWeight: 640, letterSpacing: "-0.02em" }}>
        <span
          className="grid h-[22px] w-[22px] place-items-center text-white"
          style={{ background: "var(--grad)", borderRadius: 7 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M8 5v14l11-7z" fill="#fff" />
          </svg>
        </span>
        <span className="text-[15px]">
          edit<span style={{ color: "var(--accent)" }}>.ai</span>
        </span>
      </div>

      <span className="hidden sm:block" style={{ width: 1, height: 18, background: "var(--hair)" }} />

      {/* mode segmented control */}
      <div
        className="flex gap-0.5 p-0.5"
        role="tablist"
        style={{ background: "var(--panel-2)", border: "1px solid var(--hair)", borderRadius: 9 }}
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => onMode(m.id)}
            className="px-3 py-1 text-[12px] transition-colors"
            style={{
              fontWeight: 550,
              borderRadius: 6,
              color: mode === m.id ? "#fff" : "var(--txt-2)",
              background: mode === m.id ? "var(--accent)" : "transparent",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <button
        onClick={toggleTheme}
        aria-label="Toggle theme"
        title="Light / dark"
        className="grid h-8 w-8 place-items-center transition-colors"
        style={{ color: "var(--txt-2)", border: "1px solid var(--hair)", borderRadius: 8, background: "var(--bg-elev)" }}
      >
        {theme === "dark" ? "☾" : "☀"}
      </button>
    </nav>
  );
}
