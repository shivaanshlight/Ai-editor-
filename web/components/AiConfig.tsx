"use client";
import { useState } from "react";
import { Toggle, Field, Select, Slider } from "./ui";
import { PRESETS, type AiSettings } from "@/lib/settings";

export default function AiConfig({
  value,
  onChange,
  onMusic,
}: {
  value: AiSettings;
  onChange: (v: AiSettings) => void;
  onMusic: (f: File | null) => void;
}) {
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="card mt-4 p-5 animate-fade-up">
      <div className="mb-3.5 flex flex-wrap gap-2">
        {Object.entries(PRESETS).map(([key, p]) => (
          <button
            key={key}
            onClick={() => {
              setActivePreset(key);
              onChange({
                ...value,
                instruction: p.instruction,
                vertical: p.vertical,
                captionStyle: p.captionStyle,
                punchIn: p.punchIn,
                targetDuration: p.targetDuration,
              });
            }}
            className={`rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              activePreset === key
                ? "border-[var(--accent)] bg-[var(--mix-bg)] text-ink"
                : "border-line bg-surface2 text-muted hover:text-ink hover:border-line2"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <textarea
        className="input"
        placeholder="Tell the editor what you want… e.g. 'Cut the rambling, keep the strongest hook, end on the demo.'"
        value={value.instruction}
        onChange={(e) => set("instruction", e.target.value)}
      />

      <div className="mt-3 grid gap-3.5 sm:grid-cols-3">
        <Field label="Target duration (sec)">
          <input
            type="number"
            min={5}
            placeholder="auto"
            className="input"
            value={value.targetDuration}
            onChange={(e) => set("targetDuration", e.target.value)}
          />
        </Field>
        <Field label="Captions">
          <Select
            value={value.captionStyle}
            onChange={(v) => set("captionStyle", v as AiSettings["captionStyle"])}
            options={[
              { value: "none", label: "No captions" },
              { value: "bold", label: "Karaoke — word highlight" },
              { value: "clean", label: "Clean — small, bottom" },
              { value: "soft", label: "Soft track — selectable" },
            ]}
          />
        </Field>
        <Field
          label="Music (optional)"
          right={`${Math.round(value.musicVol * 100)}%`}
        >
          <input
            type="file"
            accept="audio/*"
            className="input mb-2 text-[12px]"
            onChange={(e) => onMusic(e.target.files?.[0] || null)}
          />
          <Slider
            min={0.05}
            max={0.8}
            step={0.05}
            value={value.musicVol}
            onChange={(v) => set("musicVol", v)}
          />
        </Field>
      </div>

      <div className="mt-4 grid gap-x-5 gap-y-2.5 border-t border-line pt-4 sm:grid-cols-2">
        <Toggle label="Cut filler words" hint="um, uh" checked={value.fillerRemoval} onChange={(v) => set("fillerRemoval", v)} />
        <Toggle label="Shrink long pauses" checked={value.shrinkPauses} onChange={(v) => set("shrinkPauses", v)} />
        <Toggle label="Enhance audio" hint="denoise + level" checked={value.enhanceAudio} onChange={(v) => set("enhanceAudio", v)} />
        <Toggle label="Punch-in zooms on cuts" checked={value.punchIn} onChange={(v) => set("punchIn", v)} />
        <Toggle label="Detect speakers" hint="diarization" checked={value.diarize} onChange={(v) => set("diarize", v)} />
        <Toggle label="Auto-reframe to speaker" hint="needs speakers + vertical" checked={value.autoReframe} onChange={(v) => set("autoReframe", v)} />
        <Toggle label="Vertical 9:16" checked={value.vertical} onChange={(v) => set("vertical", v)} />
        <Toggle label="Review plan before render" checked={value.review} onChange={(v) => set("review", v)} />
        <Toggle label="Draft quality" hint="fast preview" checked={value.draft} onChange={(v) => set("draft", v)} />
      </div>
    </div>
  );
}
