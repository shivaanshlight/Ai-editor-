// Shapes returned by the Express API (server.js). Kept intentionally loose
// where the backend is loose, strict where the UI depends on it.

export type Mode = "ai" | "clips" | "silence";

export type JobStatus =
  | "analyzing"
  | "transcribing"
  | "planning"
  | "queued"
  | "cutting"
  | "finishing"
  | "review"
  | "clipReview"
  | "done"
  | "error";

export interface BlockWord {
  i: number; // global word index
  w: string; // display text
  s?: number; // source start (seconds)
  e?: number; // source end (seconds)
}

export interface ReviewBlock {
  start: number;
  end: number;
  type: "keep" | "cut";
  words: BlockWord[];
}

export interface PlanStats {
  speakers: number;
  topics: number;
  longPauses: number;
  fillers: number;
  cuts: number;
  estRuntime: number;
  originalRuntime: number;
}

export interface Segment {
  start: number;
  end: number;
}

export interface Version {
  v: number;
  keptDuration: number;
  segments: Segment[];
  createdAt?: number;
}

export interface ClipPlan {
  i: number;
  title: string;
  score?: number;
  reason?: string;
  start: number;
  end: number;
  text?: string;
  padStart?: number;
  padEnd?: number;
}

export interface RenderedClip {
  i: number;
  title: string;
  duration: number;
  start: number;
  end: number;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  progress: number;
  error?: string;
  duration: number;
  keptDuration?: number;
  segments?: Segment[];
  originalName?: string;
  summary?: string;
  mode: Mode;
  reviewBlocks?: ReviewBlock[];
  planStats?: PlanStats;
  searchReady?: boolean;
  transcript?: string;
  versions?: Version[];
  version?: number;
  stage?: string;
  clipPlans?: ClipPlan[];
  clips?: RenderedClip[];
  chapters?: Chapter[];
  queuePos?: number;
}

// The content-kit ("repurpose") payload.
export interface RepurposePack {
  titles: string[];
  summary: string;
  description: string;
  tags: string[];
  hashtags: string[];
  pullQuotes: string[];
  tweet: string;
  thread: string[];
  linkedin: string;
  instagram: string;
}

export interface WordRow {
  i: number;
  w: string;
  s: number;
  e: number;
}
