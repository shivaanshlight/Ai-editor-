"use client";
// The Transcript Workspace — the production review screen (Pro design):
// video preview tied to transcript lines, thought-unit keep/cut/lock, and a
// live deterministic Edit Report Card. Strength scores & server linting plug
// in when the M1 engine lands (WUnit.score / findings already have slots).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, Segment } from "@/lib/types";
import { fmt } from "@/lib/format";
import { sourceUrl } from "@/lib/api";
import {
  toUnits,
  initialState,
  unitStatus,
  buildIncluded,
  computeCard,
  type WUnit,
  type WState,
} from "@/lib/workspace";

/* ---------- small bits ---------- */

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full border px-2 py-[1px] text-[10.5px] font-semibold ${
        ok
          ? "border-[var(--keep-line)] bg-[var(--keep-bg)] text-keep"
          : "border-[var(--cut-line)] bg-[var(--cut-bg)] text-cut"
      }`}
    >
      {children}
    </span>
  );
}

function Lock({ on }: { on: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      {on ? (
        <path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2" />
      ) : (
        <path d="M8 10V7a4 4 0 017.5-1.5" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  );
}

/* ---------- main ---------- */

export default function Workspace({
  job,
  onRender,
}: {
  job: Job;
  onRender: (
    included: Segment[],
    wordEdits: Record<number, string>,
    speakerNames?: Record<string, string>,
  ) => void;
}) {
  const units = useMemo(() => toUnits(job.reviewBlocks || []), [job.reviewBlocks]);
  const [st, setSt] = useState<WState>(() => initialState(units));
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [names, setNames] = useState<Record<string, string>>(job.speakerNames || {});
  const [phrase, setPhrase] = useState("");
  const [phraseMsg, setPhraseMsg] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isDemo = job.id === "demo";

  useEffect(() => {
    setSt(initialState(units));
    setEdits({});
  }, [units]);

  const card = useMemo(
    () => computeCard(units, st, job.duration, job.chapters),
    [units, st, job.duration, job.chapters],
  );
  const included = useMemo(() => buildIncluded(units, st), [units, st]);
  const findingsByUnit = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of card.findings) if (f.unitId >= 0) m.set(f.unitId, f.msg);
    return m;
  }, [card.findings]);

  /* ---------- state ops (locks respected everywhere) ---------- */

  const mutate = (fn: (n: WState) => void) =>
    setSt((prev) => {
      const n: WState = {
        cutWords: new Set(prev.cutWords),
        cutSilence: new Set(prev.cutSilence),
        locked: new Set(prev.locked),
      };
      fn(n);
      return n;
    });

  const toggleUnit = (u: WUnit) => {
    if (st.locked.has(u.id)) return;
    mutate((n) => {
      if (u.silence) {
        n.cutSilence.has(u.id) ? n.cutSilence.delete(u.id) : n.cutSilence.add(u.id);
        return;
      }
      const anyKept = u.words.some((w) => !n.cutWords.has(w.i));
      for (const w of u.words) anyKept ? n.cutWords.add(w.i) : n.cutWords.delete(w.i);
    });
  };
  const toggleWord = (u: WUnit, i: number) => {
    if (st.locked.has(u.id)) return;
    mutate((n) => {
      n.cutWords.has(i) ? n.cutWords.delete(i) : n.cutWords.add(i);
    });
  };
  const toggleLock = (u: WUnit) =>
    mutate((n) => {
      if (n.locked.has(u.id)) n.locked.delete(u.id);
      else {
        n.locked.add(u.id);
        // locking a unit restores it — a lock means "must keep"
        if (u.silence) n.cutSilence.delete(u.id);
        else for (const w of u.words) n.cutWords.delete(w.i);
      }
    });
  const resetToAi = () => setSt(initialState(units));

  const seek = (t: number) => {
    setActiveId(units.find((u) => t >= u.start && t < u.end)?.id ?? null);
    if (videoRef.current && !isDemo) {
      try {
        videoRef.current.currentTime = t;
      } catch {}
    }
  };

  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const cutPhrase = () => {
    const tokens = phrase.trim().toLowerCase().split(/\s+/).map(norm).filter(Boolean);
    if (!tokens.length) return;
    // skip punctuation-only tokens so "thanks for — thanks" still matches "thanks for"
    const flat: { i: number; n: string; uid: number }[] = [];
    for (const u of units)
      for (const w of u.words) {
        const n = norm(w.w);
        if (n) flat.push({ i: w.i, n, uid: u.id });
      }
    // compute matches OUTSIDE the state updater (updaters must stay pure)
    let matches = 0;
    const hits: number[] = [];
    for (let k = 0; k + tokens.length <= flat.length; k++) {
      let ok = true;
      for (let j = 0; j < tokens.length; j++)
        if (flat[k + j].n !== tokens[j]) { ok = false; break; }
      if (ok && !st.locked.has(flat[k].uid)) {
        matches++;
        for (let j = 0; j < tokens.length; j++) hits.push(flat[k + j].i);
      }
    }
    if (matches) mutate((n) => { for (const i of hits) n.cutWords.add(i); });
    setPhraseMsg(matches ? `Cut ${matches} time${matches === 1 ? "" : "s"}.` : `No matches for “${phrase.trim()}”.`);
  };

  /* ---------- chapter grouping ---------- */
  const groups = useMemo(() => {
    const chs = job.chapters?.length
      ? job.chapters
      : [{ start: 0, end: job.duration, title: "Transcript" }];
    return chs.map((c) => ({
      title: c.title,
      units: units.filter((u) => u.start >= c.start - 0.5 && u.start < c.end),
    }));
  }, [units, job.chapters, job.duration]);

  const allClear = card.checks.every((c) => c.ok);
  const activeUnit = units.find((u) => u.id === activeId) || null;

  return (
    <div className="animate-fade-up">
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* ============ left: preview + transcript ============ */}
        <div className="min-w-0">
          {/* preview strip */}
          <div className="glass flex items-center gap-3.5 rounded-2xl p-3">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              src={isDemo ? undefined : sourceUrl(job.id)}
              className="h-[92px] w-[164px] flex-none rounded-xl border border-line bg-black object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="mono text-[11px] uppercase tracking-[0.1em] text-faint">
                {activeUnit ? `Previewing · ${fmt(activeUnit.start)}` : "Click a line to preview it"}
              </div>
              <p className="mt-1 line-clamp-2 text-[13.5px] leading-snug text-muted">
                {activeUnit ? activeUnit.text : "The player follows the transcript — every line seeks the source video to that moment."}
              </p>
            </div>
          </div>

          {/* transcript */}
          <div className="mt-3 flex items-baseline justify-between px-1">
            <span className="text-[13px] font-semibold">Transcript</span>
            <span className="text-[12px] text-faint">
              click a line to preview · checkbox keeps/cuts · click a word for word-level cuts · double-click a word to fix it
            </span>
          </div>

          <div className="mt-2 flex max-h-[560px] flex-col gap-4 overflow-y-auto pr-1">
            {groups.map((g) => {
              const kept = g.units.filter((u) => !u.silence && unitStatus(u, st) !== "cut").length;
              const total = g.units.filter((u) => !u.silence).length;
              return (
                <div key={g.title}>
                  <div className="mb-1.5 flex items-baseline justify-between px-1">
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">{g.title}</span>
                    <span className="mono text-[11px] text-faint">{kept}/{total} kept</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {g.units.map((u) => {
                      const status = unitStatus(u, st);
                      const cut = status === "cut";
                      const locked = st.locked.has(u.id);
                      const finding = findingsByUnit.get(u.id);
                      return (
                        <div
                          key={u.id}
                          onClick={() => seek(u.start)}
                          className={`group flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-all ${
                            u.id === activeId
                              ? "border-[var(--accent-2)] bg-[var(--mix-bg)]"
                              : "border-line bg-surface2 hover:border-line2"
                          } ${cut ? "opacity-45" : ""} ${status === "mixed" ? "border-l-[3px] border-l-[var(--accent)]" : ""}`}
                        >
                          <span className="mono mt-[2px] w-10 flex-none text-[11px] text-faint">{fmt(u.start)}</span>
                          <div className="min-w-0 flex-1">
                            {u.silence ? (
                              <em className="text-[13px] text-faint">(silence · {(u.end - u.start).toFixed(1)}s)</em>
                            ) : (
                              <p className={`text-[14px] leading-relaxed ${cut ? "line-through" : ""}`}>
                                {u.words.map((w, k) => (
                                  <span key={w.i}>
                                    <span
                                      className={`word ${st.cutWords.has(w.i) ? "cut" : ""} ${edits[w.i] ? "edited" : ""}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleWord(u, w.i);
                                      }}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        const nv = prompt("Fix this word:", edits[w.i] ?? w.w);
                                        if (nv !== null && nv.trim())
                                          setEdits((p) => ({ ...p, [w.i]: nv.trim() }));
                                      }}
                                    >
                                      {edits[w.i] ?? w.w}
                                    </span>
                                    {k < u.words.length - 1 ? " " : ""}
                                  </span>
                                ))}
                              </p>
                            )}
                            {(u.flags.length > 0 || finding) && (
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {u.flags.map((f) => (
                                  <span key={f} className="rounded-md border border-[var(--cut-line)] bg-[var(--cut-bg)] px-1.5 text-[10.5px] text-cut">{f}</span>
                                ))}
                                {finding && (
                                  <span className="rounded-md border border-[var(--mix-line)] bg-[var(--mix-bg)] px-1.5 text-[10.5px] text-accent2">⚠ {finding}</span>
                                )}
                              </div>
                            )}
                          </div>
                          <button
                            title={locked ? "Unlock" : "Lock — must keep"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleLock(u);
                            }}
                            className={`mt-[2px] flex-none rounded-md p-1 transition-opacity ${
                              locked ? "text-accent2 opacity-100" : "text-faint opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            <Lock on={locked} />
                          </button>
                          <input
                            type="checkbox"
                            checked={status !== "cut"}
                            disabled={locked}
                            onChange={() => toggleUnit(u)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-[3px] h-[16px] w-[16px] flex-none cursor-pointer accent-[var(--accent)]"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* floating action bar */}
          <div className="glass sticky bottom-3 mt-4 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
            <span className="mono text-[12.5px] text-muted">
              keeping <b className="text-ink">{fmt(card.runtime)}</b> of {fmt(job.duration)} · {card.cuts} cuts · {card.cutsPerMin.toFixed(1)}/min
            </span>
            <span className="ml-auto flex gap-2">
              <button className="btn btn-sm" onClick={resetToAi}>Reset to AI plan</button>
              <button
                className="btn btn-primary"
                disabled={!included.length}
                onClick={() => onRender(included, edits, names)}
              >
                Render video
              </button>
            </span>
          </div>
        </div>

        {/* ============ right rail: report card ============ */}
        <div className="min-w-0">
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[15px] font-semibold">Edit Report Card</h3>
              <Badge ok={allClear}>{allClear ? "All clear" : "Findings"}</Badge>
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-faint">
              Deterministic checks on your current selection — updates live with every change.
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-line bg-surface2 px-3 py-2.5">
                <div className="mono text-[19px] font-semibold">{card.keptPct}%</div>
                <div className="text-[10.5px] uppercase tracking-wide text-faint">material kept</div>
              </div>
              <div className="rounded-xl border border-line bg-surface2 px-3 py-2.5">
                <div className="mono text-[19px] font-semibold text-accent2">{fmt(card.runtime)}</div>
                <div className="text-[10.5px] uppercase tracking-wide text-faint">est. runtime</div>
              </div>
              <div className="rounded-xl border border-line bg-surface2 px-3 py-2.5">
                <div className="mono text-[19px] font-semibold text-keep">
                  {card.firstKeptAt === null ? "—" : fmt(card.firstKeptAt)}
                </div>
                <div className="text-[10.5px] uppercase tracking-wide text-faint">opens at (source)</div>
              </div>
              <div className="rounded-xl border border-line bg-surface2 px-3 py-2.5">
                <div className="mono text-[19px] font-semibold">{card.cutsPerMin.toFixed(1)}<span className="text-[11px] text-faint"> /min</span></div>
                <div className="text-[10.5px] uppercase tracking-wide text-faint">cut rate</div>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2">
              {card.checks.map((c) => (
                <div key={c.label} className="flex items-start justify-between gap-2.5 rounded-xl border border-line bg-surface2 px-3 py-2.5">
                  <div>
                    <div className="text-[12.5px] font-semibold">{c.label}</div>
                    <div className="text-[11.5px] text-muted">{c.detail}</div>
                  </div>
                  <Badge ok={c.ok}>{c.ok ? "clean" : "check"}</Badge>
                </div>
              ))}
            </div>

            {card.coverage.length > 0 && (
              <div className="mt-3 rounded-xl border border-line bg-surface2 px-3 py-2.5">
                <div className="mb-2 text-[12.5px] font-semibold">Topic coverage</div>
                <div className="flex flex-col gap-2">
                  {card.coverage.map((c) => (
                    <div key={c.title}>
                      <div className="flex justify-between text-[11px] text-muted">
                        <span className="truncate pr-2">{c.title}</span>
                        <span className="mono flex-none">{c.kept}/{c.total}</span>
                      </div>
                      <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--line)_60%,transparent)]">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${c.total ? (c.kept / c.total) * 100 : 0}%`,
                            background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* tools */}
          <div className="glass mt-3 rounded-2xl p-4">
            <div className="text-[12.5px] font-semibold">Cut a repeated word or phrase</div>
            <div className="mt-2 flex gap-2">
              <input
                className="input !py-2 text-[13px]"
                placeholder='e.g. "you know"'
                value={phrase}
                onChange={(e) => { setPhrase(e.target.value); setPhraseMsg(""); }}
                onKeyDown={(e) => e.key === "Enter" && cutPhrase()}
              />
              <button className="btn btn-sm" disabled={!phrase.trim()} onClick={cutPhrase}>Cut all</button>
            </div>
            {phraseMsg && <p className="mt-1.5 text-[11.5px] text-accent2">{phraseMsg}</p>}
          </div>

          {(job.speakerLabels?.length ?? 0) > 0 && (
            <div className="glass mt-3 rounded-2xl p-4">
              <div className="text-[12.5px] font-semibold">Name your speakers</div>
              <p className="mt-0.5 text-[11.5px] text-faint">Shown as on-screen name tags in the render.</p>
              <div className="mt-2 flex flex-col gap-2">
                {job.speakerLabels!.map((label) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="mono w-16 flex-none text-[11px] text-faint">{label}</span>
                    <input
                      className="input !py-2 text-[13px]"
                      placeholder="e.g. Dev Rao"
                      value={names[label] || ""}
                      onChange={(e) => setNames((p) => ({ ...p, [label]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
