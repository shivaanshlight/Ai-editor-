"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import type { Segment } from "@/lib/types";
import { fmt } from "@/lib/format";

export interface TlBlock {
  start: number;
  end: number;
  type: "keep" | "cut";
  words: { i: number; w: string }[];
}

type Mapping = "output" | "source";

const MIN = 0.12;

export default function Timeline({
  blocks: initialBlocks,
  origin,
  dur,
  jobDuration,
  mapping,
  versionSegs,
  videoRef,
  wordEdits,
  onWordEdit,
  onKeepsChange,
}: {
  blocks: TlBlock[];
  origin: number;
  dur: number;
  jobDuration: number;
  mapping: Mapping;
  versionSegs: Segment[];
  videoRef: RefObject<HTMLVideoElement>;
  wordEdits: Record<number, string>;
  onWordEdit: (i: number, v: string) => void;
  onKeepsChange: (keeps: Segment[]) => void;
}) {
  const [blocks, setBlocks] = useState<TlBlock[]>(initialBlocks);
  const [sel, setSel] = useState(-1);
  const [zoom, setZoom] = useState(1);
  const [phSrc, setPhSrc] = useState(origin);
  const [wrapW, setWrapW] = useState(800);
  const undo = useRef<TlBlock[][]>([]);
  const [, forceUndo] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ anchor: number; screenX: number } | null>(null);
  const scrubbing = useRef(false);
  const trim = useRef<
    | { idx: number; side: "l" | "r"; x0: number; s0: number; e0: number }
    | null
  >(null);

  // Re-seed when the parent hands a new set of blocks (new job / new clip).
  useEffect(() => {
    setBlocks(initialBlocks);
    setSel(initialBlocks.findIndex((b) => b.type === "keep"));
    setZoom(1);
    setPhSrc(origin);
    undo.current = [];
  }, [initialBlocks, origin]);

  const span = dur || jobDuration || 1;
  const base = Math.max(14, Math.min(90, wrapW / span));
  const pps = base * zoom;
  const innerW = Math.max(wrapW, span * pps);

  useEffect(() => {
    const measure = () => setWrapW((wrapRef.current?.clientWidth || 802) - 2);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // keep the parent's keep-list in sync
  useEffect(() => {
    onKeepsChange(
      blocks.filter((b) => b.type === "keep").map((b) => ({ start: b.start, end: b.end })),
    );
  }, [blocks, onKeepsChange]);

  // preserve the on-screen anchor across a zoom change
  useLayoutEffect(() => {
    if (pending.current && wrapRef.current) {
      const { anchor, screenX } = pending.current;
      wrapRef.current.scrollLeft = Math.max(0, (anchor - origin) * pps - screenX);
      pending.current = null;
    }
  }, [pps, origin]);

  /* ---------- source <-> output time ---------- */
  const srcToOut = useCallback(
    (srcT: number): number | null => {
      let acc = 0;
      for (const s of versionSegs) {
        if (srcT >= s.start && srcT <= s.end) return acc + (srcT - s.start);
        if (srcT < s.start) return acc;
        acc += s.end - s.start;
      }
      return null;
    },
    [versionSegs],
  );
  const outToSrc = useCallback(
    (t: number): number => {
      let acc = 0;
      for (const s of versionSegs) {
        const len = s.end - s.start;
        if (t <= acc + len) return s.start + (t - acc);
        acc += len;
      }
      return versionSegs.length ? versionSegs[versionSegs.length - 1].end : 0;
    },
    [versionSegs],
  );

  const setPlayhead = useCallback(
    (src: number, seek = true) => {
      const lo = origin;
      const hi = origin + span;
      const clamped = Math.max(lo, Math.min(hi, src));
      setPhSrc(clamped);
      if (seek && videoRef.current) {
        if (mapping === "source") videoRef.current.currentTime = clamped;
        else {
          const outT = srcToOut(clamped);
          if (outT !== null && isFinite(outT)) videoRef.current.currentTime = outT;
        }
      }
    },
    [origin, span, mapping, srcToOut, videoRef],
  );

  // follow the video during playback
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      if (scrubbing.current) return;
      if (mapping === "source") setPhSrc(v.currentTime);
      else if (versionSegs.length) setPhSrc(outToSrc(v.currentTime));
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [videoRef, mapping, versionSegs, outToSrc]);

  const pushUndo = () => {
    undo.current.push(blocks.map((b) => ({ ...b, words: [...b.words] })));
    if (undo.current.length > 40) undo.current.shift();
    forceUndo((n) => n + 1);
  };

  /* ---------- scrubbing ---------- */
  const onInnerPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    scrubbing.current = true;
    innerRef.current?.setPointerCapture(e.pointerId);
    const x = e.clientX - innerRef.current!.getBoundingClientRect().left;
    const src = origin + x / pps;
    setSel(blocks.findIndex((b) => src >= b.start && src <= b.end));
    setPlayhead(src);
  };
  const onInnerPointerMove = (e: React.PointerEvent) => {
    if (!scrubbing.current) return;
    const x = e.clientX - innerRef.current!.getBoundingClientRect().left;
    setPlayhead(origin + x / pps);
  };
  const endScrub = () => (scrubbing.current = false);

  /* ---------- trimming ---------- */
  const startTrim = (e: React.PointerEvent, idx: number, side: "l" | "r") => {
    e.stopPropagation();
    e.preventDefault();
    pushUndo();
    trim.current = { idx, side, x0: e.clientX, s0: blocks[idx].start, e0: blocks[idx].end };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTrimMove = (e: React.PointerEvent) => {
    const t = trim.current;
    if (!t) return;
    const dt = (e.clientX - t.x0) / pps;
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      const b = next[t.idx];
      const p = next[t.idx - 1];
      const n = next[t.idx + 1];
      const tlEnd = origin + span;
      if (t.side === "l") {
        const v = Math.max(p ? p.start + MIN : origin, Math.min(t.s0 + dt, b.end - MIN));
        b.start = v;
        if (p) p.end = v;
      } else {
        const v = Math.min(n ? n.end - MIN : tlEnd, Math.max(t.e0 + dt, b.start + MIN));
        b.end = v;
        if (n) n.start = v;
      }
      return next;
    });
  };
  const endTrim = () => (trim.current = null);

  /* ---------- split / delete / undo ---------- */
  const doSplit = () => {
    const i = blocks.findIndex((b) => phSrc > b.start + MIN && phSrc < b.end - MIN);
    if (i < 0) return;
    pushUndo();
    setBlocks((prev) => {
      const b = prev[i];
      const cutAt = Math.round(((phSrc - b.start) / (b.end - b.start)) * b.words.length);
      const left = { ...b, end: phSrc, words: b.words.slice(0, cutAt) };
      const right = { ...b, start: phSrc, words: b.words.slice(cutAt) };
      const next = [...prev];
      next.splice(i, 1, left, right);
      return next;
    });
    setSel(i + 1);
  };
  const doDelete = () => {
    if (sel < 0 || !blocks[sel]) return;
    pushUndo();
    setBlocks((prev) =>
      prev.map((b, i) =>
        i === sel ? { ...b, type: b.type === "keep" ? "cut" : "keep" } : b,
      ),
    );
  };
  const doUndo = () => {
    const snap = undo.current.pop();
    if (!snap) return;
    forceUndo((n) => n + 1);
    setBlocks(snap);
    if (sel >= snap.length) setSel(-1);
  };
  const selectSeg = (delta: number) => {
    if (!blocks.length) return;
    const next =
      sel < 0 ? (delta > 0 ? 0 : blocks.length - 1) : Math.max(0, Math.min(blocks.length - 1, sel + delta));
    setSel(next);
    setPlayhead(blocks[next].start);
  };

  const zoomTo = (z: number, anchorSrc?: number) => {
    const anchor = anchorSrc ?? phSrc;
    const screenX = (anchor - origin) * pps - (wrapRef.current?.scrollLeft || 0);
    pending.current = { anchor, screenX };
    setZoom(Math.max(1, Math.min(60, z)));
  };

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "s" || e.key === "S") doSplit();
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        doDelete();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        selectSeg(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        selectSeg(-1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") doUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind each render so closures see current state

  // ruler ticks
  const step = pps >= 60 ? 1 : pps >= 28 ? 2 : pps >= 12 ? 5 : 10;
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= span; t += step) out.push(t);
    return out;
  }, [span, step]);

  const selBlock = blocks[sel];

  return (
    <div>
      <div className="mb-2.5 mt-6 flex items-baseline gap-2.5">
        <b className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Timeline</b>
        <span className="text-[12px] text-faint">
          click or drag to scrub · trim edges · split · delete
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative overflow-x-auto rounded-xl2 border border-line bg-surface2 pb-1.5"
      >
        <div
          ref={innerRef}
          className="relative cursor-crosshair select-none"
          style={{ width: innerW }}
          onPointerDown={onInnerPointerDown}
          onPointerMove={onInnerPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const rect = innerRef.current!.getBoundingClientRect();
            const src = origin + (e.clientX - rect.left) / pps;
            zoomTo(zoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25), src);
          }}
        >
          {/* ruler */}
          <div className="relative h-[22px] border-b border-line">
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-full border-l border-line" style={{ left: t * pps }}>
                <span className="mono absolute left-1 top-[3px] text-[9.5px] text-faint">
                  {fmt(origin + t).replace(".0", "")}
                </span>
              </div>
            ))}
          </div>

          {/* track */}
          <div className="relative mt-2 h-[62px]">
            {blocks.map((b, i) => {
              const left = (b.start - origin) * pps;
              const width = Math.max((b.end - b.start) * pps, 9);
              if (b.type === "keep") {
                return (
                  <div
                    key={i}
                    onPointerDown={() => setSel(i)}
                    className={`absolute top-1 h-[54px] cursor-pointer rounded-[7px] border ${
                      i === sel
                        ? "border-[var(--accent)] outline outline-2 outline-[var(--accent)]"
                        : "border-[var(--accent)]"
                    }`}
                    style={{
                      left,
                      width,
                      background:
                        "linear-gradient(180deg, color-mix(in srgb, var(--accent) 26%, var(--surface)), var(--surface))",
                    }}
                  >
                    <div
                      data-handle="1"
                      onPointerDown={(e) => startTrim(e, i, "l")}
                      onPointerMove={onTrimMove}
                      onPointerUp={endTrim}
                      onPointerCancel={endTrim}
                      className="absolute left-0 top-0 z-[2] h-full w-3 cursor-ew-resize rounded-l-[7px]"
                      style={{ touchAction: "none" }}
                    />
                    <div
                      data-handle="1"
                      onPointerDown={(e) => startTrim(e, i, "r")}
                      onPointerMove={onTrimMove}
                      onPointerUp={endTrim}
                      onPointerCancel={endTrim}
                      className="absolute right-0 top-0 z-[2] h-full w-3 cursor-ew-resize rounded-r-[7px]"
                      style={{ touchAction: "none" }}
                    />
                  </div>
                );
              }
              return (
                <div
                  key={i}
                  onPointerDown={() => setSel(i)}
                  className={`absolute top-4 h-[30px] cursor-pointer rounded-[5px] border border-dashed border-line2 ${
                    i === sel ? "outline outline-2 outline-[var(--accent)]" : ""
                  }`}
                  style={{
                    left,
                    width,
                    background:
                      "repeating-linear-gradient(-45deg, var(--surface), var(--surface) 6px, transparent 6px, transparent 12px)",
                  }}
                />
              );
            })}
          </div>

          {/* playhead */}
          <div
            className="pointer-events-none absolute top-0 bottom-1.5 z-[3] w-[2px] bg-[var(--accent)]"
            style={{ transform: `translateX(${(phSrc - origin) * pps}px)` }}
          >
            <span className="absolute -left-[5px] top-0 border-[6px] border-transparent border-t-[var(--accent)]" />
          </div>
        </div>
      </div>

      {/* toolbar */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-sm" onClick={doSplit}>✂ Split at playhead</button>
        <button className="btn btn-sm" disabled={!selBlock} onClick={doDelete}>
          {selBlock && selBlock.type === "cut" ? "Restore segment" : "Delete segment"}
        </button>
        <button className="btn btn-sm" disabled={!undo.current.length} onClick={doUndo}>Undo</button>
        <span className="ml-1 inline-flex gap-1 border-l border-line pl-2">
          <button className="btn btn-sm min-w-[34px]" title="Zoom out" onClick={() => zoomTo(zoom / 1.6)}>−</button>
          <button className="btn btn-sm" title="Fit" onClick={() => zoomTo(1)}>Fit</button>
          <button className="btn btn-sm min-w-[34px]" title="Zoom in" onClick={() => zoomTo(zoom * 1.6)}>＋</button>
        </span>
        <span className="ml-auto text-[11px] text-faint">
          S = split · Del = delete/restore · ← → select · Ctrl+scroll to zoom
        </span>
      </div>

      {/* inspector */}
      {selBlock && (
        <div className="mt-3.5 rounded-xl2 border border-line bg-surface2 p-3.5">
          <div className="mono mb-1.5 text-[11px] text-faint">
            {fmt(selBlock.start)} → {fmt(selBlock.end)} · {selBlock.type === "keep" ? "KEPT" : "CUT"} · double-click a word to fix it
          </div>
          <div className="text-[13.5px] leading-relaxed">
            {selBlock.words.length === 0 ? (
              <em className="text-faint">(silence)</em>
            ) : (
              selBlock.words.map((w, k) => (
                <span key={w.i}>
                  <span
                    className={`word ${wordEdits[w.i] ? "edited" : ""}`}
                    onDoubleClick={() => {
                      const nv = prompt("Fix this word:", wordEdits[w.i] ?? w.w);
                      if (nv !== null && nv.trim()) onWordEdit(w.i, nv.trim());
                    }}
                  >
                    {wordEdits[w.i] ?? w.w}
                  </span>
                  {k < selBlock.words.length - 1 ? " " : ""}
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
