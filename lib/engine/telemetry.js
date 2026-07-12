/**
 * lib/engine/telemetry.js — M3 preference telemetry.
 *
 * Every review correction is a labeled example of the user's taste:
 *   - they RESTORED something the engine cut  → "don't cut things like this"
 *   - they CUT something the engine kept      → "this wasn't worth keeping"
 *
 * Corrections land in a local JSONL file (append-only, no cloud, no PII
 * beyond the user's own transcript snippets). The most recent examples are
 * fed to the S2 scorer as few-shot preference lines — cheap personalization,
 * no training run.
 */

const fs = require("fs");
const path = require("path");

const MAX_TEXT = 160;
const MAX_FILE_LINES = 400; // rotate: keep the newest N corrections

/** Diff the engine's plan against what the user actually rendered. */
function diffPlan(plannedKeeps, finalKeeps, words) {
  const corrections = [];
  const textIn = (a, b) =>
    (words || [])
      .filter((w) => w.start >= a - 0.05 && w.end <= b + 0.05)
      .map((w) => w.word)
      .join(" ")
      .trim()
      .slice(0, MAX_TEXT);
  const covered = (t, list) => list.some((s) => t >= s.start - 0.05 && t <= s.end + 0.05);

  // restored: time kept now that the plan had cut
  for (const k of finalKeeps) {
    const mid = (k.start + k.end) / 2;
    if (!covered(mid, plannedKeeps)) {
      const text = textIn(k.start, k.end);
      if (text) corrections.push({ action: "restored", text, at: k.start });
    }
  }
  // cut: time the plan kept that the user dropped
  for (const p of plannedKeeps) {
    const mid = (p.start + p.end) / 2;
    if (!covered(mid, finalKeeps)) {
      const text = textIn(p.start, p.end);
      if (text) corrections.push({ action: "cut", text, at: p.start });
    }
  }
  return corrections;
}

function record(filePath, corrections) {
  if (!filePath || !corrections.length) return 0;
  try {
    const lines = corrections.map((c) =>
      JSON.stringify({ ...c, ts: Date.now() }),
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines.join("\n") + "\n");
    rotate(filePath);
    return corrections.length;
  } catch {
    return 0;
  }
}

function rotate(filePath) {
  try {
    const all = fs.readFileSync(filePath, "utf8").trim().split("\n");
    if (all.length > MAX_FILE_LINES) {
      fs.writeFileSync(filePath, all.slice(-MAX_FILE_LINES).join("\n") + "\n");
    }
  } catch {}
}

/** Newest-first recent corrections for few-shot use. */
function loadRecent(filePath, n = 6) {
  try {
    const all = fs.readFileSync(filePath, "utf8").trim().split("\n");
    return all
      .slice(-n * 3) // over-read, then filter parse failures
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-n)
      .reverse();
  } catch {
    return [];
  }
}

/** Render preference examples as a prompt block for the S2 scorer. */
function preferenceBlock(corrections) {
  if (!corrections || !corrections.length) return "";
  const restored = corrections.filter((c) => c.action === "restored").slice(0, 3);
  const cut = corrections.filter((c) => c.action === "cut").slice(0, 3);
  const lines = [];
  if (restored.length) {
    lines.push("This user RESTORED moments the last edit cut — score similar moments HIGHER:");
    for (const c of restored) lines.push(`  · “${c.text}”`);
  }
  if (cut.length) {
    lines.push("This user CUT moments the last edit kept — score similar moments LOWER:");
    for (const c of cut) lines.push(`  · “${c.text}”`);
  }
  return lines.join("\n");
}

module.exports = { diffPlan, record, loadRecent, preferenceBlock, MAX_FILE_LINES };
