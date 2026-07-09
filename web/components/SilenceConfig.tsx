"use client";
import { Field, Slider } from "./ui";
import type { SilenceSettings } from "@/lib/settings";

export default function SilenceConfig({
  value,
  onChange,
}: {
  value: SilenceSettings;
  onChange: (v: SilenceSettings) => void;
}) {
  const set = <K extends keyof SilenceSettings>(k: K, v: SilenceSettings[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="card mt-4 p-5 animate-fade-up">
      <p className="mb-4 text-[13px] text-muted">
        No transcription — just detect and remove silent gaps. Fast and fully
        offline. Tune the three dials, then drop a video.
      </p>
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Silence threshold" right={`${value.noiseDb} dB`}>
          <Slider min={-60} max={-15} step={1} value={value.noiseDb} onChange={(v) => set("noiseDb", v)} />
          <p className="mt-1.5 text-[11.5px] text-faint">Lower = only cut quieter gaps.</p>
        </Field>
        <Field label="Min silence to cut" right={`${value.minSilence.toFixed(1)} s`}>
          <Slider min={0.2} max={3} step={0.1} value={value.minSilence} onChange={(v) => set("minSilence", v)} />
          <p className="mt-1.5 text-[11.5px] text-faint">Shortest gap worth removing.</p>
        </Field>
        <Field label="Breathing room" right={`${value.padding.toFixed(2)} s`}>
          <Slider min={0} max={0.5} step={0.05} value={value.padding} onChange={(v) => set("padding", v)} />
          <p className="mt-1.5 text-[11.5px] text-faint">Padding kept around each cut.</p>
        </Field>
      </div>
    </div>
  );
}
