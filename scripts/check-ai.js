/**
 * scripts/check-ai.js — 10-second AI diagnostics.
 *
 *   node scripts/check-ai.js
 *
 * Loads .env exactly like the server does, reports which keys are present,
 * then makes ONE tiny live call to each provider and prints the real result
 * or the exact error. No more guessing why the header says "scored by
 * deterministic".
 */

const fs = require("fs");
const path = require("path");

// same loader as server.js
try {
  for (const line of fs
    .readFileSync(path.join(__dirname, "..", ".env"), "utf8")
    .split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  console.log("✓ .env file found and parsed");
} catch (e) {
  console.log("✗ .env file NOT found next to package.json — " + e.message);
  console.log("  (Windows tip: make sure it isn't secretly named .env.txt — enable file extensions in Explorer)");
}

const mask = (k) => (k ? k.slice(0, 6) + "…" + k.slice(-4) + ` (${k.length} chars)` : "MISSING");
console.log("\nKeys as the server sees them:");
console.log("  GEMINI_API_KEY :", mask(process.env.GEMINI_API_KEY));
console.log("  GROQ_API_KEY   :", mask(process.env.GROQ_API_KEY));
console.log("  ASSEMBLYAI     :", process.env.ASSEMBLYAI_API_KEY ? "present" : "missing (diarization off)");

async function tryGemini() {
  if (!process.env.GEMINI_API_KEY) return console.log("\nGemini: skipped (no key)");
  const { geminiChatJSON, getResolvedModel } = require("../lib/gemini");
  try {
    const t0 = Date.now();
    const res = await geminiChatJSON(
      [
        { role: "system", content: 'Reply ONLY with JSON: {"ok":true}' },
        { role: "user", content: "ping" },
      ],
      { temperature: 0 },
    );
    console.log(`\n✓ Gemini WORKS (model auto-picked: ${getResolvedModel()}, ${Date.now() - t0}ms):`, JSON.stringify(res));
  } catch (e) {
    console.log(`\n✗ Gemini FAILED: ${e.message}`);
    if (/400/.test(e.message)) console.log("  → key malformed or model name rejected");
    if (/403/.test(e.message)) console.log("  → key invalid/restricted — regenerate at aistudio.google.com");
    if (/404/.test(e.message)) console.log("  → no usable model even after auto-discovery — paste this output to Claude");
    if (/429/.test(e.message)) console.log("  → free-tier quota exhausted right now — try again in a minute");
  }
}

async function tryGroq() {
  if (!process.env.GROQ_API_KEY) return console.log("\nGroq: skipped (no key)");
  const { chatJSON } = require("../lib/ai");
  try {
    const t0 = Date.now();
    const res = await chatJSON(
      [
        { role: "system", content: 'Reply ONLY with JSON: {"ok":true}' },
        { role: "user", content: "ping" },
      ],
      { temperature: 0 },
    );
    console.log(`✓ Groq WORKS (${Date.now() - t0}ms):`, JSON.stringify(res));
  } catch (e) {
    console.log(`✗ Groq FAILED: ${e.message}`);
  }
}

(async () => {
  await tryGemini();
  await tryGroq();
  const wl = require("../lib/whisper-local");
  console.log(
    "\nLocal whisper:",
    wl.available()
      ? `✓ ready (${wl.binaryPath()} + ${wl.modelPath()})`
      : "not installed — npm run setup-whisper",
  );
  console.log("\nWhat the engine will use on the next upload:");
  const scoring = process.env.GEMINI_API_KEY
    ? "Gemini big-context"
    : process.env.GROQ_API_KEY
      ? "Groq batched"
      : "deterministic only (no key)";
  console.log("  Scoring      :", scoring);
  console.log("  Transcription:", wl.available() ? "local whisper.cpp" : "Groq (rate-limited)");
})();
