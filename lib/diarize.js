/**
 * lib/diarize.js — speaker diarization via AssemblyAI ("who spoke when").
 * Isolated on purpose: swap this one file for local WhisperX/pyannote later
 * without touching the rest of the pipeline. Reads ASSEMBLYAI_API_KEY.
 */
const fs = require("fs");

const AAI = "https://api.assemblyai.com/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  const k = process.env.ASSEMBLYAI_API_KEY;
  if (!k)
    throw new Error("ASSEMBLYAI_API_KEY missing — add it to .env to detect speakers.");
  return k;
}

/**
 * Diarize an audio file. Returns:
 *   { utterances: [{ speaker, start, end, text }], speakers: ["A","B",...] }
 * with times in seconds. `onStatus(status)` is called while polling.
 */
async function diarize(audioPath, onStatus) {
  const key = apiKey();

  // 1) upload the audio
  const up = await fetch(`${AAI}/upload`, {
    method: "POST",
    headers: { authorization: key },
    body: fs.readFileSync(audioPath),
  });
  if (!up.ok)
    throw new Error(`AssemblyAI upload failed (${up.status})`);
  const { upload_url } = await up.json();

  // 2) request a diarized transcript
  const create = await fetch(`${AAI}/transcript`, {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: upload_url,
      speaker_labels: true,
      punctuate: true,
      format_text: true,
    }),
  });
  if (!create.ok)
    throw new Error(`AssemblyAI request failed (${create.status})`);
  const { id } = await create.json();

  // 3) poll until done
  for (let i = 0; i < 900; i++) {
    await sleep(4000);
    const res = await fetch(`${AAI}/transcript/${id}`, {
      headers: { authorization: key },
    });
    const d = await res.json();
    if (d.status === "completed") {
      const utterances = (d.utterances || []).map((u) => ({
        speaker: u.speaker,
        start: u.start / 1000,
        end: u.end / 1000,
        text: u.text,
      }));
      const speakers = [...new Set(utterances.map((u) => u.speaker))];
      return { utterances, speakers };
    }
    if (d.status === "error")
      throw new Error(`AssemblyAI: ${d.error || "diarization failed"}`);
    if (onStatus) onStatus(d.status);
  }
  throw new Error("AssemblyAI diarization timed out.");
}

module.exports = { diarize };
