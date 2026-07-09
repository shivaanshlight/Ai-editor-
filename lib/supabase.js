/**
 * lib/supabase.js — persistence + object storage for ClipSurgeon.
 *
 * The server runs as a trusted worker: it uses the SERVICE_ROLE key, which
 * bypasses RLS. Every job is owned by DEV_USER_ID for now (swap for the real
 * authenticated user in Phase 2). Files live in three private buckets
 * (source / proxies / outputs) under the key `<user>/<jobId>/<file>`.
 */
const fs = require("fs");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { createClient } = require("@supabase/supabase-js");

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEV_USER_ID = process.env.DEV_USER_ID;

if (!URL || !SERVICE_KEY || !DEV_USER_ID) {
  console.error(
    "Supabase not configured — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DEV_USER_ID in .env",
  );
}

const supabase =
  URL && SERVICE_KEY
    ? createClient(URL, SERVICE_KEY, { auth: { persistSession: false } })
    : null;

const key = (jobId, file) => `${DEV_USER_ID}/${jobId}/${file}`;

/* ---------------- storage ---------------- */

/** Upload a local file to a bucket without buffering the whole thing in memory. */
async function uploadLocal(bucket, storageKey, localPath, contentType) {
  const body = fs.openAsBlob
    ? await fs.openAsBlob(localPath, { type: contentType })
    : fs.readFileSync(localPath);
  const { error } = await supabase.storage
    .from(bucket)
    .upload(storageKey, body, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return storageKey;
}

/** Stream a stored object down to a local path (used to feed ffmpeg). */
async function downloadTo(bucket, storageKey, destPath) {
  const url = await signedUrl(bucket, storageKey, 600);
  const res = await fetch(url);
  if (!res.ok || !res.body)
    throw new Error(`Storage download failed (${res.status}) for ${storageKey}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return destPath;
}

/** Short-lived signed URL — handed to the browser for preview/download. */
async function signedUrl(bucket, storageKey, expires = 3600) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storageKey, expires);
  if (error) throw new Error(`Signed URL failed: ${error.message}`);
  return data.signedUrl;
}

/* ---------------- jobs ---------------- */

// The full job object lives in the `data` jsonb column; a handful of fields are
// mirrored into real columns so they stay queryable (recent projects, status).
// `input` (the local source path) IS persisted so re-renders survive a restart
// on the same machine; `words`/`transcriptText` stay in the transcripts table.
const HEAVY = new Set(["_timer", "words", "transcriptText"]);

function jobToRow(job) {
  const data = {};
  for (const k of Object.keys(job)) if (!HEAVY.has(k)) data[k] = job[k];
  return {
    id: job.id,
    user_id: DEV_USER_ID,
    mode: job.mode,
    status: job.status || "queued",
    progress: job.progress || 0,
    stage: job.stage || null,
    error: job.error || null,
    original_name: job.originalName || null,
    source_path: job.source_path || null,
    duration: job.duration || null,
    meta: job.meta || null,
    settings: job.settings || {},
    summary: job.summary || null,
    transcript_fp: job.transcript_fp || null,
    review_blocks: job.reviewBlocks || null,
    planned_keeps: job.plannedKeeps || null,
    clip_plans: job.clipPlans || null,
    chapters: job.chapters || null,
    version: job.version || 0,
    data,
  };
}

async function saveJob(job) {
  if (!supabase) return;
  const { error } = await supabase.from("jobs").upsert(jobToRow(job));
  if (error) console.error("saveJob:", error.message);
}

/** Load recent jobs into memory at boot (data column is the source of truth). */
async function loadJobs(limit = 100) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("jobs")
    .select("data")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("loadJobs:", error.message);
    return [];
  }
  return (data || []).map((r) => r.data).filter(Boolean);
}

/* ---------------- transcript cache ---------------- */

async function getTranscript(fp) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("transcripts")
    .select("text, words, segments")
    .eq("fingerprint", fp)
    .maybeSingle();
  if (error) {
    console.error("getTranscript:", error.message);
    return null;
  }
  return data || null;
}

async function saveTranscript(fp, transcript) {
  if (!supabase) return;
  const { error } = await supabase.from("transcripts").upsert({
    fingerprint: fp,
    text: transcript.text || "",
    words: transcript.words || [],
    segments: transcript.segments || [],
  });
  if (error) console.error("saveTranscript:", error.message);
}

module.exports = {
  supabase,
  ready: !!supabase && !!DEV_USER_ID,
  DEV_USER_ID,
  key,
  uploadLocal,
  downloadTo,
  signedUrl,
  saveJob,
  loadJobs,
  getTranscript,
  saveTranscript,
};
