/**
 * Description chunking for the mission PDF export.
 *
 * Step descriptions are stored as one long paragraph (the crucible template
 * packs Task / Pod / Deliverable / Verification / Reviewer / deadline into a
 * single block of prose). A wall of text is hard to act on, so at render
 * time the paragraph is forced into labeled chunks: one fact per chunk, the
 * label first, in the style of ADHD-friendly output (lead with the key fact,
 * no buried answers).
 *
 * FACT PRESERVATION IS ABSOLUTE: every word of the input survives in some
 * chunk. The transform only normalizes whitespace, drops the template
 * label phrases themselves (they become the chunk labels), and splits
 * "; "-joined clauses and unlabeled sentence runs apart. The stored
 * description is never modified.
 */

export interface DescriptionChunk {
  label: string | null;
  text: string;
}

/** Template labels, longest match strings first where they could overlap. */
const LABELS: Array<{ match: string; label: string }> = [
  {
    match:
      "Source files, inside the Crucible Resource Package linked as this step's resource:",
    label: 'Source files',
  },
  {
    match:
      'Submit your deliverable link from your profile on sedspakistan.live before the deadline:',
    label: 'Submit',
  },
  { match: 'Pod handoff:', label: 'Pod handoff' },
  { match: 'Faculty patron:', label: 'Faculty patron' },
  { match: 'Estimated time:', label: 'Estimated time' },
  { match: 'Deliverable:', label: 'Deliverable' },
  { match: 'Verification:', label: 'Verification' },
  { match: 'Candidate:', label: 'Candidate' },
  { match: 'Reviewer:', label: 'Reviewer' },
  { match: 'Charter:', label: 'Charter' },
  { match: 'Squad:', label: 'Squad' },
  { match: 'Pod:', label: 'Pod' },
];

interface LabelHit {
  index: number;
  match: string;
  label: string;
}

/**
 * Find every template-label occurrence, in order. A label only counts at a
 * word boundary (start of text or right after a space) so e.g. "Pod:" can
 * never fire inside another word.
 */
function findLabelHits(text: string): LabelHit[] {
  const hits: LabelHit[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let best: LabelHit | null = null;
    for (const { match, label } of LABELS) {
      let idx = text.indexOf(match, cursor);
      while (idx !== -1 && idx > 0 && text[idx - 1] !== ' ') {
        idx = text.indexOf(match, idx + 1);
      }
      if (
        idx !== -1 &&
        (!best ||
          idx < best.index ||
          (idx === best.index && match.length > best.match.length))
      ) {
        best = { index: idx, match, label };
      }
    }
    if (!best) break;
    hits.push(best);
    cursor = best.index + best.match.length;
  }
  return hits;
}

/** Honorifics/abbreviations whose trailing period never ends a sentence. */
const NO_SPLIT_TOKENS = new Set(['Prof', 'Dr', 'Mr', 'Mrs', 'Ms', 'St', 'vs', 'etc']);

/**
 * Split prose into sentences without breaking decimals ("1.5"), file paths
 * ("parts_list.csv"), or domains ("sedspakistan.live"): a split happens at
 * ". " only when the next character is an uppercase letter, and never right
 * after an honorific ("Prof. Dr. ...") or a single-letter initial.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '.' && text[i + 1] === ' ') {
      const next = text[i + 2];
      if (next && /[A-Z]/.test(next)) {
        // Word immediately before the period (letters only).
        let w = i - 1;
        while (w >= 0 && /[A-Za-z]/.test(text[w])) w--;
        const token = text.slice(w + 1, i);
        if (NO_SPLIT_TOKENS.has(token) || token.length === 1) continue;
        out.push(text.slice(start, i + 1));
        start = i + 2;
        i = start - 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Split a labeled value on "; " clause boundaries. */
function splitClauses(body: string): string[] {
  return body
    .split('; ')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function chunkDescription(text: string): DescriptionChunk[] {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const hits = findLabelHits(normalized);

  // No template labels at all: generic prose becomes one chunk per sentence.
  if (hits.length === 0) {
    return splitSentences(normalized).map((t) => ({ label: null, text: t }));
  }

  const chunks: DescriptionChunk[] = [];

  // Prelude before the first label. The crucible template opens with
  // "72-Hour Crucible task <ID>." which becomes the Task chunk.
  const prelude = normalized.slice(0, hits[0].index).trim();
  if (prelude) {
    const taskOpening =
      prelude.match(/^72-Hour Crucible task\s+(\S+)\.\s*(.*)$/) ||
      prelude.match(/^72-Hour Crucible task\s+(\S+)\s+(.*)$/) ||
      prelude.match(/^72-Hour Crucible task\s+(\S+)$/);
    if (taskOpening) {
      chunks.push({ label: 'Task', text: taskOpening[1] });
      const rest = (taskOpening[2] || '').trim();
      if (rest) {
        for (const s of splitSentences(rest)) chunks.push({ label: null, text: s });
      }
    } else {
      for (const s of splitSentences(prelude)) chunks.push({ label: null, text: s });
    }
  }

  hits.forEach((hit, i) => {
    const bodyStart = hit.index + hit.match.length;
    const bodyEnd = i + 1 < hits.length ? hits[i + 1].index : normalized.length;
    const body = normalized.slice(bodyStart, bodyEnd).trim();
    if (!body) return;
    // A labeled body in this template is one sentence or "; "-joined
    // clauses. Splitting clauses and then sentences also separates the
    // unlabeled boilerplate run that trails some sections (the sentences
    // between "Estimated time: 180 minutes." and "Charter:" live inside the
    // Estimated time segment, and become their own unlabeled chunks).
    const parts = splitClauses(body).flatMap((clause) => splitSentences(clause));
    parts.forEach((part, j) => {
      chunks.push({ label: j === 0 ? hit.label : null, text: part });
    });
  });

  return chunks.filter((c) => c.text.length > 0);
}
