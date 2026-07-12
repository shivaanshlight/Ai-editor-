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
const RETRY_BASE_MS = parseInt(process.env.GEMINI_RETRY_BASE_MS || "2000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiKey() {
  return process.env.GEMINI_API_KEY || null;
}

/* ---------------------------- model auto-discovery --------------------------
 * Model names rot: keys created at different times get different generations
 * ("gemini-2.5-flash is no longer available to new users"). So instead of
 * hardcoding a name, ask the API which models THIS key can use and pick the
 * best general-purpose flash model. GEMINI_MODEL in .env pins it manually.
 */
let resolvedModel = null;

function rankModel(n) {
  let s = 0;
  const v = n.match(/gemini-(\d+(?:\.\d+)?)/);
  if (v) s += parseFloat(v[1]) * 100; // newer generation wins
  if (/flash/.test(n)) s += 30; // speed-tier preferred for scoring
  if (/lite/.test(n)) s -= 5;
  if (/preview|exp/.test(n)) s -= 10; // stable over experimental
  if (/thinking|tts|image|audio|embed|vision|live|nano/.test(n)) s -= 1000; // wrong modality
  return s;
}

async function pickModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (resolvedModel) return resolvedModel;
  const res = await fetch(`${BASE}?key=${key}&pageSize=200`);
  if (!res.ok) throw new Error(`Gemini ListModels failed (${res.status})`);
  const data = await res.json();
  const usable = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-/.test(n))
    .sort((a, b) => rankModel(b) - rankModel(a));
  if (!usable.length) throw new Error("no usable Gemini text models for this key");
  resolvedModel = usable[0];
  return resolvedModel;
}

function getResolvedModel() {
  return process.env.GEMINI_MODEL || resolvedModel || "(auto — discovered on first call)";
}

/**
 * messages [{role:"system"|"user"|"assistant", content}] → parsed JSON.
 * System messages become systemInstruction; the rest map to contents.
 */
async function geminiChatJSON(messages, { temperature = 0.2 } = {}) {
  const key = geminiKey();
  if (!key) throw new Error("GEMINI_API_KEY missing");
  let model = await pickModel(key);

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
    res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 404 = this model name rotted for this key — rediscover once and retry
    if (res.status === 404 && !process.env.GEMINI_MODEL && attempt === 0) {
      resolvedModel = null;
      model = await pickModel(key);
      continue;
    }
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

module.exports = { geminiChatJSON, geminiAvailable, pickModel, getResolvedModel };
