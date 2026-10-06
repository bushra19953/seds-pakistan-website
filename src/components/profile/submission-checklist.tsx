'use client';

import { useMemo } from 'react';
import { ListChecks, Square, Info } from 'lucide-react';

// ── "What you need to submit" ─────────────────────────────────────────────
// Surfaces the proof requirements a task already states, right above the
// submission form, before the submitter fills anything in.
//
// Item derivation (verbatim from the task text, nothing invented):
//   1. The VERIFICATION section of the task description (the format the AI task
//      generator writes: WHAT / HOW / STANDARDS / RESOURCES / VERIFICATION).
//      Its body is split into checklist items on newlines, then semicolons,
//      then sentences. List markers (bullets, numbers) are stripped.
//   2. Otherwise the task's guidance.steps array, one item per step.
//   3. Otherwise a labeled box with the guidance description, or a short
//      excerpt of the task description, shown as-is (not a checklist).

const BRIEF_SECTIONS = ['WHAT', 'HOW', 'STANDARDS', 'RESOURCES', 'VERIFICATION'] as const;

function parseBriefing(description: string): { name: string; body: string }[] {
  const sections: { name: string; body: string }[] = [];
  const pattern = new RegExp(`^(${BRIEF_SECTIONS.join('|')}):\\s*`, 'gm');
  let match: RegExpExecArray | null;
  const indices: { name: string; start: number; bodyStart: number }[] = [];
  while ((match = pattern.exec(description)) !== null) {
    indices.push({ name: match[1], start: match.index, bodyStart: match.index + match[0].length });
  }
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1].start : description.length;
    const body = description.slice(indices[i].bodyStart, end).trim();
    if (body) sections.push({ name: indices[i].name, body });
  }
  return sections;
}

const stripListMarker = (s: string) =>
  s.replace(/^(\s*([-*•◦▪▸>]\s+|\d{1,2}[.)]\s+|\(\d{1,2}\)\s+))+/, '').trim();

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items
    .filter((i) => {
      const key = i.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

// Every returned item is a verbatim slice of the task text; nothing is added
// or reworded.
function splitIntoItems(body: string): string[] {
  const clean = (parts: string[]) =>
    parts.map((p) => stripListMarker(p)).filter((p) => p.length > 0);

  const lines = clean(body.split(/\r?\n/));
  if (lines.length > 1) return dedupe(lines);

  const semis = clean(body.split(/\s*;\s*/));
  if (semis.length > 1) return dedupe(semis);

  const sentences = clean(body.split(/(?<=\.)\s+(?=[A-Z0-9("'“])/));
  if (sentences.length > 1 && sentences.every((s) => s.length <= 220)) return dedupe(sentences);

  const single = stripListMarker(body.trim());
  return single ? [single] : [];
}

export type SubmissionSource = 'verification' | 'guidance-steps' | null;

export interface SubmissionTaskLike {
  description?: string | null;
  guidance?: { description?: string; steps?: string[] } | null;
}

export function deriveSubmissionChecklist(task: SubmissionTaskLike): {
  items: string[];
  source: SubmissionSource;
} {
  const sections = parseBriefing(task.description || '');
  const verification = sections.find((s) => s.name === 'VERIFICATION');
  if (verification) {
    const items = splitIntoItems(verification.body);
    if (items.length > 0) return { items, source: 'verification' };
  }
  const steps = (task.guidance?.steps || []).map((s) => (s || '').trim()).filter(Boolean);
  if (steps.length > 0) return { items: dedupe(steps), source: 'guidance-steps' };
  return { items: [], source: null };
}

// Fallback when there is no structured proof list: the guidance description,
// or a short excerpt of the task description, shown verbatim in a labeled box.
export function submissionGuidanceExcerpt(task: SubmissionTaskLike): {
  label: string;
  text: string;
} | null {
  const g = (task.guidance?.description || '').trim();
  if (g) return { label: 'How to complete this task', text: g };
  const d = (task.description || '').replace(/\s+/g, ' ').trim();
  if (!d) return null;
  const excerpt = d.length > 320 ? `${d.slice(0, 320).replace(/\s+\S*$/, '')}…` : d;
  return { label: 'From the task briefing', text: excerpt };
}

const SOURCE_CAPTION: Record<Exclude<SubmissionSource, null>, string> = {
  verification: 'Taken from the VERIFICATION section of this task',
  'guidance-steps': 'Taken from the execution guidance on this task',
};

export function SubmissionChecklist({ task }: { task: SubmissionTaskLike }) {
  const description = task?.description ?? null;
  const guidance = task?.guidance ?? null;
  const { items, source } = useMemo(
    () => deriveSubmissionChecklist({ description, guidance }),
    [description, guidance]
  );
  const fallback = useMemo(
    () => (items.length === 0 ? submissionGuidanceExcerpt({ description, guidance }) : null),
    [items.length, description, guidance]
  );

  if (items.length > 0) {
    return (
      <div className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-4 sm:p-5">
        <p className="text-[11px] font-black uppercase tracking-[0.25em] text-primary flex items-center gap-2 mb-3">
          <ListChecks className="h-4 w-4 shrink-0" /> What you need to submit
        </p>
        <ul className="space-y-2.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <Square className="h-4 w-4 mt-[3px] shrink-0 text-primary/70" aria-hidden="true" />
              <span className="text-sm text-foreground/90 leading-relaxed break-words">{item}</span>
            </li>
          ))}
        </ul>
        {source && (
          <p className="mt-3 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {SOURCE_CAPTION[source]}
          </p>
        )}
      </div>
    );
  }

  if (fallback) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card/40 p-4 sm:p-5">
        <p className="text-[11px] font-black uppercase tracking-[0.25em] text-muted-foreground flex items-center gap-2 mb-2">
          <Info className="h-4 w-4 shrink-0" /> {fallback.label}
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
          {fallback.text}
        </p>
      </div>
    );
  }

  return null;
}
