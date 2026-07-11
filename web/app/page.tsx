"use client";
import { useCallback, useEffect, useState } from "react";
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
  defaultHighlights,
  type AiSettings,
  type ClipsSettings,
  type SilenceSettings,
  type HighlightsSettings,
} from "@/lib/settings";

import Nav from "@/components/Nav";
import Dropzone from "@/components/Dropzone";
import AiConfig from "@/components/AiConfig";
import ClipsConfig from "@/components/ClipsConfig";
import SilenceConfig from "@/components/SilenceConfig";
import HighlightsConfig from "@/components/HighlightsConfig";
import Progress from "@/components/Progress";
import Workspace from "@/components/Workspace";
import { demoJob } from "@/lib/workspace";
import ClipReview from "@/components/ClipReview";
import ClipEditor from "@/components/ClipEditor";
import ClipsResult from "@/components/ClipsResult";
import Result from "@/components/Result";

const HEROES: Record<Mode, { h: string; s: string }> = {
  ai: {
    h: "Raw footage in. Finished edit out.",
    s: "Describe the edit in plain English. Review the AI's plan, fix anything on the timeline, render as many versions as you need.",
  },
  highlights: {
    h: "Turn hours into minutes.",
    s: "The AI condenses your entire recording into one tight highlights cut — the best moments, stitched into a single watchable episode.",
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

type PerMode<T> = Record<Mode, T>;

export default function Page() {
  const [mode, setMode] = useState<Mode>("ai");
  // #demo renders the Workspace with fixture data — used for design review and
  // headless verification without a backend.
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    const sync = () => setDemo(window.location.hash === "#demo");
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // Each mode owns its own job + editor state, so switching tabs never loses an
  // in-flight render and one mode's result never appears under another.
  const [jobIds, setJobIds] = useState<PerMode<string | null>>({
    ai: null,
    highlights: null,
    clips: null,
    silence: null,
  });
  const [errs, setErrs] = useState<PerMode<string>>({
    ai: "",
    highlights: "",
    clips: "",
    silence: "",
  });
  const [editing, setEditing] = useState<PerMode<ClipPlan | null>>({
    ai: null,
    highlights: null,
    clips: null,
    silence: null,
  });
  const [uploading, setUploading] = useState(false);

  const [ai, setAi] = useState<AiSettings>(defaultAi);
  const [clips, setClips] = useState<ClipsSettings>(defaultClips);
  const [silence, setSilence] = useState<SilenceSettings>(defaultSilence);
  const [highlights, setHighlights] = useState<HighlightsSettings>(defaultHighlights);
  const [music, setMusic] = useState<File | null>(null);

  const activeJobId = jobIds[mode];
  const { job, poke } = useJob(activeJobId);
  const editingClip = editing[mode];

  const setJobFor = (m: Mode, id: string | null) =>
    setJobIds((p) => ({ ...p, [m]: id }));
  const setErrFor = (m: Mode, msg: string) => setErrs((p) => ({ ...p, [m]: msg }));
  const setEditingFor = (m: Mode, c: ClipPlan | null) =>
    setEditing((p) => ({ ...p, [m]: c }));

  // Switching modes just changes which mode's state we look at — nothing is
  // reset, so a render in progress keeps going and is still there on return.
  const switchMode = (m: Mode) => setMode(m);

  const reset = () => {
    setJobFor(mode, null);
    setEditingFor(mode, null);
    setErrFor(mode, "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleFile = useCallback(
    async (file: File) => {
      const m = mode;
      setErrFor(m, "");
      setUploading(true);
      try {
        const fields = buildFields(m, ai, clips, silence, highlights);
        const { id } = await uploadJob(file, fields, m === "ai" ? music : null);
        setEditingFor(m, null);
        setJobFor(m, id);
        poke();
      } catch (e: any) {
        setErrFor(m, e.message || "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [mode, ai, clips, silence, highlights, music, poke],
  );

  const onReviewRender = async (
    included: Segment[],
    wordEdits: Record<number, string>,
    speakerNames?: Record<string, string>,
  ) => {
    if (!activeJobId) return;
    await renderEdit(activeJobId, included, wordEdits, speakerNames);
    poke();
  };
  const onClipsRender = async (selected: number[]) => {
    if (!activeJobId) return;
    await renderClips(activeJobId, selected);
    poke();
  };
  const onClipRender = async (i: number, segments: Segment[], title: string) => {
    if (!activeJobId) return;
    setEditingFor(mode, null);
    await renderClip(activeJobId, i, segments, title);
    poke();
  };

  const showSetup = !activeJobId || (job && job.status === "error");

  if (demo) {
    return (
      <>
        <Nav mode={mode} onMode={switchMode} />
        <main className="mx-auto max-w-[1240px] px-5 pb-16 pt-4">
          <Workspace job={demoJob()} onRender={() => {}} />
        </main>
      </>
    );
  }

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

            {uploading && <p className="mt-3 text-[13px] text-muted">Uploading…</p>}
            {(errs[mode] || job?.error) && (
              <div className="mt-4 rounded-xl border border-[var(--cut-line)] bg-[var(--cut-bg)] px-3.5 py-3 text-[13.5px] text-cut">
                {errs[mode] || job?.error}
              </div>
            )}

            {mode === "ai" && <AiConfig value={ai} onChange={setAi} onMusic={setMusic} />}
            {mode === "highlights" && (
              <HighlightsConfig value={highlights} onChange={setHighlights} />
            )}
            {mode === "clips" && <ClipsConfig value={clips} onChange={setClips} />}
            {mode === "silence" && <SilenceConfig value={silence} onChange={setSilence} />}
          </section>
        )}

        {activeJobId && !showSetup && (
          <section className="card mt-5 p-5 sm:p-6">
            {!job && <p className="text-muted">Loading…</p>}

            {job && PROCESSING.has(job.status) && <Progress job={job} />}

            {job && job.status === "review" && (
              <Workspace job={job} onRender={onReviewRender} />
            )}

            {job && job.status === "clipReview" &&
              (editingClip ? (
                <ClipEditor
                  job={job}
                  clip={editingClip}
                  onRender={onClipRender}
                  onBack={() => setEditingFor(mode, null)}
                />
              ) : (
                <ClipReview
                  job={job}
                  onRender={onClipsRender}
                  onEdit={(c) => setEditingFor(mode, c)}
                />
              ))}

            {job && job.status === "done" &&
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
