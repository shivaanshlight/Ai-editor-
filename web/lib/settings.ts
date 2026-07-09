import type { UploadFields } from "./api";
import type { Mode } from "./types";

export interface AiSettings {
  instruction: string;
  targetDuration: string;
  captionStyle: "none" | "bold" | "clean" | "soft";
  musicVol: number;
  fillerRemoval: boolean;
  shrinkPauses: boolean;
  diarize: boolean;
  autoReframe: boolean;
  enhanceAudio: boolean;
  punchIn: boolean;
  vertical: boolean;
  review: boolean;
  draft: boolean;
}

export interface ClipsSettings {
  instruction: string;
  clipCount: string;
  clipLen: string;
  captionStyle: "none" | "bold" | "clean";
  vertical: boolean;
  diarize: boolean;
  autoReframe: boolean;
  enhanceAudio: boolean;
  punchIn: boolean;
  review: boolean;
  draft: boolean;
}

export interface SilenceSettings {
  noiseDb: number;
  minSilence: number;
  padding: number;
}

export const defaultAi: AiSettings = {
  instruction: "",
  targetDuration: "",
  captionStyle: "clean",
  musicVol: 0.25,
  fillerRemoval: true,
  shrinkPauses: true,
  diarize: false,
  autoReframe: false,
  enhanceAudio: false,
  punchIn: true,
  vertical: false,
  review: true,
  draft: true,
};

export const defaultClips: ClipsSettings = {
  instruction: "",
  clipCount: "auto",
  clipLen: "60",
  captionStyle: "bold",
  vertical: true,
  diarize: false,
  autoReframe: false,
  enhanceAudio: false,
  punchIn: true,
  review: true,
  draft: true,
};

export const defaultSilence: SilenceSettings = {
  noiseDb: -35,
  minSilence: 0.6,
  padding: 0.15,
};

export interface Preset {
  label: string;
  instruction: string;
  vertical: boolean;
  captionStyle: AiSettings["captionStyle"];
  punchIn: boolean;
  targetDuration: string;
}

export const PRESETS: Record<string, Preset> = {
  youtube: {
    label: "YouTube",
    instruction:
      "Tighten this video: remove dead air, filler, false starts and rambling. Keep it engaging.",
    vertical: false,
    captionStyle: "clean",
    punchIn: false,
    targetDuration: "",
  },
  shorts: {
    label: "Reels / Shorts",
    instruction:
      "Cut this into a fast-paced short. Strongest hook first, keep only the best moments.",
    vertical: true,
    captionStyle: "bold",
    punchIn: true,
    targetDuration: "60",
  },
  podcast: {
    label: "Podcast clip",
    instruction:
      "Pull the most engaging complete passage, like a podcast clip. One clear idea.",
    vertical: false,
    captionStyle: "bold",
    punchIn: false,
    targetDuration: "90",
  },
  interview: {
    label: "Interview",
    instruction:
      "Edit like an interview: keep the full question-and-answer exchanges, cut host filler and dead air, keep it conversational.",
    vertical: false,
    captionStyle: "clean",
    punchIn: false,
    targetDuration: "",
  },
  educational: {
    label: "Educational",
    instruction:
      "Edit like a tutorial: keep clear explanations and steps in order, cut tangents and repetition, tighten the pacing.",
    vertical: false,
    captionStyle: "clean",
    punchIn: false,
    targetDuration: "",
  },
};

/** Map the active mode's settings to the flat fields the /api/upload expects. */
export function buildFields(
  mode: Mode,
  ai: AiSettings,
  clips: ClipsSettings,
  silence: SilenceSettings,
): UploadFields {
  if (mode === "ai") {
    const f: UploadFields = {
      mode,
      instruction: ai.instruction,
      captions: ai.captionStyle !== "none",
      softCaptions: ai.captionStyle === "soft",
      captionStyle: ai.captionStyle === "bold" ? "bold" : "clean",
      musicVol: ai.musicVol,
      fillerRemoval: ai.fillerRemoval,
      shrinkPauses: ai.shrinkPauses,
      diarize: ai.diarize,
      autoReframe: ai.autoReframe,
      enhanceAudio: ai.enhanceAudio,
      punchIn: ai.punchIn,
      vertical: ai.vertical,
      review: ai.review,
      draft: ai.draft,
    };
    if (ai.targetDuration) f.targetDuration = ai.targetDuration;
    return f;
  }
  if (mode === "clips") {
    return {
      mode,
      instruction: clips.instruction,
      clipCount: clips.clipCount,
      clipLen: clips.clipLen,
      captions: clips.captionStyle !== "none",
      captionStyle: clips.captionStyle === "bold" ? "bold" : "clean",
      vertical: clips.vertical,
      diarize: clips.diarize,
      autoReframe: clips.autoReframe,
      enhanceAudio: clips.enhanceAudio,
      punchIn: clips.punchIn,
      review: clips.review,
      draft: clips.draft,
    };
  }
  return {
    mode,
    noiseDb: silence.noiseDb,
    minSilence: silence.minSilence,
    padding: silence.padding,
  };
}
