"use client";
import { useState } from "react";
import { Slider } from "./ui";
import { SILENCE_PRESETS, type SilenceSettings } from "@/lib/settings";

type PresetKey = "gentle" | "balanced" | "aggressive";

const PRESET_META: { key: PresetKey; label: string; icon: string; recommended?: boolean }[] = [
  { key: "gentle", label: "Gentle", icon: "🍃" },
  { key: "balanced", label: "Balanced", icon: "⚖️", recommended: true },
  { key: "aggressive", label: "Aggressive", icon: "⚡" },
];

// Turn the raw dB threshold into words a normal person understands.
function quietWords(db: number): string {
  if (db <= -44) return "only near-silent gaps";
  if (db <= -33) return "clearly quiet gaps";
  if (db <= -26) return "quiet gaps and soft mumbling";
  return "even quiet talking (very aggressive)";
}

export default function SilenceConfig({
  value,
  onChange,
}: {
  value: SilenceSettings;
  onChange: (v: SilenceSettings) => void;
}) {
  const [advanced, setAdvanced] = useState(false);

  const applyPreset = (key: PresetKey) => {
    const p = SILENCE_PRESETS[key];
    onChange({ preset: key, noiseDb: p.noiseDb, minSilence: p.minSilence, padding: p.padding });
  };
  const setDial = <K extends "noiseDb" | "minSilence" | "padding">(k: K, v: number) =>
    onChange({ ...value, preset: "custom", [k]: v });

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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 10v4m4-8v12m4-14v16m4-12v8m4-6v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <h3 className="text-[15px] font-semibold">How aggressively should I cut the silence?</h3>
          <p className="mt-0.5 text-[13px] text-muted">
            Quick Cut finds the silent gaps in your video and removes them — no AI, no
            waiting. Just pick a style below.
          </p>
        </div>
      </div>

      {/* preset cards */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {PRESET_META.map((p) => {
          const active = value.preset === p.key;
          return (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={`relative rounded-2xl border p-4 text-left transition-all ${
                active
                  ? "border-[var(--accent-2)] bg-[var(--mix-bg)] shadow-[0_0_26px_-8px_rgba(55,224,255,.6)]"
                  : "border-line bg-surface2 hover:border-line2"
              }`}
            >
              {p.recommended && (
                <span className="absolute right-3 top-3 rounded-full border border-[var(--keep-line)] bg-[var(--keep-bg)] px-2 py-[1px] text-[10px] font-semibold text-keep">
                  Recommended
                </span>
              )}
              <div className="text-[22px]">{p.icon}</div>
              <div className="mt-1.5 text-[15px] font-semibold">{p.label}</div>
              <div className="mt-1 text-[12.5px] leading-snug text-muted">
                {SILENCE_PRESETS[p.key].blurb}
              </div>
            </button>
          );
        })}
      </div>

      {value.preset === "custom" && (
        <p className="mt-3 text-[12.5px] text-accent2">Using your own custom settings.</p>
      )}

      {/* advanced */}
      <button
        onClick={() => setAdvanced((a) => !a)}
        className="mt-4 flex items-center gap-1.5 text-[12.5px] font-medium text-muted hover:text-ink"
      >
        <span className={`transition-transform ${advanced ? "rotate-90" : ""}`}>▸</span>
        Advanced settings
      </button>

      {advanced && (
        <div className="mt-3 grid gap-5 rounded-2xl border border-line bg-surface2 p-4 sm:grid-cols-3 animate-fade-up">
          <div>
            <label className="label">How quiet counts as “silence”</label>
            <Slider min={-60} max={-15} step={1} value={value.noiseDb} onChange={(v) => setDial("noiseDb", v)} />
            <p className="mt-1.5 text-[11.5px] text-faint">
              Currently cuts <b className="text-muted">{quietWords(value.noiseDb)}</b>.
            </p>
          </div>
          <div>
            <label className="label">Ignore pauses shorter than</label>
            <Slider min={0.2} max={3} step={0.1} value={value.minSilence} onChange={(v) => setDial("minSilence", v)} />
            <p className="mt-1.5 text-[11.5px] text-faint">
              Only pauses longer than <b className="text-muted">{value.minSilence.toFixed(1)}s</b> get cut.
            </p>
          </div>
          <div>
            <label className="label">Breath left around each cut</label>
            <Slider min={0} max={0.5} step={0.05} value={value.padding} onChange={(v) => setDial("padding", v)} />
            <p className="mt-1.5 text-[11.5px] text-faint">
              Leaves <b className="text-muted">{value.padding.toFixed(2)}s</b> of air so cuts don’t feel abrupt.
            </p>
          </div>
        </div>
      )}

      <p className="mt-4 text-[12.5px] text-faint">
        After it processes, you’ll get a full timeline to fine-tune every cut before exporting.
      </p>
    </div>
  );
}
