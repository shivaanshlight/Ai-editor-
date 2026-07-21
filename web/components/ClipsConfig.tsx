"use client";
import { Toggle, Field, Select } from "./ui";
import type { ClipsSettings } from "@/lib/settings";

export default function ClipsConfig({
  value,
  onChange,
}: {
  value: ClipsSettings;
  onChange: (v: ClipsSettings) => void;
}) {
  const set = <K extends keyof ClipsSettings>(k: K, v: ClipsSettings[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="card mt-4 p-5 animate-fade-up">
      <textarea
        className="input"
        placeholder="Optional: what should the clips be about? e.g. 'moments about money and career advice' — leave empty for the overall best moments."
        value={value.instruction}
        onChange={(e) => set("instruction", e.target.value)}
      />
      <div className="mt-3 grid gap-3.5 sm:grid-cols-3">
        <Field label="How many clips">
          <Select
            value={value.clipCount}
            onChange={(v) => set("clipCount", v)}
            options={[
              { value: "auto", label: "Auto (best 3–8)" },
              { value: "3", label: "3" },
              { value: "5", label: "5" },
              { value: "8", label: "8" },
            ]}
          />
        </Field>
        <Field label="Clip length (approx)">
          <Select
            value={value.clipLen}
            onChange={(v) => set("clipLen", v)}
            options={[
              { value: "30", label: "~30 s" },
              { value: "60", label: "~60 s" },
              { value: "90", label: "~90 s" },
              { value: "120", label: "~2 min" },
            ]}
          />
        </Field>
        <Field label="Captions">
          <Select
            value={value.captionStyle}
            onChange={(v) => set("captionStyle", v as ClipsSettings["captionStyle"])}
            options={[
              { value: "none", label: "No captions" },
              { value: "bold", label: "Karaoke — word highlight" },
              { value: "clean", label: "Clean — small, bottom" },
            ]}
          />
        </Field>
      </div>

      <div className="mt-4 grid gap-x-5 gap-y-2.5 border-t border-line pt-4 sm:grid-cols-2">
        <Toggle label="Vertical 9:16" checked={value.vertical} onChange={(v) => set("vertical", v)} />
        <Toggle label="Enhance audio" hint="denoise + level" checked={value.enhanceAudio} onChange={(v) => set("enhanceAudio", v)} />
        <Toggle label="Detect speakers" hint="diarization" checked={value.diarize} onChange={(v) => set("diarize", v)} />
        <Toggle label="Auto-reframe to speaker" hint="needs speakers + vertical" checked={value.autoReframe} onChange={(v) => set("autoReframe", v)} />
        <Toggle label="Punch-in zooms" checked={value.punchIn} onChange={(v) => set("punchIn", v)} />
        <Toggle label="Choose clips before render" checked={value.review} onChange={(v) => set("review", v)} />
        <Toggle label="Draft quality" hint="fast preview" checked={value.draft} onChange={(v) => set("draft", v)} />
      </div>

      <p className="mt-3 text-[12.5px] text-faint">
        Long videos welcome — audio is transcribed in 20-minute chunks, so
        multi-hour podcasts work.
      </p>
    </div>
  );
}
