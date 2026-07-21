/**
 * lib/local-llm.js — local, key-free, rate-limit-free scoring via Ollama.
 *
 * THE permanent fix for the endless cloud-LLM saga (Gemini JSON truncation,
 * 400s, quota; Groq rate limits). A small model (Llama 3.2 3B / Qwen) runs on
 * YOUR machine — GPU-accelerated on an NVIDIA card — so scoring has:
 *   · no API key        · no quota / billing
 *   · no rate limits     · no provider JSON quirks (we set format:"json")
 * ...which also means the app works for ANY future user with zero setup keys.
 *
 * One-time setup:
 *   1. Install Ollama:   https://ollama.com/download
 *   2. Pull a model:     ollama pull qwen2.5:3b   (~1.9 GB, Apache-2.0)
 *   (Ollama serves an HTTP API on 127.0.0.1:11434 automatically.)
 *
 * Same shape as lib/ai.js chatJSON / lib/gemini.js, so the engine treats it as
 * just another rung of the scoring ladder — preferred first when present.
 */

const { parseJsonLoose } = require("./gemini"); // reuse the tolerant JSON parser

const BASE = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.LOCAL_LLM_MODEL || "qwen2.5:3b";
const TIMEOUT_MS = parseInt(process.env.LOCAL_LLM_TIMEOUT_MS || "120000");

function modelName() {
  return MODEL;
}

/** Is Ollama up and does it have at least one model pulled? Fast, cached-ish. */
async function available() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.models) && data.models.length > 0;
  } catch {
    return false;
  }
}

/**
 * messages [{role,content}] → parsed JSON. Ollama's format:"json" constrains
 * the model to valid JSON, so this doesn't suffer the truncation/malformation
 * the cloud providers do. Injected into the engine exactly like the others.
 */
async function chatJSON(messages, { temperature = 0.2 } = {}) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      format: "json", // forces valid JSON output
      stream: false,
      options: { temperature },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`local LLM failed (${res.status}): ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  const text = data?.message?.content || "";
  if (!text) throw new Error("local LLM returned empty content");
  return parseJsonLoose(text);
}

module.exports = { available, chatJSON, modelName };
