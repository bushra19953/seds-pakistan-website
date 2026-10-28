/**
 * Named-Reviewer Resolution (Server-side)
 *
 * A task's named reviewer is the user designated at creation to verify
 * the work. Two storage shapes exist:
 *
 *  1. `reviewerId` on the task doc — stamped by POST /api/tasks, by
 *     PATCH /api/tasks updates, and (workflow level + per-step) by
 *     POST /api/workflows. This is the canonical field going forward.
 *  2. The crucible template's "Reviewer:" line inside the step
 *     DESCRIPTION text — the only place workflow creation recorded the
 *     reviewer before the workflows route accepted the field (the task
 *     form's reviewer selection was dropped by the workflow submit
 *     path, and the workflows schema had no reviewer field). The
 *     mission PDF prints its REVIEWER label from this same line
 *     (see src/lib/description-chunks.ts), so this text is the record
 *     of who was named. Existing workflow steps carry no reviewerId;
 *     resolving the names here makes them reviewable by their named
 *     reviewers with no data migration.
 *
 * Name resolution is fail-closed: a name resolves only when EXACTLY
 * ONE user doc carries that displayName. Zero matches (name not on
 * the platform) or multiple matches (ambiguous) resolve to nobody —
 * never guess a person by name (standing rule: people are identified
 * by email/uid, and a wrong-person grant is worse than no grant).
 */

import { getDb } from '@/lib/server/firebase-admin';

export interface ReviewerTaskLike {
  reviewerId?: unknown;
  description?: unknown;
}

/**
 * Template labels that terminate a "Reviewer:" segment — the same
 * label set the description chunker splits on (description-chunks.ts),
 * minus the Reviewer label itself. The two long matches are verbatim.
 */
const SEGMENT_TERMINATORS: string[] = [
  'Source files, inside the Crucible Resource Package linked as this step\'s resource:',
  'Submit your deliverable link from your profile on sedspakistan.live before the deadline:',
  'Pod handoff:',
  'Faculty patron:',
  'Estimated time:',
  'Deliverable:',
  'Verification:',
  'Candidate:',
  'Charter:',
  'Squad:',
  'Pod:',
];

/**
 * Extract the reviewer display names from a task description's
 * "Reviewer:" template segment. Names are " / "-separated, each
 * optionally followed by a parenthesised role, e.g.
 * "Reviewer: Bushra Rahman (Lead Coder / Autonomy Lead) / Ahmed Ali
 * Kamran (Chapter Vice President). Faculty patron: ..." yields
 * ["Bushra Rahman", "Ahmed Ali Kamran"]. Returns [] when the
 * description carries no Reviewer segment.
 */
export function parseReviewerNames(description: unknown): string[] {
  if (typeof description !== 'string' || !description) return [];
  const text = description.replace(/\s+/g, ' ');

  // Find "Reviewer:" at a word boundary (start or after a space),
  // mirroring the chunker's label matching.
  let start = -1;
  let idx = text.indexOf('Reviewer:');
  while (idx !== -1) {
    if (idx === 0 || text[idx - 1] === ' ') { start = idx; break; }
    idx = text.indexOf('Reviewer:', idx + 1);
  }
  if (start === -1) return [];

  const segStart = start + 'Reviewer:'.length;
  let segEnd = text.length;
  for (const term of SEGMENT_TERMINATORS) {
    let tIdx = text.indexOf(term, segStart);
    while (tIdx !== -1 && tIdx > segStart && text[tIdx - 1] !== ' ') {
      tIdx = text.indexOf(term, tIdx + 1);
    }
    if (tIdx !== -1 && tIdx < segEnd) segEnd = tIdx;
  }

  // Strip the parenthesised roles BEFORE splitting on " / ": a role
  // can itself contain the separator ("(Lead Coder / Autonomy Lead)").
  const segment = text
    .slice(segStart, segEnd)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .trim();
  if (!segment) return [];

  const names: string[] = [];
  for (const part of segment.split(/\s+\/\s+/)) {
    const name = part.trim().replace(/\.$/, '').trim();
    if (name.length >= 2 && /[A-Za-z]/.test(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

const NAME_CACHE_TTL_MS = 5 * 60 * 1000;

// Per-db name-resolution cache (name -> uid | null). Keyed by the db
// instance so tests with fresh in-memory stores never see another
// store's resolutions; production uses one db singleton, so the cache
// is effective there. Nulls are cached too: an unresolvable name
// should not cost a query on every validation check.
const nameCacheByDb = new WeakMap<object, Map<string, { uid: string | null; at: number }>>();

async function resolveReviewerNameToUid(
  db: FirebaseFirestore.Firestore,
  name: string
): Promise<string | null> {
  let cache = nameCacheByDb.get(db);
  if (!cache) {
    cache = new Map();
    nameCacheByDb.set(db, cache);
  }
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.uid;

  let uid: string | null = null;
  const snap = await db.collection('users').where('displayName', '==', name).limit(2).get();
  if (snap.size === 1) {
    uid = snap.docs[0].id;
  }
  cache.set(name, { uid, at: Date.now() });
  return uid;
}

/**
 * Resolve every uid named as this task's reviewer: the canonical
 * `reviewerId` field when present, otherwise the reviewers named in
 * the description's "Reviewer:" segment. Never throws on missing
 * data; a resolution read failure propagates to the caller, which
 * decides (validation treats it as "door not proven", never a grant).
 */
export async function resolveTaskReviewerUids(
  db: FirebaseFirestore.Firestore,
  task: ReviewerTaskLike
): Promise<string[]> {
  const direct = typeof task.reviewerId === 'string' ? task.reviewerId.trim() : '';
  if (direct) return [direct];

  const names = parseReviewerNames(task.description);
  const uids: string[] = [];
  for (const name of names) {
    const uid = await resolveReviewerNameToUid(db, name);
    if (uid && !uids.includes(uid)) uids.push(uid);
  }
  return uids;
}

/**
 * Convenience wrapper using the shared Admin db. Returns [] when the
 * db is unavailable so notification fan-outs can treat "no reviewer
 * resolvable" as "no reviewer" without failing.
 */
export async function getTaskReviewerUids(task: ReviewerTaskLike): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  return resolveTaskReviewerUids(db, task);
}
