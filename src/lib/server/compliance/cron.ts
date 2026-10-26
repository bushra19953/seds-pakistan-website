/**
 * The compliance cron engine (phase2_spec.md Section G.5).
 *
 * Six passes, in order, each idempotent and independently failure-isolated
 * (one pass throwing never starves the others): owner resolution +
 * generator; reminders with per-recipient receipts; overdue; default
 * drafts; cure expiry; receipt repair. Held instances (seedHold,
 * Decision 16) are skipped by every pass - the engine does not act on
 * them until the hold is ruled on.
 *
 * HARD SEPARATION: this engine and its route never touch the member
 * discipline machinery (no writes to the task or warning collections, no
 * warning/points/blacklist fields). A grep test enforces the boundary in
 * both directions.
 *
 * Sends go to the LIVE resolved office holder (G.2) - never to
 * ownerUidSnapshot. notificationService.send does not report per-send
 * success, so a receipt records ok=true when the send call resolves and
 * ok=false when it throws; a missing recipient is retried next run
 * because an offset is only stamped once every intended recipient holds
 * an ok receipt for it.
 */

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { currentComplianceDb } from '@/lib/server/cron/compliance-db-context';
import { notificationService } from '@/lib/server/notification-service';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { FOUNDER_UID } from '@/lib/roles';
import { resolveObligationRecipients, NGS_ROLE_KEY, PRESIDENT_ROLE_KEY } from './owner-resolution';
import { resolveRoleHolders } from '@/lib/server/compliance-role-holders';
import { runGenerator } from './generator';
import { assertLegalTransition, isNonTerminal, ladderStateFor } from './transitions';
import { AUDIT_CHAIR_ROLE } from '@/lib/compliance/seed-data';
import type { ObligationStatus } from '@/lib/compliance/types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PassResult {
  ok: boolean;
  error?: string;
  counts: Record<string, number>;
}

export interface ComplianceCronSummary {
  ok: boolean;
  passes: {
    ownerResolution: PassResult;
    reminders: PassResult;
    overdue: PassResult;
    defaultDrafts: PassResult;
    cureExpiry: PassResult;
    receiptRepair: PassResult;
  };
}

type Firestore = admin.firestore.Firestore;

// Strict ISO-8601 shape: the only string form an adapter timestamp
// ever takes (the supa seam stores timestamps as ISO strings —
// scrubServerTimestamps / nowIso in compliance/supa-seam.ts). Anything
// else must never reach the Date parser: V8's parser is lenient enough
// to turn plain strings into dates ('ob-1' -> 2001-01-01, verified), so
// an unguarded parse rewrites non-date string fields wherever tsToDate
// is used as a generic value classifier (serialize.ts datesToIso).
const ISO_STRING_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function tsToDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  // Adapter-shaped values (cutover seam): adapter-written timestamps
  // arrive as ISO strings and dumped ones as SupaTimestamp (toDate
  // below). Without the string branch every adapter-served instance
  // would read as dateless and be silently skipped — the same
  // hotspot class G2 fixed in consent-service.
  //
  // The branch is GATED on the scoped compliance-db context: it exists
  // only for data served through the adapter handle, and that handle
  // is active exactly when a cron-pair route wraps its run in
  // runWithComplianceDb (getComplianceDb() returned the handle).
  // Outside the context — every API route and every flag-OFF run — a
  // string is a plain Firestore string field and reads as dateless,
  // byte-identical to the pre-seam function; the ungated branch broke
  // that by letting datesToIso rewrite string fields (e.g. an
  // obligation's embedded id 'ob-1' came back as
  // '2001-01-01T00:00:00.000Z').
  if (
    typeof value === 'string' &&
    currentComplianceDb() !== null &&
    ISO_STRING_RE.test(value)
  ) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  if (typeof value === 'number') return new Date(value);
  return null;
}

interface InstanceRow {
  id: string;
  ref: admin.firestore.DocumentReference;
  data: Record<string, any>;
  dueDate: Date;
  status: ObligationStatus;
}

async function loadInstances(db: Firestore): Promise<InstanceRow[]> {
  const snap = await db.collection('compliance_obligations').get();
  const rows: InstanceRow[] = [];
  snap.forEach((d) => {
    const data = d.data() as Record<string, any>;
    const dueDate = tsToDate(data.dueDate);
    if (!dueDate) return;
    rows.push({ id: d.id, ref: d.ref, data, dueDate, status: data.status as ObligationStatus });
  });
  return rows;
}

async function loadTemplates(db: Firestore): Promise<Map<string, Record<string, any>>> {
  const snap = await db.collection('compliance_templates').get();
  const map = new Map<string, Record<string, any>>();
  snap.forEach((d) => map.set(d.id, d.data() as Record<string, any>));
  return map;
}

async function transition(
  row: InstanceRow,
  to: ObligationStatus,
  extra: Record<string, unknown>,
  actorUid: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  assertLegalTransition(row.status, to);
  const from = row.status;
  await row.ref.update({
    status: to,
    ...extra,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  row.data.status = to;
  row.status = to;
  await writeGovernanceAuditOrThrow({
    actorUid,
    action,
    subjectType: 'compliance_obligation',
    subjectId: row.id,
    details: { ...details, from, to },
  });
}

async function sendSafe(uid: string, payload: { type: string; title: string; body: string; link: string }): Promise<boolean> {
  try {
    await notificationService.send(uid, payload, 'P1');
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ pass 1
async function passOwnerResolution(db: Firestore, rows: InstanceRow[]): Promise<PassResult> {
  const counts = { snapshotsUpdated: 0, vacant: 0, generated: 0 };
  const gen = await runGenerator(new Date());
  counts.generated = gen.created.length;

  for (const row of rows) {
    if (row.data.seedHold === true) continue;
    if (!isNonTerminal(row.status)) continue;
    const resolved = await resolveObligationRecipients(row.data.officeRole, row.data.chapterId ?? null);
    if (resolved.vacant) counts.vacant += 1;
    if (resolved.holderUid !== (row.data.ownerUidSnapshot ?? null)) {
      await row.ref.update({
        ownerUidSnapshot: resolved.holderUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      row.data.ownerUidSnapshot = resolved.holderUid;
      counts.snapshotsUpdated += 1;
    }
  }
  return { ok: true, counts };
}

// ------------------------------------------------------------------ pass 2
async function passReminders(
  db: Firestore,
  rows: InstanceRow[],
  templates: Map<string, Record<string, any>>,
  now: Date,
): Promise<PassResult> {
  const counts = { sent: 0, failed: 0, ladderAdvanced: 0 };
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();

  for (const row of rows) {
    if (row.data.seedHold === true) continue;
    if (!['scheduled', 'reminded_30', 'reminded_14', 'reminded_7', 'due'].includes(row.status)) continue;
    const template = templates.get(row.data.templateKey) ?? {};
    const offsets: number[] = Array.isArray(template.reminderOffsetsDays)
      ? template.reminderOffsetsDays
      : [30, 14, 7];
    const alsoNotified: string[] = Array.isArray(template.alsoNotifiedRoles) ? template.alsoNotifiedRoles : [];

    // LIVE resolution (G.2): the snapshot is never a routing source.
    const resolved = await resolveObligationRecipients(row.data.officeRole, row.data.chapterId ?? null);
    const extraRecipients = new Set<string>();
    for (const role of alsoNotified) {
      const holders = await resolveRoleHolders(role, row.data.chapterId ?? null);
      holders.forEach((h) => extraRecipients.add(h));
    }
    const intended = [...new Set([...resolved.recipients, ...extraRecipients])];

    const receipts: any[] = Array.isArray(row.data.reminderReceipts) ? [...row.data.reminderReceipts] : [];
    const remindersSent: Record<string, unknown> = { ...(row.data.remindersSent ?? { d30: null, d14: null, d7: null }) };
    let receiptsChanged = false;

    for (const offset of offsets) {
      const key = `d${offset}`;
      if (remindersSent[key] != null) continue;
      const offsetDueAt = row.dueDate.getTime() - offset * DAY_MS;
      if (now.getTime() < offsetDueAt) continue;

      const okUids = new Set(
        receipts.filter((r) => r.offsetDays === offset && r.ok).map((r) => r.uid as string),
      );
      const missing = intended.filter((uid) => !okUids.has(uid));
      for (const uid of missing) {
        const ok = await sendSafe(uid, {
          type: 'compliance_reminder',
          title: `Compliance reminder: ${row.data.title}`,
          body: `${row.data.title} is due ${row.dueDate.toISOString().slice(0, 10)} (office: ${row.data.officeRole}).${resolved.officeVacant ? ' The office is currently vacant; this notice routes to the Founder and NGS.' : ''}`,
          link: `/admin/compliance/obligations/${row.id}`,
        });
        receipts.push({ uid, offsetDays: offset, at: now, ok });
        receiptsChanged = true;
        if (ok) {
          okUids.add(uid);
          counts.sent += 1;
        } else {
          counts.failed += 1;
        }
      }
      if (intended.every((uid) => okUids.has(uid))) {
        remindersSent[key] = now;
      }
    }

    if (receiptsChanged) {
      await row.ref.update({ reminderReceipts: receipts, remindersSent, updatedAt: stamp() });
      row.data.reminderReceipts = receipts;
      row.data.remindersSent = remindersSent;
    }

    // Advance the ladder marker from dates (rungs may be skipped).
    const ladder = ladderStateFor(row.dueDate, offsets, now);
    const ladderRank = ['scheduled', 'reminded_30', 'reminded_14', 'reminded_7', 'due'];
    if (ladderRank.indexOf(ladder) > ladderRank.indexOf(row.status)) {
      assertLegalTransition(row.status, ladder as ObligationStatus);
      await row.ref.update({ status: ladder, updatedAt: stamp() });
      row.data.status = ladder;
      row.status = ladder as ObligationStatus;
      counts.ladderAdvanced += 1;
      await writeGovernanceAuditOrThrow({
        actorUid: 'system:compliance-cron',
        action: 'compliance.ladder_advanced',
        subjectType: 'compliance_obligation',
        subjectId: row.id,
        details: { to: ladder },
      });
    }
  }
  return { ok: true, counts };
}

// ------------------------------------------------------------------ pass 3
async function passOverdue(db: Firestore, rows: InstanceRow[], now: Date): Promise<PassResult> {
  const counts = { overdue: 0, notified: 0 };
  for (const row of rows) {
    if (row.data.seedHold === true) continue;
    // The G.4 critical guard is structural here: only 'due' instances are
    // candidates - evidence_submitted / under_review can never be marked
    // overdue by this pass (unreviewed evidence is the reviewer's delay).
    if (row.status !== 'due') continue;
    if (now.getTime() < row.dueDate.getTime() + DAY_MS) continue;

    await transition(
      row,
      'overdue',
      { overdueNotifiedAt: now },
      'system:compliance-cron',
      'compliance.overdue',
      { dueDate: row.dueDate.toISOString() },
    );
    counts.overdue += 1;

    const resolved = await resolveObligationRecipients(row.data.officeRole, row.data.chapterId ?? null);
    const ngs = await resolveRoleHolders(NGS_ROLE_KEY);
    const recipients = [...new Set([...resolved.recipients, FOUNDER_UID, ...ngs])];
    for (const uid of recipients) {
      const ok = await sendSafe(uid, {
        type: 'compliance_overdue',
        title: `Overdue compliance obligation: ${row.data.title}`,
        body: `${row.data.title} (office: ${row.data.officeRole}) was due ${row.dueDate.toISOString().slice(0, 10)} and is now overdue.`,
        link: `/admin/compliance/obligations/${row.id}`,
      });
      if (ok) counts.notified += 1;
    }
  }
  return { ok: true, counts };
}

// ------------------------------------------------------------------ pass 4
async function passDefaultDrafts(db: Firestore, rows: InstanceRow[], now: Date): Promise<PassResult> {
  const counts = { drafts: 0, digests: 0 };
  const newDrafts: { id: string; title: string }[] = [];

  for (const row of rows) {
    if (row.data.seedHold === true) continue;
    if (row.status !== 'overdue') continue;
    if (row.data.defaultNoticeId) continue;
    if (now.getTime() < row.dueDate.getTime() + 7 * DAY_MS) continue;

    const noticeRef = db.collection('default_notices').doc();
    await noticeRef.set({
      obligationId: row.id,
      templateKey: row.data.templateKey,
      officeRole: row.data.officeRole,
      issuedToUid: null,
      issuedToName: null,
      priorHolderUid: null,
      issuedBy: null,
      issuedAt: null,
      cureDeadline: null,
      deliveryReceipts: {
        founder: { method: 'notification', ref: null, at: null, ok: false },
        president: { method: 'notification', ref: null, at: null, ok: false },
      },
      cure: null,
      cureReview: null,
      outcome: 'open',
      escalatedAt: null,
      intervention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await transition(
      row,
      'default_draft',
      { defaultNoticeId: noticeRef.id },
      'system:compliance-cron',
      'compliance.default_draft_created',
      { noticeId: noticeRef.id },
    );
    counts.drafts += 1;
    newDrafts.push({ id: noticeRef.id, title: row.data.title });
  }

  if (newDrafts.length > 0) {
    // ONE digest per run to the Audit Chair, never one per draft (G.5).
    const chairs = await resolveRoleHolders(AUDIT_CHAIR_ROLE);
    for (const uid of chairs) {
      const ok = await sendSafe(uid, {
        type: 'compliance_default_digest',
        title: `${newDrafts.length} draft default notice(s) awaiting issue`,
        body: newDrafts.map((d) => d.title).join('; '),
        link: '/admin/compliance/notices',
      });
      if (ok) counts.digests += 1;
    }
  }
  return { ok: true, counts };
}

// ------------------------------------------------------------------ pass 5
async function passCureExpiry(db: Firestore, rows: InstanceRow[], now: Date): Promise<PassResult> {
  const counts = { escalated: 0, blockedByPendingCure: 0 };
  for (const row of rows) {
    if (row.data.seedHold === true) continue;
    if (row.status !== 'cure_period') continue;
    if (!row.data.defaultNoticeId) continue;

    const noticeRef = db.collection('default_notices').doc(row.data.defaultNoticeId as string);
    const noticeSnap = await noticeRef.get();
    if (!noticeSnap.exists) continue;
    const notice = noticeSnap.data() as Record<string, any>;
    const cureDeadline = tsToDate(notice.cureDeadline);
    if (!cureDeadline || now.getTime() <= cureDeadline.getTime()) continue;

    // A submitted-but-unreviewed cure BLOCKS escalation (G.4): the engine
    // escalates silence, not pending review.
    const cure = notice.cure as Record<string, any> | null;
    const cureReview = notice.cureReview as Record<string, any> | null;
    if (cure && !cureReview) {
      counts.blockedByPendingCure += 1;
      continue;
    }

    await noticeRef.update({
      outcome: 'escalated',
      escalatedAt: now,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await transition(
      row,
      'escalated',
      { escalation: { level: 'founder_notified', at: now, note: 'Cure period expired without an accepted cure' } },
      'system:compliance-cron',
      'compliance.escalated',
      { noticeId: noticeRef.id, cureDeadline: cureDeadline.toISOString() },
    );
    counts.escalated += 1;

    const presidents = await resolveRoleHolders(PRESIDENT_ROLE_KEY);
    const ngs = await resolveRoleHolders(NGS_ROLE_KEY);
    for (const uid of [...new Set([FOUNDER_UID, ...presidents, ...ngs])]) {
      await sendSafe(uid, {
        type: 'compliance_escalated',
        title: `Compliance default escalated: ${row.data.title}`,
        body: `${row.data.title} (office: ${row.data.officeRole}) passed its cure deadline without an accepted cure. Founder intervention is the next step.`,
        link: '/admin/compliance/notices',
      });
    }
  }
  return { ok: true, counts };
}

// ------------------------------------------------------------------ pass 6
async function passReceiptRepair(db: Firestore, now: Date): Promise<PassResult> {
  const counts = { repaired: 0, attempted: 0 };
  const snap = await db.collection('default_notices').where('issuedAt', '!=', null).get();
  for (const doc of snap.docs) {
    const notice = doc.data() as Record<string, any>;
    const receipts = notice.deliveryReceipts as Record<string, any> | undefined;
    if (!receipts) continue;
    const next = { ...receipts };
    let changed = false;

    const targets: { key: 'founder' | 'president'; uid: string | null }[] = [
      { key: 'founder', uid: FOUNDER_UID },
      { key: 'president', uid: null },
    ];
    if (targets[1].uid === null) {
      const presidents = await resolveRoleHolders(PRESIDENT_ROLE_KEY);
      targets[1].uid = presidents[0] ?? null;
    }

    for (const { key, uid } of targets) {
      const receipt = next[key] as Record<string, any> | undefined;
      if (!receipt || receipt.ok === true || !uid) continue;
      counts.attempted += 1;
      const ok = await sendSafe(uid, {
        type: 'compliance_default_notice_copy',
        title: 'Copy of default notice (retry)',
        body: `Copy of the default notice for obligation ${notice.obligationId} (office: ${notice.officeRole}).`,
        link: '/admin/compliance/notices',
      });
      if (ok) {
        next[key] = { method: 'notification', ref: 'notificationService', at: now, ok: true };
        changed = true;
        counts.repaired += 1;
      }
    }

    if (changed) {
      await doc.ref.update({
        deliveryReceipts: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
  return { ok: true, counts };
}

// -------------------------------------------------------------------- main
export async function runComplianceCron(now: Date): Promise<ComplianceCronSummary> {
  // Seam (cutover, compliance-db-context): inside the cron route's
  // scoped context this is the adapter handle; everywhere else it is
  // exactly the getDb() this engine always self-acquired.
  const db = currentComplianceDb() ?? getDb();
  const empty: PassResult = { ok: false, error: 'db unavailable', counts: {} };
  const summary: ComplianceCronSummary = {
    ok: false,
    passes: {
      ownerResolution: { ...empty },
      reminders: { ...empty },
      overdue: { ...empty },
      defaultDrafts: { ...empty },
      cureExpiry: { ...empty },
      receiptRepair: { ...empty },
    },
  };
  if (!db) return summary;

  const rows = await loadInstances(db);
  const templates = await loadTemplates(db);
  const isolate = async (
    key: keyof ComplianceCronSummary['passes'],
    fn: () => Promise<PassResult>,
  ): Promise<void> => {
    try {
      summary.passes[key] = await fn();
    } catch (err) {
      summary.passes[key] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        counts: {},
      };
    }
  };

  await isolate('ownerResolution', () => passOwnerResolution(db, rows));
  // Pass 1 may have generated new instances; reload so later passes see them.
  const freshRows = await loadInstances(db);
  await isolate('reminders', () => passReminders(db, freshRows, templates, now));
  await isolate('overdue', () => passOverdue(db, freshRows, now));
  await isolate('defaultDrafts', () => passDefaultDrafts(db, freshRows, now));
  await isolate('cureExpiry', () => passCureExpiry(db, freshRows, now));
  await isolate('receiptRepair', () => passReceiptRepair(db, now));

  summary.ok = Object.values(summary.passes).every((p) => p.ok);
  return summary;
}
