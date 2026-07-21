import type { Job, RepurposePack, WordRow, Segment, Chapter } from "./types";

// All requests go to same-origin /api/* — next.config.js rewrites them to the
// Express backend on :3000, so there's no CORS and media URLs Just Work.

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || `Request failed (${res.status})`);
  return data;
}

export interface UploadFields {
  mode: string;
  [k: string]: string | boolean | number | File | null | undefined;
}

export async function uploadJob(
  video: File,
  fields: UploadFields,
  music?: File | null,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("video", video);
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    form.append(k, typeof v === "boolean" ? String(v) : (v as any));
  }
  if (music) form.append("music", music);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  return jsonOrThrow(res) as Promise<{ id: string }>;
}

export async function getJob(id: string): Promise<Job> {
  const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
  return jsonOrThrow(res) as Promise<Job>;
}

export async function renderEdit(
  id: string,
  included: Segment[],
  wordEdits: Record<number, string>,
  speakerNames?: Record<string, string>,
  coldOpen?: boolean,
): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ included, wordEdits, speakerNames, coldOpen }),
  });
  await jsonOrThrow(res);
}

export async function askVideo(
  id: string,
  q: string,
): Promise<{ answer: string; citations: { start: number; quote: string }[]; indexing?: boolean; error?: string }> {
  const res = await fetch(`/api/jobs/${id}/ask?q=${encodeURIComponent(q)}`);
  return res.json();
}

export async function renderClips(id: string, selected: number[]): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/render-clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected }),
  });
  await jsonOrThrow(res);
}

export async function renderClip(
  id: string,
  i: number,
  segments: Segment[],
  title: string,
): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/render-clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ i, segments, title }),
  });
  await jsonOrThrow(res);
}

export async function getWords(id: string): Promise<WordRow[]> {
  const res = await fetch(`/api/jobs/${id}/words`);
  if (!res.ok) return [];
  return res.json();
}

export async function searchMoments(
  id: string,
  q: string,
): Promise<{ results?: any[]; indexing?: boolean; error?: string }> {
  const res = await fetch(`/api/jobs/${id}/search?q=${encodeURIComponent(q)}`);
  return res.json();
}

export async function getRepurpose(
  id: string,
  refresh = false,
): Promise<{ pack: RepurposePack; chapters: { t: string; title: string }[] }> {
  const res = await fetch(`/api/jobs/${id}/repurpose${refresh ? "?refresh=1" : ""}`);
  return jsonOrThrow(res) as Promise<{
    pack: RepurposePack;
    chapters: { t: string; title: string }[];
  }>;
}

export const previewUrl = (id: string, v: number) =>
  `/api/preview/${id}?v=${v}&t=${Date.now()}`;
export const clipPreviewUrl = (id: string, i: number) =>
  `/api/preview/${id}?c=${i}&t=${Date.now()}`;
export const downloadUrl = (id: string, v: number) => `/api/download/${id}?v=${v}`;
export const clipDownloadUrl = (id: string, i: number) => `/api/download/${id}?c=${i}`;
export const sourceUrl = (id: string) => `/api/source/${id}?t=${Date.now()}`;

export type { Chapter };
