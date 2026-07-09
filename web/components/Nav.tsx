"use client";
import { useEffect, useState } from "react";
import type { Mode } from "@/lib/types";

const MODES: { id: Mode; label: string }[] = [
  { id: "ai", label: "AI Edit" },
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
    <nav className="sticky top-0 z-30 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-4 px-5 py-3.5">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent-2)] to-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--glow)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 7h16M4 12h10M4 17h13"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="text-[15px]">edit<span className="text-accent">.ai</span></span>
        </div>

        <div className="flex items-center gap-3">
          <div
            className="flex gap-0.5 rounded-xl border border-line bg-surface2 p-1"
            role="tablist"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={mode === m.id}
                onClick={() => onMode(m.id)}
                className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                  mode === m.id
                    ? "bg-surface text-ink shadow-[var(--shadow)]"
                    : "text-muted hover:text-ink"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            title="Light / dark"
            className="grid h-9 w-9 place-items-center rounded-[10px] border border-line bg-surface2 text-muted hover:text-ink hover:border-line2 transition-colors"
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </div>
    </nav>
  );
}
