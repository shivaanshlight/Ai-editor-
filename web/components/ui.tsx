"use client";
import React from "react";

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none group">
      <span
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        className={`relative h-[22px] w-[38px] flex-none rounded-full border transition-colors ${
          checked ? "border-transparent" : "border-line2"
        }`}
        style={{ background: checked ? "var(--accent)" : "var(--bg-elev)" }}
      >
        <span
          className={`absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white transition-all ${
            checked ? "left-[19px]" : "left-[2px]"
          }`}
          style={{ boxShadow: "0 1px 2px rgba(0,0,0,.35)" }}
        />
      </span>
      <span className="text-[13.5px] text-muted group-hover:text-ink transition-colors">
        {label}
        {hint && <span className="text-faint"> · {hint}</span>}
      </span>
    </label>
  );
}

export function Field({
  label,
  children,
  right,
}: {
  label: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {right && <span className="mono text-[12px] text-accent">{right}</span>}
      </div>
      {children}
    </div>
  );
}

export function Slider({
  min,
  max,
  step,
  value,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="input cursor-pointer"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className={`btn btn-sm btn-ghost !py-1 !px-2.5 text-[12px] ${
        done ? "!text-keep !border-[var(--keep-line)]" : ""
      }`}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}
