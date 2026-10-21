/**
 * Quarterly report generation + delivery service (phase2_spec.md G.10).
 *
 * Generation: reads the three sources, resolves CURRENT holders per
 * office, runs the pure aggregator, renders the PDF, uploads the PDF to
 * Google Drive (kind 'document' - UploadKind has no 'governance' yet),
 * and writes compliance_reports/{quarterKey}. Regeneration REVISES the
 * same doc (revision + 1, new PDF) and never touches deliveryHistory -
 * history is appended only by an actual delivery.
 *
 * Delivery: broadcastByRoles to the governance display-roles plus the
 * Audit Chair holder by uid, carrying the Drive link and summary counts.
 * On successful delivery, an open quarterly-compliance-report instance
 * for that quarter completes exactly once with completedVia
 * 'report_delivery' - the engine eats its own cooking.
 */

import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { buildQuarterlyReport, quarterWindow, type QuarterlyReportData } from './report-aggregator';
import { renderQuarterlyReportPdf } from '@/lib/compliance/compliance-report-pdf';
import { resolveObligationRecipients } from './owner-resolution';
import { resolveRoleHolders } from '@/lib/server/role-holders';
import { notificationService } from '@/lib/server/notification-service';
import { uploadToVault } from '@/lib/drive/client';
import { AUDIT_CHAIR_ROLE } from '@/lib/compliance/seed-data';

export interface ReportDoc {
  quarterKey: string;
  generatedAt: unknown;
  generatedBy: 'cron' | 'manual';
  pdfDriveFileId: string | null;
  pdfUrl: string | null;
  revision: number;
  deliveryHistory: { at: unknown; recipients: string[]; channel: 'notification' }[];
  summarySnapshot: QuarterlyReportData['summary'] | null;
}

function withIds(snap: admin.firestore.QuerySnapshot): Record<string, any>[] {
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) }));
}

export async function generateQuarterlyReport(
  quarterKey: string,
  generatedBy: 'cron' | 'manual',
  now: Date = new Date(),
): Promise<{ report: QuarterlyReportData; revision: number; pdfUrl: string | null }> {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');
  if (!quarterWindow(quarterKey)) throw new Error(`Invalid quarterKey: ${quarterKey}`);

  const [obligationsSnap, noticesSnap, auditSnap] = await Promise.all([
    db.collection('compliance_obligations').get(),
    db.collection('default_notices').get(),
    db.collection('audit_logs').where('governance', '==', true).get().catch(() => null),
  ]);
  const obligations = withIds(obligationsSnap);
  const defaultNotices = withIds(noticesSnap);
  const auditLogs = auditSnap ? withIds(auditSnap) : [];

  // Resolve current holders for every office that appears.
  const officeKeys = new Map<string, { officeRole: string; chapterId: string | null }>();
  for (const o of obligations) {
    const chapterId = (o.chapterId as string | null) ?? null;
    officeKeys.set(`${o.officeRole}::${chapterId ?? ''}`, { officeRole: o.officeRole as string, chapterId });
  }
  const holdersByOffice: Record<string, string | null> = {};
  for (const [key, { officeRole, chapterId }] of officeKeys) {
    const resolved = await resolveObligationRecipients(officeRole, chapterId);
    holdersByOffice[key] = resolved.holderUid;
  }

  const report = buildQuarterlyReport(
    quarterKey,
    { obligations, defaultNotices, auditLogs, holdersByOffice },
    { now },
  );

  // PDF -> Drive (bytes never stored in Firestore).
  const pdfBytes = renderQuarterlyReportPdf(report);
  const upload = await uploadToVault(
    `compliance-report-${quarterKey}-rev.pdf`,
    'application/pdf',
    Buffer.from(pdfBytes),
  );

  const ref = db.collection('compliance_reports').doc(quarterKey);
  const existing = await ref.get();
  const revision = existing.exists ? ((existing.data()?.revision as number) ?? 0) + 1 : 1;
  await ref.set(
    {
      quarterKey,
      generatedAt: now,
      generatedBy,
      pdfDriveFileId: upload.fileId,
      pdfUrl: upload.webViewLink,
      revision,
      summarySnapshot: report.summary,
      // deliveryHistory is preserved across regenerations (set-merge
      // keeps it because the field is only written on first creation).
      ...(existing.exists ? {} : { deliveryHistory: [] }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { report, revision, pdfUrl: upload.webViewLink };
}

export async function deliverQuarterlyReport(
  quarterKey: string,
  actorUid: string,
  now: Date = new Date(),
): Promise<{ deliveredTo: string[]; completedInstanceId: string | null }> {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');
  const ref = db.collection('compliance_reports').doc(quarterKey);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('REPORT_NOT_GENERATED');
  const doc = snap.data() as ReportDoc;
  const summary = doc.summarySnapshot;

  const payload = {
    type: 'compliance_quarterly_report',
    title: `Quarterly compliance report ${quarterKey}`,
    body: summary
      ? `Due ${summary.dueInQuarter}, completed on time ${summary.completedOnTime}, late ${summary.completedLate}, overdue ${summary.overdueOpen}, in default ${summary.inDefault}, cured ${summary.cured}, escalated ${summary.escalated}. Report: ${doc.pdfUrl ?? ''}`
      : `The quarterly compliance report for ${quarterKey} is ready: ${doc.pdfUrl ?? ''}`,
    link: doc.pdfUrl ?? '/admin/compliance',
  };

  const broadcast = await notificationService.broadcastByRoles(
    ['founder_patron', 'governor_founder', 'governor_coopted'],
    payload,
    'P1',
  );
  const recipients: string[] = broadcast.notifiedUsers.map((u) => u.id);

  // The Audit Chair holder is a uid-resolved recipient in addition to
  // the display-role broadcast.
  const chairs = await resolveRoleHolders(AUDIT_CHAIR_ROLE);
  for (const chairUid of chairs) {
    if (!recipients.includes(chairUid)) {
      await notificationService.send(chairUid, payload, 'P1');
      recipients.push(chairUid);
    }
  }

  const history = Array.isArray(doc.deliveryHistory) ? [...doc.deliveryHistory] : [];
  history.push({ at: now, recipients, channel: 'notification' as const });
  await ref.update({
    deliveryHistory: history,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Close the loop: an open quarterly-compliance-report instance for this
  // quarter completes exactly once via 'report_delivery'.
  const parsed = /^FY\d{2}-Q([1-4])$/.exec(quarterKey);
  const periodKey = parsed ? `Q${parsed[1]}` : null;
  let completedInstanceId: string | null = null;
  if (periodKey) {
    const candidates = await db
      .collection('compliance_obligations')
      .where('templateKey', '==', 'quarterly-compliance-report')
      .get();
    for (const candidate of candidates.docs) {
      const data = candidate.data() as Record<string, any>;
      if (data.periodKey !== periodKey) continue;
      if (['completed', 'waived'].includes(data.status as string)) continue;
      if (!candidate.id.startsWith(`quarterly-compliance-report__${quarterKey.slice(0, 4)}`)) continue;
      await candidate.ref.update({
        status: 'completed',
        completedAt: now,
        completedVia: 'report_delivery',
        evidence: {
          type: 'document',
          ref: doc.pdfUrl ?? '',
          submittedBy: actorUid,
          submittedAt: now,
          note: `Quarterly compliance report ${quarterKey} delivered (revision ${doc.revision}).`,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      completedInstanceId = candidate.id;
      break;
    }
  }

  return { deliveredTo: recipients, completedInstanceId };
}
