/**
 * Governor term sweep (Phase 2, spec C.6).
 *
 * Read-time derivation (effectiveStatus) is the mechanism of record for
 * expiry; this sweep only materialises the stored state and sends alerts:
 * - termEnd - now <= 30 days and stage 'none' -> T-30 alert, stage t30_sent.
 * - <= 7 days and stage 'none' or 't30_sent' -> T-7 alert, stage t7_sent
 *   (a seat first seen inside 7 days gets the T-7 alert, not a late T-30).
 * - Effective term_expired with stored status still seated -> automatic
 *   vacate (holder fields cleared, prior role restored via P2-SYNC for
 *   account holders), history event term_expired_materialised, expiry alert,
 *   stage expired_sent.
 * Recipients: the Founder (UID) and the current NGS holder(s), resolved by
 * querying roles where role == 'national_general_secretary'; if no NGS is
 * seated the Founder is the sole recipient and the summary logs
 * ngsVacant: true. Delivery: notificationService, type 'governor_term_alert'.
 *
 * Invoked from getRegister and the governors-term-sweep cron. Per-seat
 * failures are caught, logged, and reported so one bad seat never blocks the
 * register; the throwing audit writer is used per seat.
 *
 * Actor: callers that run the sweep on a human's behalf (the manual
 * trigger endpoint, RP-02) pass options.actorUid so the vacate record,
 * history event, governance audit, and role restore are stamped with
 * the real caller. Scheduled and inline callers pass nothing and keep
 * the historical 'system' actor byte-for-byte.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import {
  GOVERNORS_COLLECTION,
  effectiveStatus,
  toJsDate,
  type GovernorSeat,
} from '@/lib/governors';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { bustIdentity } from '@/lib/server/identity-cache';
import { notificationService } from '@/lib/server/notification-service';
import {
  historyEvent,
  historyRef,
  readRoleStores,
  flushGovernorPrimaryOps,
  restorePriorRole,
  seatRef,
} from '@/lib/server/governors/shared';

export interface GovernorTermSweepSummary {
  reminded: Array<{ seatKey: string; stage: 't30_sent' | 't7_sent' }>;
  expiredMaterialised: string[];
  ngsVacant: boolean;
  failures: Array<{ seatKey: string; error: string }>;
}

async function findNgsUids(db: Firestore): Promise<string[]> {
  try {
    const snap = await db
      .collection('roles')
      .where('role', '==', 'national_general_secretary')
      .get();
    return snap.docs.map((d) => d.id);
  } catch {
    return [];
  }
}

async function alertRecipients(
  db: Firestore,
  seat: GovernorSeat,
  stage: string,
  body: string,
): Promise<void> {
  const termEnd = toJsDate(seat.termEnd);
  const payload = {
    type: 'governor_term_alert',
    title: `Governor term alert (${stage})`,
    body,
    link: '/admin/governors',
    metadata: { seatKey: seat.seatKey, termEnd: termEnd ? termEnd.toISOString() : null },
  };
  const ngsUids = await findNgsUids(db);
  const recipients = [FOUNDER_UID, ...ngsUids.filter((u) => u !== FOUNDER_UID)];
  for (const uid of recipients) {
    try {
      await notificationService.send(uid, payload, 'P1');
    } catch (err) {
      console.error('[governor-term-sweep] notification failed', uid, err);
    }
  }
}

export async function runGovernorTermSweep(
  db: Firestore,
  now: Date,
  options?: { actorUid?: string },
): Promise<GovernorTermSweepSummary> {
  const actorUid = options?.actorUid ?? 'system';
  const summary: GovernorTermSweepSummary = {
    reminded: [],
    expiredMaterialised: [],
    ngsVacant: false,
    failures: [],
  };

  let seats: GovernorSeat[] = [];
  try {
    const snap = await db.collection(GOVERNORS_COLLECTION).get();
    seats = snap.docs.map((d) => d.data() as GovernorSeat);
  } catch (err) {
    console.error('[governor-term-sweep] could not read register', err);
    return summary;
  }

  summary.ngsVacant = (await findNgsUids(db)).length === 0;

  for (const seat of seats) {
    if (seat.seatKey === 'seat_founder') continue;
    if (seat.status !== 'seated' || !seat.holderName) continue;
    const termEnd = toJsDate(seat.termEnd);
    if (!termEnd) continue; // termless seats (Founder-Appointed) never alert
    const msToEnd = termEnd.getTime() - now.getTime();
    const eff = effectiveStatus(seat, now);

    try {
      if (eff === 'term_expired') {
        const batch = db.batch();
        if (seat.holderUid) {
          const { userData, userExists, rolesData } = await readRoleStores(db, seat.holderUid);
          if (userExists) {
            restorePriorRole(batch, db, seat.holderUid, userData, rolesData, actorUid);
          }
        }
        const cleared: Record<string, unknown> = {
          status: 'vacant',
          holderUid: null,
          holderName: null,
          holderEmail: null,
          holderExternalId: null,
          holderRoleKey: null,
          isExternal: false,
          publicBio: null,
          photoUrl: null,
          termStart: null,
          termEnd: null,
          termYears: null,
          isInitialStaggerTerm: false,
          vacatedAt: now,
          vacancySince: now,
          lastVacancyReason: 'term_expired',
          consentRequestId: null,
          voteRecordId: null,
          electionResult: null,
          appointmentRecordRef: null,
          appointedBy: null,
          lastHolderName: seat.holderName,
          lastHolderUid: seat.holderUid,
          vacateRecord: {
            reason: 'term_expired',
            at: FieldValue.serverTimestamp(),
            by: actorUid,
            byName: 'Term sweep',
            note: 'Term lapsed; materialised by the term sweep',
          },
          removalRecord: null,
          termAlertStage: 'expired_sent',
          version: seat.version + 1,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: actorUid,
        };
        batch.update(seatRef(db, seat.seatKey), cleared);
        batch.set(
          historyRef(db, seat.seatKey),
          historyEvent({
            eventType: 'term_expired_materialised',
            actorUid,
            actorRole: 'term_sweep',
            before: seat,
            after: { ...seat, ...cleared } as GovernorSeat,
            recordRef: null,
            reason: 'term_expired',
          }),
        );
        await writeGovernanceAuditOrThrow(db, {
          action: 'governor_term_expired',
          actorUid,
          targetType: 'governor_seat',
          targetId: seat.seatKey,
          details: { lastHolderName: seat.holderName, lastHolderUid: seat.holderUid },
        });
        await flushGovernorPrimaryOps(batch);
        await batch.commit();
        // Read-Burn A (§2.5 W15): restorePriorRole restored the holder's
        // prior role into both stores in this batch, so bust immediately
        // after the per-seat commit succeeds.
        if (seat.holderUid) bustIdentity(seat.holderUid);
        summary.expiredMaterialised.push(seat.seatKey);
        await alertRecipients(
          db,
          seat,
          'expired',
          `The term for seat ${seat.seatKey} (${seat.holderName}) has expired and the seat is now vacant.`,
        );
        continue;
      }

      const daysToEnd = msToEnd / 86400000;
      const dueStage: 't30_sent' | 't7_sent' | null =
        daysToEnd <= 7 && (seat.termAlertStage === 'none' || seat.termAlertStage === 't30_sent')
          ? 't7_sent'
          : daysToEnd <= 30 && seat.termAlertStage === 'none'
            ? 't30_sent'
            : null;
      if (dueStage) {
        await alertRecipients(
          db,
          seat,
          dueStage,
          `Governor term ending soon: seat ${seat.seatKey} (${seat.holderName}) ends ${termEnd.toISOString().slice(0, 10)}.`,
        );
        await seatRef(db, seat.seatKey).update({ termAlertStage: dueStage });
        summary.reminded.push({ seatKey: seat.seatKey, stage: dueStage });
      }
    } catch (err) {
      console.error('[governor-term-sweep] seat failed', seat.seatKey, err);
      summary.failures.push({
        seatKey: seat.seatKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
