"use client";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Segment } from "@/lib/types";

type Gain = { start: number; end: number; db: number };
type Word = { s: number; e: number; w: string };

/**
 * Live, non-destructive preview — the way a real NLE plays an edit without
 * rendering. Drives the <video> element (playing the ORIGINAL source):
 *   • CUTS   — while playing, skip straight over any moment not in `keeps`.
 *   • VOLUME — route audio through a Web Audio gain node and set it per clip
 *              from `gains`, so dragging the waveform changes volume instantly.
 *   • CAPTIONS — report the words at the playhead so the caller can overlay them.
 * Nothing is rendered; the MP4 is only produced on Export.
 */
export function useLivePreview(
  videoRef: RefObject<HTMLVideoElement>,
  keeps: Segment[],
  gains: Gain[],
  words: Word[],
  enabled: boolean,
  onCaption: (text: string) => void,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  // latest values, read inside the rAF loop without re-subscribing it
  const st = useRef({ keeps, gains, words, enabled });
  st.current = { keeps, gains, words, enabled };

  // Build the audio graph ONCE per <video> element (createMediaElementSource
  // can only ever be called once for a given element).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const AC: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const existing = (v as any)._liveGraph;
    if (existing) {
      ctxRef.current = existing.ctx;
      gainRef.current = existing.gain;
    } else {
      try {
        const ctx = new AC();
        const src = ctx.createMediaElementSource(v);
        const gain = ctx.createGain();
        src.connect(gain).connect(ctx.destination);
        (v as any)._liveGraph = { ctx, gain };
        ctxRef.current = ctx;
        gainRef.current = gain;
      } catch {
        /* already connected / unsupported — fall back to element's own audio */
      }
    }
    const resume = () => ctxRef.current?.resume().catch(() => {});
    v.addEventListener("play", resume);
    return () => v.removeEventListener("play", resume);
  }, [videoRef]);

  // Per-frame: skip cuts, apply gain, report caption.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const factor = (db: number) => Math.pow(10, db / 20);
    const loop = () => {
      const { keeps, gains, words, enabled } = st.current;
      if (enabled && keeps.length) {
        const t = v.currentTime;
        let inKeep = false;
        for (const s of keeps) {
          if (t >= s.start - 0.04 && t < s.end) {
            inKeep = true;
            break;
          }
        }
        if (!inKeep && !v.paused) {
          const next = keeps.find((s) => s.start > t - 0.04);
          if (next) v.currentTime = next.start;
          else v.pause();
        }
        // volume for the current clip
        let db = 0;
        for (const g of gains) {
          if (t >= g.start && t <= g.end) {
            db = g.db;
            break;
          }
        }
        if (gainRef.current) gainRef.current.gain.value = factor(db);
        // caption: a short rolling phrase ending at the current word
        // (kept inside the enabled branch)
        let cap = "";
        for (let i = 0; i < words.length; i++) {
          if (t >= words[i].s && t <= words[i].e + 0.1) {
            const lo = Math.max(0, i - 5);
            cap = words
              .slice(lo, i + 1)
              .map((x) => x.w)
              .join(" ")
              .trim();
            break;
          }
        }
        onCaption(cap);
      } else if (gainRef.current && gainRef.current.gain.value !== 1) {
        // rendered mode: audio already has gain baked in — keep the graph flat
        gainRef.current.gain.value = 1;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [videoRef, onCaption]);
}
