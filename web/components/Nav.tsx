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
    <nav className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-4 px-5 py-3.5">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span
            className="grid h-8 w-8 place-items-center rounded-xl text-white"
            style={{
              background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
              boxShadow: "0 0 18px -2px rgba(55,224,255,.75), inset 0 1px 0 rgba(255,255,255,.4)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 7h16M4 12h10M4 17h13" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[16px]">
            edit<span className="text-accent2">.ai</span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="glass flex gap-0.5 rounded-2xl p-1" role="tablist">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={mode === m.id}
                onClick={() => onMode(m.id)}
                className={`rounded-xl px-3.5 py-1.5 text-[13px] font-medium transition-all ${
                  mode === m.id ? "text-white" : "text-muted hover:text-ink"
                }`}
                style={
                  mode === m.id
                    ? {
                        background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                        boxShadow: "0 0 16px -3px rgba(55,224,255,.7)",
                      }
                    : undefined
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            title="Light / dark"
            className="glass grid h-9 w-9 place-items-center rounded-xl text-muted transition-colors hover:text-ink"
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </div>
    </nav>
  );
}
