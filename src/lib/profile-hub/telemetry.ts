/**
 * Profile Hub (WS3): pure helpers for the Member Profile Hub.
 *
 * Data sources this module normalises:
 * - `tasks` collection docs: status ('completed' etc.), deadline,
 *   completedAt, hoursWorked, points, deliverableFiles
 *   ({ fileName, downloadUrl, sizeBytes }), resourceLinks (newline string
 *   or string[]), workflowTitle, workflowId.
 * - `points_ledger` collection docs (snake_case writes from
 *   src/lib/server/gamification-transaction.ts): user_id, task_id,
 *   action ('COMPLETION' | 'PENALTY' | ...), points_awarded,
 *   completed_late, timestamp. Older/camelCase shapes (userId, pointsAwarded)
 *   are tolerated.
 * - `users/{uid}/warnings` docs and the warning counters on the user doc
 *   (shape: src/types/user.ts UserWarning).
 *
 * Everything here is pure and unit tested. No Firestore imports.
 */

export type AnyRecord = Record<string, any>;

export function toDateSafe(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'number') {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value?.seconds === 'number') {
    const d = new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function num(value: any): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normalise an assignment field pair (assigneeId / assigneeIds[]) to uids. */
export function taskAssigneeIds(task: AnyRecord): string[] {
  const ids: string[] = [];
  if (typeof task?.assigneeId === 'string' && task.assigneeId) ids.push(task.assigneeId);
  if (Array.isArray(task?.assigneeIds)) {
    for (const id of task.assigneeIds) {
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function isCompletedTask(task: AnyRecord): boolean {
  return String(task?.status || '').toLowerCase() === 'completed';
}

/**
 * Proof attached to a task: uploaded deliverable files plus resource links.
 * Mirrors the shapes rendered by task-detail-dialog.tsx and task-history.tsx.
 */
export interface ProofLink {
  url: string;
  label: string;
  kind: 'file' | 'link';
}

export function extractProofLinks(task: AnyRecord): ProofLink[] {
  const out: ProofLink[] = [];
  const seen = new Set<string>();
  const push = (url: string, label: string, kind: ProofLink['kind']) => {
    const clean = String(url || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({ url: clean, label: label || clean, kind });
  };
  if (Array.isArray(task?.deliverableFiles)) {
    for (const f of task.deliverableFiles) {
      if (f && typeof f.downloadUrl === 'string') {
        push(f.downloadUrl, f.fileName || 'Deliverable file', 'file');
      }
    }
  }
  const rawLinks: any = task?.resourceLinks;
  const links: string[] = Array.isArray(rawLinks)
    ? rawLinks.filter((l: any) => typeof l === 'string')
    : typeof rawLinks === 'string'
      ? rawLinks.split('\n')
      : [];
  for (const link of links) push(link.trim(), link.trim(), 'link');
  if (typeof task?.proofUrl === 'string') push(task.proofUrl, 'Proof', 'link');
  if (Array.isArray(task?.proofUrls)) {
    for (const u of task.proofUrls) if (typeof u === 'string') push(u, 'Proof', 'link');
  }
  return out;
}

export interface MissionTimelineEntry {
  taskId: string;
  title: string;
  workflowTitle: string | null;
  workflowId: string | null;
  completedAt: string | null;
  deadline: string | null;
  wasOnTime: boolean | null;
  hoursWorked: number;
  points: number;
  proof: ProofLink[];
}

/** Chronological (newest first) audit trail of completed tasks. */
export function buildMissionTimeline(tasks: AnyRecord[]): MissionTimelineEntry[] {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && isCompletedTask(t))
    .map((t) => {
      const completedAt = toDateSafe(t.completedAt) || toDateSafe(t.updatedAt);
      const deadline = toDateSafe(t.deadline);
      return {
        taskId: String(t.id || ''),
        title: String(t.title || 'Untitled task'),
        workflowTitle: typeof t.workflowTitle === 'string' ? t.workflowTitle : null,
        workflowId: typeof t.workflowId === 'string' ? t.workflowId : null,
        completedAt: completedAt ? completedAt.toISOString() : null,
        deadline: deadline ? deadline.toISOString() : null,
        wasOnTime:
          completedAt && deadline ? completedAt.getTime() <= deadline.getTime() : null,
        hoursWorked: num(t.hoursWorked) ?? 0,
        points: num(t.points) ?? 0,
        proof: extractProofLinks(t),
      } as MissionTimelineEntry;
    })
    .sort((a, b) => {
      const at = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bt - at;
    });
}

export interface Telemetry {
  tasksAssigned: number;
  tasksCompleted: number;
  /** 0..1, or null when no completed task has both a deadline and a completion time. */
  onTimeRate: number | null;
  onTimeCount: number;
  lateCount: number;
  loggedHours: number;
  totalPoints: number;
  penaltiesApplied: number;
  /**
   * 0..100, or null when there is nothing to score.
   * Basis 'explicit' when reviewer scores exist on tasks
   * (qualityScore / reviewScore / qualityRating / rating, 0..5 values are
   * scaled to 100). No task in the current schema writes those fields, so in
   * practice the basis is 'derived': 60% on-time rate + 40% completion rate.
   * Callers must show the basis; a derived index is not a reviewer grade.
   */
  qualityIndex: number | null;
  qualityIndexBasis: 'explicit' | 'derived' | null;
}

function explicitQualityScores(tasks: AnyRecord[]): number[] {
  const scores: number[] = [];
  for (const t of tasks) {
    if (!t || !isCompletedTask(t)) continue;
    for (const key of ['qualityScore', 'reviewScore', 'qualityRating', 'rating']) {
      const v = num(t[key]);
      if (v === null) continue;
      const scaled = v <= 5 ? (v / 5) * 100 : v;
      scores.push(Math.min(100, Math.max(0, scaled)));
      break;
    }
  }
  return scores;
}

export function computeTelemetry(input: {
  tasks?: AnyRecord[];
  ledgerEntries?: AnyRecord[];
  counters?: AnyRecord | null;
}): Telemetry {
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter(Boolean) : [];
  const ledger = Array.isArray(input.ledgerEntries) ? input.ledgerEntries.filter(Boolean) : [];
  const counters = input.counters || {};

  const completed = tasks.filter(isCompletedTask);
  const tasksAssigned = Math.max(
    tasks.length,
    num(counters.tasksAssignedCount) ?? 0,
  );
  const tasksCompleted = Math.max(
    completed.length,
    num(counters.tasksCompletedCount) ?? 0,
  );

  let onTimeCount = 0;
  let datedCompletions = 0;
  let lateCount = 0;
  for (const t of completed) {
    const completedAt = toDateSafe(t.completedAt) || toDateSafe(t.updatedAt);
    const deadline = toDateSafe(t.deadline);
    if (completedAt && deadline) {
      datedCompletions += 1;
      if (completedAt.getTime() <= deadline.getTime()) onTimeCount += 1;
      else lateCount += 1;
    }
  }
  // Ledger completed_late is the server-side record of lateness; prefer it
  // for tasks whose deadline field was later edited.
  const ledgerLate = ledger.filter(
    (e) => e && (e.completed_late === true || e.completedLate === true),
  ).length;
  if (ledgerLate > lateCount) lateCount = ledgerLate;

  const taskHours = completed.reduce((sum, t) => sum + (num(t.hoursWorked) ?? 0), 0);
  const loggedHours = Math.max(taskHours, num(counters.totalHoursWorked) ?? 0);

  const ledgerPoints = ledger.reduce(
    (sum, e) => sum + (num(e?.points_awarded) ?? num(e?.pointsAwarded) ?? 0),
    0,
  );
  const taskPoints = completed.reduce((sum, t) => sum + (num(t.points) ?? 0), 0);
  const totalPoints = Math.max(ledgerPoints, taskPoints, num(counters.points) ?? 0);
  const penaltiesApplied = ledger
    .filter((e) => String(e?.action || '').toUpperCase() === 'PENALTY')
    .reduce((sum, e) => sum + (num(e?.penalty_applied) ?? num(e?.penaltyApplied) ?? 0), 0)
    + completed.reduce((sum, t) => sum + (num(t.penaltyPoints) ?? 0), 0);

  const explicit = explicitQualityScores(tasks);
  let qualityIndex: number | null = null;
  let qualityIndexBasis: Telemetry['qualityIndexBasis'] = null;
  if (explicit.length > 0) {
    qualityIndex = Math.round(explicit.reduce((a, b) => a + b, 0) / explicit.length);
    qualityIndexBasis = 'explicit';
  } else if (datedCompletions > 0 && tasksAssigned > 0) {
    const onTimeRate = onTimeCount / datedCompletions;
    const completionRate = Math.min(1, tasksCompleted / tasksAssigned);
    qualityIndex = Math.round(100 * (0.6 * onTimeRate + 0.4 * completionRate));
    qualityIndexBasis = 'derived';
  }

  return {
    tasksAssigned,
    tasksCompleted,
    onTimeRate: datedCompletions > 0 ? onTimeCount / datedCompletions : null,
    onTimeCount,
    lateCount,
    loggedHours,
    totalPoints,
    penaltiesApplied,
    qualityIndex,
    qualityIndexBasis,
  };
}

// --- Probation (warnings) ---------------------------------------------------

export interface ProbationSummary {
  activeWarningCount: number;
  isBlacklisted: boolean;
  isBanned: boolean;
  /** ISO date the earliest active warning expires, or null (none / permanent). */
  nextExpiryAt: string | null;
  /** Whole days until nextExpiryAt (ceil), or null. */
  daysUntilNextExpiry: number | null;
  hasPermanentWarning: boolean;
  warnings: Array<{
    id: string;
    reason: string;
    type: string | null;
    severity: string | null;
    createdAt: string | null;
    expiresAt: string | null;
    isPermanent: boolean;
    taskId: string | null;
    taskTitle: string | null;
  }>;
  redemptionChecklist: string[];
}

/**
 * Active = not revoked, isActive is not false, and not expired at `now`.
 * Matches the expiry filter already applied in /api/profile/[userId].
 */
export function summarizeWarnings(
  rawWarnings: AnyRecord[],
  user: AnyRecord | null | undefined,
  now: Date = new Date(),
  blacklistThreshold = 3,
): ProbationSummary {
  const warnings = (Array.isArray(rawWarnings) ? rawWarnings : [])
    .filter((w) => {
      if (!w || w.revokedAt || w.revokedBy) return false;
      if (w.isActive === false) return false;
      const expiresAt = toDateSafe(w.expiresAt);
      if (!w.isPermanent && expiresAt && expiresAt.getTime() <= now.getTime()) return false;
      return true;
    })
    .map((w) => {
      const expiresAt = w.isPermanent ? null : toDateSafe(w.expiresAt);
      return {
        id: String(w.id || ''),
        reason: String(w.reason || 'Warning'),
        type: typeof w.type === 'string' ? w.type : null,
        severity: typeof w.severity === 'string' ? w.severity : null,
        createdAt: toDateSafe(w.createdAt)?.toISOString() ?? null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        isPermanent: w.isPermanent === true,
        taskId: typeof w.taskId === 'string' ? w.taskId : null,
        taskTitle: typeof w.taskTitle === 'string' ? w.taskTitle : null,
      };
    })
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  const expiries = warnings
    .map((w) => w.expiresAt)
    .filter((x): x is string => !!x)
    .sort();
  const nextExpiryAt = expiries[0] ?? null;
  const daysUntilNextExpiry = nextExpiryAt
    ? Math.max(0, Math.ceil((new Date(nextExpiryAt).getTime() - now.getTime()) / 86400000))
    : null;

  const isBlacklisted = user?.isBlacklisted === true;
  const isBanned = user?.isBanned === true;

  const redemptionChecklist: string[] = [];
  if (warnings.length > 0) {
    redemptionChecklist.push('Complete your next assigned tasks on or before their deadlines.');
    redemptionChecklist.push('Attach proof (deliverable files or resource links) to every submission.');
    for (const w of warnings) {
      redemptionChecklist.push(
        w.taskTitle
          ? `Close out the warning from "${w.taskTitle}": ${w.reason}`
          : `Address this warning before it expires: ${w.reason}`,
      );
    }
    if (isBlacklisted || warnings.length >= blacklistThreshold) {
      redemptionChecklist.push(
        'Your warning level is at the blacklist threshold. Contact your chapter president about an appeal.',
      );
    }
  }

  return {
    activeWarningCount: warnings.length,
    isBlacklisted,
    isBanned,
    nextExpiryAt,
    daysUntilNextExpiry,
    hasPermanentWarning: warnings.some((w) => w.isPermanent),
    warnings,
    redemptionChecklist,
  };
}

/** Probation data may only ever be shown to the member or an admin. */
export function canViewProbation(input: {
  requesterUid: string | null;
  targetUid: string;
  isAdmin: boolean;
}): boolean {
  if (input.isAdmin) return true;
  return !!input.requesterUid && input.requesterUid === input.targetUid;
}

// --- Public portfolio --------------------------------------------------------
/**
 * Shared-field decision (WS3 + Privacy workstream, aligned 2026-10-20):
 * the canonical field is `publicDirectoryOptIn` (see
 * src/lib/privacy.ts PUBLIC_DIRECTORY_OPT_IN_FIELD). This module re-exports
 * the Privacy workstream's resolver as the single source of truth:
 * an explicit stored boolean wins; when absent, members default to false
 * and executives default to true. Contact fields are never public either way
 * (see /api/public/portfolio/[username]).
 */
export { resolvePublicDirectoryOptIn, defaultPublicDirectoryOptIn } from '@/lib/privacy';

export function slugifyUsername(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isValidUsername(raw: unknown): boolean {
  return typeof raw === 'string' && /^[a-z0-9-]{3,40}$/.test(raw);
}

/** Username for a user doc: explicit `username` field, else slug of displayName. */
export function usernameForUser(user: AnyRecord): string {
  if (typeof user?.username === 'string' && user.username) return slugifyUsername(user.username);
  return slugifyUsername(user?.displayName || '');
}

export interface PublicPortfolioProfile {
  uid: string;
  username: string;
  displayName: string;
  bio: string;
  role: string | null;
  customTitle: string | null;
  university: string | null;
  fieldOfStudy: string | null;
  chapterId: string | null;
  photoURL: string | null;
  bannerURL: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
  points: number;
  badges: string[];
  skillIds: string[];
}

/**
 * Sanitised public view of a user doc. Allow-list only: email, whatsapp /
 * whatsappNumber, warning and ban fields, managerId and every other stored
 * field are dropped by construction, not by block-list.
 */
export function sanitizePublicProfile(user: AnyRecord, uid: string): PublicPortfolioProfile {
  return {
    uid,
    username: usernameForUser(user),
    displayName: String(user?.displayName || ''),
    bio: String(user?.bio || ''),
    role: typeof user?.displayRole === 'string' ? user.displayRole : typeof user?.role === 'string' ? user.role : null,
    customTitle: typeof user?.customTitle === 'string' ? user.customTitle : null,
    university: typeof user?.university === 'string' ? user.university : null,
    fieldOfStudy: typeof user?.fieldOfStudy === 'string' ? user.fieldOfStudy : null,
    chapterId: typeof user?.chapterId === 'string' ? user.chapterId : null,
    photoURL: typeof user?.photoURL === 'string' ? user.photoURL : null,
    bannerURL: typeof user?.bannerURL === 'string' ? user.bannerURL : null,
    githubUrl: typeof user?.githubUrl === 'string' ? user.githubUrl : null,
    linkedinUrl: typeof user?.linkedinUrl === 'string' ? user.linkedinUrl : null,
    points: num(user?.points) ?? 0,
    badges: Array.isArray(user?.badges) ? user.badges.filter((b: any) => typeof b === 'string').slice(0, 100) : [],
    skillIds: Array.isArray(user?.skillIds) ? user.skillIds.filter((s: any) => typeof s === 'string').slice(0, 30) : [],
  };
}

/** Public timeline: proof links are private (Drive files), so they are stripped. */
export function toPublicTimeline(entries: MissionTimelineEntry[]) {
  return entries.map(({ proof: _proof, ...rest }) => rest);
}

// --- Certificates / credential vault ----------------------------------------

/**
 * Existing verification engine: page /verify/[code] backed by
 * GET /api/v1/certificates/verify/[code], keyed by the certificate `code`
 * field (there is no /verify/:certId route). Vault links use `code`.
 */
export function buildCertificateVerificationUrl(code: string, baseUrl = ''): string {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/verify/${encodeURIComponent(String(code || ''))}`;
}

export function buildLinkedInShareUrl(verificationUrl: string, title: string): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(verificationUrl)}`;
}

export function buildLinkedInAddToProfileUrl(input: {
  title: string;
  verificationUrl: string;
  issueDate?: Date | string | null;
}): string {
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: input.title || 'SEDS Pakistan Certificate',
    organizationName: 'SEDS Pakistan',
    certUrl: input.verificationUrl,
  });
  const d = input.issueDate ? toDateSafe(input.issueDate) : null;
  if (d) {
    params.set('issueYear', String(d.getUTCFullYear()));
    params.set('issueMonth', String(d.getUTCMonth() + 1));
  }
  return `https://www.linkedin.com/profile/add?${params.toString()}`;
}

export function sanitizeCertificateForVault(cert: AnyRecord, baseUrl = '') {
  const code = typeof cert?.code === 'string' ? cert.code : '';
  const issueDate = toDateSafe(cert?.issueDate);
  return {
    id: String(cert?.id || ''),
    title: String(cert?.title || cert?.achievement || cert?.eventName || 'Certificate'),
    certificateType: typeof cert?.certificateType === 'string' ? cert.certificateType : null,
    description: typeof cert?.description === 'string' ? cert.description : null,
    issuingAuthority: typeof cert?.issuingAuthority === 'string' ? cert.issuingAuthority : typeof cert?.issuerName === 'string' ? cert.issuerName : null,
    issueDate: issueDate ? issueDate.toISOString() : null,
    status: cert?.status === 'revoked' ? 'revoked' : 'issued',
    code,
    verificationUrl: code ? buildCertificateVerificationUrl(code, baseUrl) : null,
  };
}
