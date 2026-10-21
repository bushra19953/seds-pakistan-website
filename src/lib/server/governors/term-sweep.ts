/**
 * Governor term sweep (Phase 2, spec C.2.3).
 *
 * Read-time code (effectiveStatus) is the display authority for expiry; this
 * sweep is only the materialiser + alerter:
 * - T-90 days: reminder to the holder, the Founder, and the National General
 *   Secretary (termAlertStage 0 -> 1).
 * - T-30 days: second reminder (stage 1 -> 2).
 * - Past expiry: the seat is materialised to vacant with
 *   vacateRecord.reason 'term_expired', the holder's prior role is restored
 *   via the P2-SYNC adapter (account holders only), a history entry and a
 *   governance audit are written, and the Founder + NGS are notified.
 *
 * Invoked from getRegister and from the governors-term-sweep cron. Per-seat
 * failures are caught, logged, and reported in the summary so one bad seat
 * never blocks the rest of the register; the throwing audit writer is used
 * per seat as the substrate contract requires.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import {
  GOVERNORS_COLLECTION,
  GOVERNORS_HISTORY_COLLECTION,
  effectiveStatus,
  karachiMidnight,
  toJsDate,
  type GovernorSeat,
} from '@/lib/governors';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { notificationService } from '@/lib/server/notification-service';
import {
  historyEntry,
  readRoleStores,
  restorePriorRole,
  seatRef,
} from '@/lib/server/governors/shared';

export interface GovernorTermSweepSummary {
  reminded: Array<{ seatKey: string; stage: 1 | 2 }>;
  expiredMaterialised: string[];
  failures: Array<{ seatKey: string; error: string }>;
}

async function findNgsUid(db: Firestore): Promise<string | null> {
  try {
    const snap = await db
      .collection('roles')
      .where('role', '==', 'national_general_secretary')
      .limit(1)
      .get();
    return snap.empty ? null : snap.docs[0].id;
  } catch {
    return null;
  }
}

async function notifySafe(userId: string, payload: Record<string, unknown>, title: string) {
  try {
    await notificationService.send(
      userId,
      { type: 'governor_term', title, body: String(payload.body ?? ''), link: '/admin/governors', metadata: payload },
      'P1',
    );
  } catch (err) {
    console.error('[governor-term-sweep] notification failed', userId, err);
  }
}

export async function runGovernorTermSweep(
  db: Firestore,
  now: Date,
): Promise<GovernorTermSweepSummary> {
  const summary: GovernorTermSweepSummary = {
    reminded: [],
    expiredMaterialised: [],
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

  const ngsUid = await findNgsUid(db);
  const today = karachiMidnight(now);

  for (const seat of seats) {
    if (seat.seatKey === 'seat_founder') continue;
    if (seat.status !== 'seated' || !seat.holderName) continue;
    const expiry = toJsDate(seat.termExpiresAt);
    if (!expiry) continue;
    const expiryDay = karachiMidnight(expiry);
    const daysToExpiry = Math.round((expiryDay.getTime() - today.getTime()) / 86400000);
    const eff = effectiveStatus(seat, now);

    try {
      if (eff.storedStatus === 'term_expired') {
        // Materialise the lapsed term.
        const batch = db.batch();
        if (seat.holderUid) {
          const { userData, userExists, rolesData } = await readRoleStores(db, seat.holderUid);
          if (userExists) {
            restorePriorRole(batch, db, seat.holderUid, userData, rolesData, 'system');
          }
        }
        batch.update(seatRef(db, seat.seatKey), {
          status: 'vacant',
          holderUid: null,
          holderName: null,
          holderEmail: null,
          holderExternalId: null,
          publicBio: null,
          photoUrl: null,
          seatedAt: null,
          termExpiresAt: null,
          appointmentBasis: null,
          consentRequestId: null,
          voteRecordId: null,
          electionResult: null,
          termAlertStage: 0,
          lastHolderName: seat.holderName,
          lastHolderUid: seat.holderUid,
          vacateRecord: {
            reason: 'term_expired',
            at: FieldValue.serverTimestamp(),
            by: 'system',
            byName: 'Term sweep',
            note: 'Term lapsed; materialised by the term sweep',
          },
          version: seat.version + 1,
        });
        batch.set(
          db.collection(GOVERNORS_HISTORY_COLLECTION).doc(),
          historyEntry({
            seatKey: seat.seatKey,
            event: 'term_expired_materialised',
            actorUid: 'system',
            actorName: 'Term sweep',
            details: { lastHolderName: seat.holderName, lastHolderUid: seat.holderUid },
          }),
        );
        await writeGovernanceAuditOrThrow(db, {
          action: 'governor_term_expired',
          actorUid: 'system',
          targetType: 'governor_seat',
          targetId: seat.seatKey,
          details: { lastHolderName: seat.holderName, lastHolderUid: seat.holderUid },
        });
        await batch.commit();
        summary.expiredMaterialised.push(seat.seatKey);
        const body = `The term for seat ${seat.seatKey} (${seat.holderName}) has expired and the seat is now vacant.`;
        await notifySafe(FOUNDER_UID, { body }, 'Governor term expired');
        if (ngsUid) await notifySafe(ngsUid, { body }, 'Governor term expired');
        continue;
      }

      // Reminders.
      const dueStage: 1 | 2 | null =
        daysToExpiry <= 30 && seat.termAlertStage < 2
          ? 2
          : daysToExpiry <= 90 && seat.termAlertStage < 1
            ? 1
            : null;
      if (dueStage) {
        const body = `Governor term ending soon: seat ${seat.seatKey} (${seat.holderName}) expires in ${daysToExpiry} day(s).`;
        if (seat.holderUid) await notifySafe(seat.holderUid, { body }, 'Your Governor term is ending');
        await notifySafe(FOUNDER_UID, { body }, 'Governor term ending soon');
        if (ngsUid) await notifySafe(ngsUid, { body }, 'Governor term ending soon');
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
