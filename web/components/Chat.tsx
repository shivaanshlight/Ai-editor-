"use client";
import { useState } from "react";
import { askVideo } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { ChatAnswer } from "@/lib/types";

export default function Chat({
  jobId,
  ready,
  onJump,
}: {
  jobId: string;
  ready: boolean;
  onJump: (t: number) => void;
}) {
  const [q, setQ] = useState("");
  const [ans, setAns] = useState<ChatAnswer | null>(null);
  const [loading, setLoading] = useState(false);

  if (!ready) return null;

  const ask = async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setAns(null);
    try {
      const r = await askVideo(jobId, query);
      setAns(r as ChatAnswer);
    } catch (e: any) {
      setAns({ answer: "", citations: [], error: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="text-[16px] font-semibold">Ask your video</h3>
      <p className="mt-1 text-[13px] text-muted">
        Ask anything — “what did they say about pricing?” — and jump straight to
        the answer.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          className="input"
          placeholder="Ask a question about this video…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
        />
        <button className="btn btn-primary" disabled={loading || !q.trim()} onClick={ask}>
          {loading ? "Thinking…" : "Ask"}
        </button>
      </div>

      {ans && (
        <div className="mt-3 animate-fade-up rounded-2xl border border-line bg-surface2 p-4">
          {ans.error ? (
            <p className="text-[13px] text-cut">{ans.error}</p>
          ) : ans.indexing ? (
            <p className="text-[13px] text-muted">Still building the index — try again in a moment.</p>
          ) : (
            <>
              <p className="text-[14px] leading-relaxed">{ans.answer}</p>
              {ans.citations?.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5">
                  {ans.citations.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => onJump(c.start)}
                      className="flex items-baseline gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left text-[12.5px] hover:border-[var(--accent-2)]"
                    >
                      <span className="mono flex-none text-[11.5px] text-accent2">{fmt(c.start)}</span>
                      <span className="text-muted">“{c.quote}”</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
