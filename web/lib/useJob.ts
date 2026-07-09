import { useCallback, useEffect, useRef, useState } from "react";
import { getJob } from "./api";
import type { Job } from "./types";

// States where the backend won't change on its own — either it's finished, or
// it's waiting for the human (review / clip selection). We stop polling there
// and resume via poke() when the user triggers the next action.
const REST_STATES = new Set(["review", "clipReview", "done", "error"]);

/**
 * Poll a job until it reaches a rest state, then idle. `poke()` resumes polling
 * after the user kicks off a render so we catch the queued→cutting→done arc.
 */
export function useJob(id: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const activeRef = useRef(false);
  const idRef = useRef<string | null>(id);
  idRef.current = id;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    if (!idRef.current) return;
    const run = async () => {
      const cur = idRef.current;
      if (!cur) return stop();
      try {
        const j = await getJob(cur);
        if (idRef.current !== cur) return; // id changed mid-flight
        setJob(j);
        const rest = REST_STATES.has(j.status);
        if (!rest) activeRef.current = false; // it's genuinely progressing now
        if (rest && !activeRef.current) stop();
      } catch {
        /* transient — keep trying */
      }
    };
    run();
    timer.current = setInterval(run, 900);
  }, [stop]);

  const poke = useCallback(() => {
    activeRef.current = true;
    start();
  }, [start]);

  useEffect(() => {
    setJob(null);
    activeRef.current = false;
    if (id) start();
    return stop;
  }, [id, start, stop]);

  return { job, poke, setJob };
}
