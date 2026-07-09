"use client";
import { useCallback, useState } from "react";
import type { Mode, ClipPlan, Segment } from "@/lib/types";
import { useJob } from "@/lib/useJob";
import {
  uploadJob,
  renderEdit,
  renderClips,
  renderClip,
} from "@/lib/api";
import {
  buildFields,
  defaultAi,
  defaultClips,
  defaultSilence,
  type AiSettings,
  type ClipsSettings,
  type SilenceSettings,
} from "@/lib/settings";

import Nav from "@/components/Nav";
import Dropzone from "@/components/Dropzone";
import AiConfig from "@/components/AiConfig";
import ClipsConfig from "@/components/ClipsConfig";
import SilenceConfig from "@/components/SilenceConfig";
import Progress from "@/components/Progress";
import Review from "@/components/Review";
import ClipReview from "@/components/ClipReview";
import ClipEditor from "@/components/ClipEditor";
import ClipsResult from "@/components/ClipsResult";
import Result from "@/components/Result";

const HEROES: Record<Mode, { h: string; s: string }> = {
  ai: {
    h: "Raw footage in. Finished edit out.",
    s: "Describe the edit in plain English. Review the AI's plan, fix anything on the timeline, render as many versions as you need.",
  },
  clips: {
    h: "Find the moments worth posting.",
    s: "The AI scans your whole video for self-contained, high-scoring clips — then you pick, trim, and export them vertical or wide.",
  },
  silence: {
    h: "Cut the dead air. Instantly.",
    s: "No transcription, no waiting — just detect silent gaps and remove them. Fully offline and fast.",
  },
};

const PROCESSING = new Set([
  "analyzing",
  "transcribing",
  "planning",
  "queued",
  "cutting",
  "finishing",
]);

export default function Page() {
  const [mode, setMode] = useState<Mode>("ai");
  const [jobId, setJobId] = useState<string | null>(null);
  const [editingClip, setEditingClip] = useState<ClipPlan | null>(null);
  const [uploadErr, setUploadErr] = useState("");
  const [uploading, setUploading] = useState(false);

  const [ai, setAi] = useState<AiSettings>(defaultAi);
  const [clips, setClips] = useState<ClipsSettings>(defaultClips);
  const [silence, setSilence] = useState<SilenceSettings>(defaultSilence);
  const [music, setMusic] = useState<File | null>(null);

  const { job, poke } = useJob(jobId);

  // Switching modes abandons the current job view — each feature stays on its
  // own screen and never inherits another feature's result.
  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setJobId(null);
    setEditingClip(null);
    setUploadErr("");
  };

  const reset = () => {
    setJobId(null);
    setEditingClip(null);
    setUploadErr("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleFile = useCallback(
    async (file: File) => {
      setUploadErr("");
      setUploading(true);
      try {
        const fields = buildFields(mode, ai, clips, silence);
        const { id } = await uploadJob(file, fields, mode === "ai" ? music : null);
        setEditingClip(null);
        setJobId(id);
        poke();
      } catch (e: any) {
        setUploadErr(e.message || "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [mode, ai, clips, silence, music, poke],
  );

  const onReviewRender = async (included: Segment[], wordEdits: Record<number, string>) => {
    if (!jobId) return;
    await renderEdit(jobId, included, wordEdits);
    poke();
  };
  const onClipsRender = async (selected: number[]) => {
    if (!jobId) return;
    await renderClips(jobId, selected);
    poke();
  };
  const onClipRender = async (i: number, segments: Segment[], title: string) => {
    if (!jobId) return;
    setEditingClip(null);
    await renderClip(jobId, i, segments, title);
    poke();
  };

  const showSetup = !jobId || (job && job.status === "error");

  return (
    <>
      <Nav mode={mode} onMode={switchMode} />
      <main className="mx-auto max-w-[1080px] px-5 pb-28 pt-2">
        {showSetup && (
          <section>
            <h1 className="mt-6 max-w-[20ch] text-balance text-[clamp(26px,4vw,36px)] font-semibold tracking-tight">
              {HEROES[mode].h}
            </h1>
            <p className="mt-2 max-w-[58ch] text-muted">{HEROES[mode].s}</p>

            <Dropzone onFile={handleFile} disabled={uploading} />

            {uploading && (
              <p className="mt-3 text-[13px] text-muted">Uploading…</p>
            )}
            {(uploadErr || job?.error) && (
              <div className="mt-4 rounded-xl border border-[var(--cut-line)] bg-[var(--cut-bg)] px-3.5 py-3 text-[13.5px] text-cut">
                {uploadErr || job?.error}
              </div>
            )}

            {mode === "ai" && (
              <AiConfig value={ai} onChange={setAi} onMusic={setMusic} />
            )}
            {mode === "clips" && <ClipsConfig value={clips} onChange={setClips} />}
            {mode === "silence" && (
              <SilenceConfig value={silence} onChange={setSilence} />
            )}
          </section>
        )}

        {jobId && job && job.status !== "error" && (
          <section className="card mt-5 p-5 sm:p-6">
            {PROCESSING.has(job.status) && <Progress job={job} />}

            {job.status === "review" && (
              <Review job={job} onRender={onReviewRender} />
            )}

            {job.status === "clipReview" &&
              (editingClip ? (
                <ClipEditor
                  job={job}
                  clip={editingClip}
                  onRender={onClipRender}
                  onBack={() => setEditingClip(null)}
                />
              ) : (
                <ClipReview
                  job={job}
                  onRender={onClipsRender}
                  onEdit={setEditingClip}
                />
              ))}

            {job.status === "done" &&
              (job.clips && job.clips.length ? (
                <ClipsResult job={job} vertical={clips.vertical} onNew={reset} />
              ) : (
                <Result job={job} onRerender={onReviewRender} onNew={reset} />
              ))}
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-[1080px] px-5 pb-10 text-[12px] text-faint">
        Runs on your machine — video never leaves it except audio sent to Groq
        for transcription in AI mode.
      </footer>
    </>
  );
}
