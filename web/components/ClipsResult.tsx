"use client";
import type { Job } from "@/lib/types";
import { clipPreviewUrl, clipDownloadUrl } from "@/lib/api";
import { fmt } from "@/lib/format";

export default function ClipsResult({
  job,
  vertical,
  onNew,
}: {
  job: Job;
  vertical: boolean;
  onNew: () => void;
}) {
  const clips = job.clips || [];
  return (
    <div className="animate-fade-up">
      <p className="mb-4 text-muted">
        {clips.length} clip{clips.length === 1 ? "" : "s"} ready — preview and
        download below.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
        {clips.map((c) => (
          <div key={c.i} className="overflow-hidden rounded-xl2 border border-line bg-surface2">
            <video
              controls
              playsInline
              preload="metadata"
              src={clipPreviewUrl(job.id, c.i)}
              className={`block w-full bg-black object-cover ${vertical ? "aspect-[9/16]" : "aspect-video"}`}
            />
            <div className="p-3.5">
              <b className="text-[13.5px] font-semibold">{c.title}</b>
              <div className="mono my-1.5 text-[11.5px] text-faint">
                {Math.round(c.duration)}s · from {fmt(c.start)}
              </div>
              <a
                href={clipDownloadUrl(job.id, c.i)}
                className="text-[13px] font-medium text-accent hover:underline"
              >
                Download
              </a>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <button className="btn" onClick={onNew}>New video</button>
      </div>
    </div>
  );
}
