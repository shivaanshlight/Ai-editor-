"use client";
import { Toggle, Field, Select } from "./ui";
import type { HighlightsSettings } from "@/lib/settings";

export default function HighlightsConfig({
  value,
  onChange,
}: {
  value: HighlightsSettings;
  onChange: (v: HighlightsSettings) => void;
}) {
  const set = <K extends keyof HighlightsSettings>(k: K, v: HighlightsSettings[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="card mt-4 p-5 animate-fade-up">
      <div className="flex items-start gap-3">
        <div
          className="grid h-9 w-9 flex-none place-items-center rounded-xl text-white"
          style={{
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            boxShadow: "0 0 18px -3px rgba(55,224,255,.7)",
          }}
        >
          🎬
        </div>
        <div>
          <h3 className="text-[15px] font-semibold">Condense the whole video into one highlights cut</h3>
          <p className="mt-0.5 text-[13px] text-muted">
            The AI watches the entire recording and keeps only the best moments,
            stitched into a single watchable episode.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
        <Field label="How long should the highlights be?" right={`${value.targetMinutes} min`}>
          <input
            type="range"
            min={2}
            max={60}
            step={1}
            value={value.targetMinutes}
            onChange={(e) => set("targetMinutes", parseInt(e.target.value))}
          />
          <p className="mt-1.5 text-[11.5px] text-faint">
            Target runtime of the finished recap — the AI aims for roughly this.
          </p>
        </Field>
        <Field label="Captions">
          <Select
            value={value.captionStyle}
            onChange={(v) => set("captionStyle", v as HighlightsSettings["captionStyle"])}
            options={[
              { value: "none", label: "No captions" },
              { value: "clean", label: "Clean — small, bottom" },
              { value: "bold", label: "Karaoke — word highlight" },
              { value: "soft", label: "Soft track — selectable" },
            ]}
          />
        </Field>
      </div>

      <div className="mt-4 grid gap-x-5 gap-y-2.5 border-t border-line pt-4 sm:grid-cols-2">
        <Toggle label="Cut filler words" hint="um, uh" checked={value.fillerRemoval} onChange={(v) => set("fillerRemoval", v)} />
        <Toggle label="Shrink long pauses" checked={value.shrinkPauses} onChange={(v) => set("shrinkPauses", v)} />
        <Toggle label="Review before render" checked={value.review} onChange={(v) => set("review", v)} />
        <Toggle label="Draft quality" hint="fast preview" checked={value.draft} onChange={(v) => set("draft", v)} />
      </div>
    </div>
  );
}
