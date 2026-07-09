"use client";
import { useState } from "react";
import { getRepurpose } from "@/lib/api";
import type { RepurposePack } from "@/lib/types";
import { CopyButton } from "./ui";

type Chapters = { t: string; title: string }[];

function Section({
  title,
  copyAll,
  children,
}: {
  title: string;
  copyAll?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl2 border border-line bg-surface2">
      <div className="flex items-center justify-between gap-2.5 px-3 py-2.5 text-[13.5px] font-semibold">
        <span>{title}</span>
        {copyAll && <CopyButton text={copyAll} />}
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">{children}</div>
    </div>
  );
}

function Item({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-2.5">
      <span className={`flex-1 whitespace-pre-wrap text-[13.5px] leading-snug ${muted ? "text-muted" : "text-ink"}`}>
        {text}
      </span>
      <CopyButton text={text} />
    </div>
  );
}

function chapterLines(chapters: Chapters): string[] {
  const lines = chapters.map((c) => `${c.t} ${c.title}`);
  if (lines[0] && !lines[0].startsWith("0:00")) lines.unshift("0:00 Intro");
  return lines;
}

export default function ContentKit({ jobId }: { jobId: string }) {
  const [pack, setPack] = useState<RepurposePack | null>(null);
  const [chapters, setChapters] = useState<Chapters>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const generate = async (refresh = false) => {
    setLoading(true);
    setErr("");
    try {
      const data = await getRepurpose(jobId, refresh);
      setPack(data.pack);
      setChapters(data.chapters || []);
    } catch (e: any) {
      setErr(e.message || "Failed.");
    } finally {
      setLoading(false);
    }
  };

  const chLines = chapterLines(chapters);
  const desc =
    pack?.description +
    (chLines.length ? `\n\nChapters:\n${chLines.join("\n")}` : "");

  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3.5">
        <div>
          <h3 className="text-[16px] font-semibold">Content kit</h3>
          <p className="mt-1 text-[13px] text-muted">
            Titles, description, tags, chapters, pull-quotes & ready-to-post
            social captions — written from your transcript.
          </p>
        </div>
        <button className="btn btn-primary" disabled={loading} onClick={() => generate(!!pack)}>
          {loading ? "Writing…" : pack ? "Regenerate" : "Generate kit"}
        </button>
      </div>

      {loading && !pack && (
        <p className="mt-3 text-[13px] text-muted">
          Reading the transcript and writing your kit — this can take a minute on
          long videos…
        </p>
      )}
      {err && <p className="mt-3 text-[13px] text-cut">Couldn’t generate the kit: {err}</p>}

      {pack && (
        <div className="animate-fade-up">
          {pack.titles?.length > 0 && (
            <Section title="Title ideas" copyAll={pack.titles.join("\n")}>
              {pack.titles.map((t, i) => (
                <Item key={i} text={t} />
              ))}
            </Section>
          )}
          {pack.summary && (
            <Section title="Summary" copyAll={pack.summary}>
              <Item text={pack.summary} muted />
            </Section>
          )}
          {chLines.length > 0 && (
            <Section title="Chapters" copyAll={chLines.join("\n")}>
              <div className="whitespace-pre-wrap rounded-lg border border-line bg-surface px-2.5 py-2.5 text-[13.5px] leading-relaxed">
                {chLines.join("\n")}
              </div>
            </Section>
          )}
          {pack.description && (
            <Section title="YouTube description" copyAll={desc}>
              <Item text={desc} muted />
            </Section>
          )}
          {(pack.tags?.length > 0 || pack.hashtags?.length > 0) && (
            <Section title="Tags & hashtags" copyAll={[...(pack.tags || []), ...(pack.hashtags || [])].join(", ")}>
              <div className="flex flex-wrap gap-1.5">
                {[...(pack.tags || []), ...(pack.hashtags || [])].map((t, i) => (
                  <span key={i} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12.5px] text-muted">
                    {t}
                  </span>
                ))}
              </div>
            </Section>
          )}
          {pack.pullQuotes?.length > 0 && (
            <Section title="Pull-quotes" copyAll={pack.pullQuotes.map((q) => `“${q}”`).join("\n")}>
              {pack.pullQuotes.map((q, i) => (
                <Item key={i} text={`“${q}”`} />
              ))}
            </Section>
          )}
          {(pack.tweet || pack.thread?.length > 0) && (
            <Section
              title="X / Twitter"
              copyAll={[pack.tweet, ...(pack.thread || [])].filter(Boolean).join("\n\n")}
            >
              {pack.tweet && <Item text={pack.tweet} muted />}
              {(pack.thread || []).map((t, i) => (
                <Item key={i} text={`${i + 1}/ ${t}`} muted />
              ))}
            </Section>
          )}
          {pack.linkedin && (
            <Section title="LinkedIn" copyAll={pack.linkedin}>
              <Item text={pack.linkedin} muted />
            </Section>
          )}
          {pack.instagram && (
            <Section title="Instagram" copyAll={pack.instagram}>
              <Item text={pack.instagram} muted />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
