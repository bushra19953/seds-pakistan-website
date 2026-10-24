import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { FOUNDER_UID } from '@/lib/roles';
import { notificationService } from '@/lib/server/notification-service';
import { stampDeemedWithheld } from '@/lib/server/consent-service';

export const dynamic = 'force-dynamic';

/**
 * GET/POST /api/cron/consent-deadlines (spec Section A.7).
 * Runs daily at 04:15 UTC = 09:15 PKT (vercel.json: "15 4 * * *").
 *
 * Two passes over pending Consent requests (further_information_requested
 * is never selected - its clock is suspended, Schedule s.4.4):
 *   1. Deadline pass: requests past decisionDeadlineAt are stamped
 *      deemed withheld by the consent service inside a transaction that
 *      re-checks the status, so a Founder decision in flight wins.
 *   2. Warning pass: requests due within 7 days with no warning stamp
 *      for this clock cycle notify the Founder once (P0 if urgent),
 *      then are stamped. The service resets the stamp when the clock
 *      restarts, so each cycle warns exactly once.
 *
 * Authorization follows the other cron routes: Vercel Cron supplies
 * Authorization: Bearer <CRON_SECRET>; an authenticated admin session
 * may trigger it manually. No/invalid auth = 401 and zero writes.
 * Idempotent: a re-run with nothing due performs zero writes; one
 * failing request never aborts the run.
 */

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const v: any = value as any;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  return null;
}

export async function runConsentDeadlines(
  db: Firestore,
  now: Date,
): Promise<{
  success: boolean;
  checked: number;
  warningsSent: number;
  deemedWithheld: number;
  skippedDecidedInFlight: number;
  failed: number;
  failedDetails: Array<{ id: string; error: string }>;
}> {
  const summary = {
    success: true,
    checked: 0,
    warningsSent: 0,
    deemedWithheld: 0,
    skippedDecidedInFlight: 0,
    failed: 0,
    failedDetails: [] as Array<{ id: string; error: string }>,
  };

  const snap = await db
    .collection('consent_requests')
    .where('status', '==', 'pending')
    .orderBy('decisionDeadlineAt', 'asc')
    .get();

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, any>;
    // Defensive: only pending requests are ever processed, even if a
    // query ever returned another status.
    if (data.status !== 'pending') continue;
    summary.checked += 1;
    try {
      const deadlineMs = toMillis(data.decisionDeadlineAt);
      if (deadlineMs !== null && deadlineMs < now.getTime()) {
        // Deadline pass.
        const result = await stampDeemedWithheld(db, doc.id, now);
        if (result.stamped) {
          summary.deemedWithheld += 1;
          try {
            await notificationService.send(
              data.requestedByUid,
              {
                type: 'consent_deemed_withheld',
                title: `Consent request ${data.requestNumber} deemed withheld`,
                body: `The 30-day decision period for Consent request ${data.requestNumber} expired with no decision recorded. Under the Reserved Powers Schedule the request is deemed WITHHELD. File a new request if the Act is still proposed.`,
                link: `/admin/consents/${doc.id}`,
                metadata: { consentRequestId: doc.id, requestNumber: data.requestNumber },
              },
              'P1',
            );
          } catch (err) {
            console.error('[cron/consent-deadlines] notify failed', doc.id, err);
          }
        } else {
          summary.skippedDecidedInFlight += 1;
        }
      } else if (
        deadlineMs !== null &&
        deadlineMs - now.getTime() <= SEVEN_DAYS_MS &&
        !data.deadlineWarningSentAt
      ) {
        // Warning pass: one warning per clock cycle.
        const daysLeft = Math.max(
          0,
          Math.ceil((deadlineMs - now.getTime()) / (24 * 3600 * 1000)),
        );
        await notificationService.send(
          FOUNDER_UID,
          {
            type: 'consent_deadline_warning',
            title: `Consent request ${data.requestNumber} due in ${daysLeft} day(s)`,
            body: `Consent request ${data.requestNumber} (${data.matterLabel}) reaches its 30-day deadline in ${daysLeft} day(s). Silence at the deadline means deemed withheld.`,
            link: `/admin/consents/${doc.id}`,
            metadata: { consentRequestId: doc.id, requestNumber: data.requestNumber },
          },
          data.isUrgent === true ? 'P0' : 'P1',
        );
        await db
          .collection('consent_requests')
          .doc(doc.id)
          .update({ deadlineWarningSentAt: FieldValue.serverTimestamp() });
        summary.warningsSent += 1;
      }
    } catch (err) {
      summary.failed += 1;
      summary.failedDetails.push({
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

async function runConsentDeadlinesHandler(req: NextRequest) {
  // Authorization: Vercel Cron (Bearer CRON_SECRET) or authenticated admin.
  const authHeader = req.headers.get('Authorization');
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user?.role) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  if (!ensureAdminInitialized()) {
    return NextResponse.json(
      { error: 'Firebase Admin not initialized' },
      { status: 500 },
    );
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Firestore not initialized' },
      { status: 500 },
    );
  }

  const summary = await runConsentDeadlines(db, new Date());
  return NextResponse.json(summary);
}

export async function GET(req: NextRequest) {
  return runConsentDeadlinesHandler(req);
}

export async function POST(req: NextRequest) {
  return runConsentDeadlinesHandler(req);
}
