/**
 * lib/gemini.js — Gemini big-context adapter (M2).
 *
 * Kills chunking: Gemini Flash's context window swallows a multi-hour
 * transcript in ONE call, so the scorer sees the whole video's structure
 * instead of 20-minute keyholes. Free-tier friendly (generous daily quota),
 * JSON-mode output, 429-aware retries.
 *
 * Same signature as lib/ai.js chatJSON, so the engine treats providers as
 * interchangeable rungs of the fallback ladder:
 *   Gemini big-context → Groq outline-then-score → deterministic-only.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RETRY_BASE_MS = parseInt(process.env.GEMINI_RETRY_BASE_MS || "2000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiKey() {
  return process.env.GEMINI_API_KEY || null;
}

/**
 * messages [{role:"system"|"user"|"assistant", content}] → parsed JSON.
 * System messages become systemInstruction; the rest map to contents.
 */
async function geminiChatJSON(messages, { temperature = 0.2 } = {}) {
  const key = geminiKey();
  if (!key) throw new Error("GEMINI_API_KEY missing");

  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body = {
    contents,
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let res;
  const MAX = 6;
  for (let attempt = 0; attempt < MAX; attempt++) {
    res = await fetch(`${BASE}/${MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 && res.status < 500) break;
    if (attempt === MAX - 1) break;
    const ra = parseFloat(res.headers?.get?.("retry-after"));
    await sleep(Math.min(isFinite(ra) ? ra * 1000 + 500 : RETRY_BASE_MS * 2 ** attempt, 120000));
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini call failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  return JSON.parse(text);
}

function geminiAvailable() {
  return !!geminiKey();
}

module.exports = { geminiChatJSON, geminiAvailable, MODEL };
