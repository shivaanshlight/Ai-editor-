"use client";
import { useRef, useState } from "react";
import { searchMoments } from "@/lib/api";
import { fmt } from "@/lib/format";

export default function Search({
  jobId,
  ready,
  onJump,
}: {
  jobId: string;
  ready: boolean;
  onJump: (t: number) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!ready) return null;

  const run = async (query: string) => {
    if (!query.trim()) {
      setResults([]);
      setMsg("");
      return;
    }
    setMsg("Searching…");
    try {
      const d = await searchMoments(jobId, query);
      if (d.indexing) {
        setMsg("Building the search index… try again in a moment.");
        setResults([]);
      } else if (d.error) {
        setMsg(d.error);
        setResults([]);
      } else if (!d.results?.length) {
        setMsg("No matching moments.");
        setResults([]);
      } else {
        setMsg("");
        setResults(d.results);
      }
    } catch {
      setMsg("Search unavailable.");
    }
  };

  return (
    <div className="mt-4">
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-3.2-3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <input
          className="input !pl-10"
          placeholder='Find a moment by meaning — e.g. "the part about pricing"'
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => run(e.target.value), 300);
          }}
        />
      </div>
      {msg && <div className="mt-2 px-1 text-[12.5px] text-faint">{msg}</div>}
      {results.length > 0 && (
        <div className="mt-2 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {results.map((m, i) => (
            <button
              key={i}
              onClick={() => onJump(m.start_s)}
              className="flex items-baseline gap-3 rounded-[9px] border border-line bg-surface2 px-3 py-2.5 text-left text-[13px] hover:border-[var(--accent)]"
            >
              <span className="mono flex-none text-[11.5px] text-accent">
                {fmt(m.start_s)}
              </span>
              <span className="leading-snug text-muted">
                {(m.text || "").slice(0, 160)}…
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
