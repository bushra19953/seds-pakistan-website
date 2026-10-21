/**
 * lifecycle-vacancy.ts - Phase 2 Section D.8: vacancy derivation, the
 * vacancies register, the alert schedule, and the day-30 Founder
 * fallback flag (D.8.1).
 *
 * Derivation universe (data-driven from the appointer map):
 *  - V1 national single-holder seats: appointer-map entries with
 *    seatBound = true and chapterScoped = false, EXCLUDING governor_*
 *    seats (tracked by Workstream C's governors collection) and
 *    founder_patron. If Zubair later rules a named office in (ambassador_
 *    seds, regional_coordinator), it is a catalog flag change
 *    (seatBound = true), no code change.
 *  - V2 chapter minimum officers: per active chapter, the five Art. 7.2
 *    seats from the adapter layer's CHAPTER_OFFICER_SEATS.
 *  - V3 pool/non-officer memberships are never scanned.
 *
 * The register is clerical and automatic: written ONLY by this scan (and
 * applyRoleChange hooks at integration). Doc ids are deterministic
 * (vac_{scope}_{seatKey}_{chapterSlugOrNational}); openedAt is persisted
 * at first observation and NEVER moved while the same vacancy continues.
 * vacancyReason is read from the role-change audit trail where an entry
 * explains the emptying, and reported as 'unknown' where none does -
 * never guessed.
 *
 * ADAPTER notes: active-chapter listing and the audit-trail read are
 * tolerant local readers over today's collections (chapters doc ids are
 * their slugs; audit entries live in audit_logs). Phase 1's chapter
 * model and roleHistory replace them at integration; resolveChapter­
 * Officers already isolates the chapter seat storage choice.
 */

import { FOUNDER_UID } from '@/lib/roles';
import type { LifecycleCategory, VacancyReason } from '@/types/lifecycle';
import {
  CHAPTER_OFFICER_SEATS,
  resolveChapterOfficers,
  resolveRoleHolders,
  resolveRoleHoldersInChapter,
  resolveSeatedGovernors,
  sendLifecycleNotification,
  writeGovernanceAuditOrThrow,
} from './lifecycle-adapters';
import { toMillis } from './lifecycle-ratification';
import {
  APPOINTER_MAP,
  getAppointerEntryIncludingSupplementary,
  type AppointerMapEntry,
} from './lifecycle-appointer-map';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const DAY_MS = 24 * 60 * 60 * 1000;
export const FOUNDER_FALLBACK_DAYS = 30;

export type AlertStage = 'day0' | 'day7' | 'day23' | 'day30';
export const ALERT_STAGE_DAYS: Record<AlertStage, number> = {
  day0: 0,
  day7: 7,
  day23: 23,
  day30: 30,
};

export interface ExpectedSeat {
  seatKey: string;
  roleKey: string;
  scope: 'national' | 'chapter';
  chapterSlug: string | null;
  category: LifecycleCategory;
}

export function vacancyDocId(
  scope: 'national' | 'chapter',
  seatKey: string,
  chapterSlug: string | null,
): string {
  return `vac_${scope}_${seatKey}_${chapterSlug ?? 'national'}`;
}

/** V1 filter (D.8): a national seat the vacancy duty attaches to. */
export function isNationalVacancySeat(entry: AppointerMapEntry): boolean {
  if (!entry.seatBound || entry.chapterScoped) return false;
  if (entry.key === 'founder_patron') return false;
  if (entry.key.startsWith('governor_')) return false;
  return entry.category === 'A' || entry.category === 'B';
}

export function nationalSeatInventory(): ExpectedSeat[] {
  return APPOINTER_MAP.filter(isNationalVacancySeat).map((e) => ({
    seatKey: e.key,
    roleKey: e.key,
    scope: 'national' as const,
    chapterSlug: null,
    category: e.category,
  }));
}

export function chapterSeatInventory(chapterSlug: string): ExpectedSeat[] {
  return CHAPTER_OFFICER_SEATS.map((seat) => ({
    seatKey: seat,
    roleKey: seat,
    scope: 'chapter' as const,
    chapterSlug,
    category: getAppointerEntryIncludingSupplementary(seat)?.category ?? 'C',
  }));
}

export function computeDaysOpen(openedAtMs: number, nowMs: number): number {
  if (!openedAtMs || nowMs < openedAtMs) return 0;
  return Math.floor((nowMs - openedAtMs) / DAY_MS);
}

export function dueAlertStages(daysOpen: number): AlertStage[] {
  return (Object.keys(ALERT_STAGE_DAYS) as AlertStage[]).filter(
    (stage) => daysOpen >= ALERT_STAGE_DAYS[stage],
  );
}

// ---------------------------------------------------------------------------
// ADAPTER: active chapters + audit trail readers
// ---------------------------------------------------------------------------

/** ADAPTER: chapters collection; doc ids are slugs; a doc is inactive
 *  only when it explicitly says so (status / isActive). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listActiveChapters(db: Db): Promise<string[]> {
  try {
    const snap = await db.collection('chapters').get();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs: any[] = snap?.docs ?? [];
    const slugs: string[] = [];
    for (const docSnap of docs) {
      const data = typeof docSnap.data === 'function' ? docSnap.data() : null;
      if (data?.isActive === false) continue;
      if (typeof data?.status === 'string' && ['inactive', 'archived', 'closed'].includes(data.status)) continue;
      const slug = typeof data?.slug === 'string' && data.slug ? data.slug : docSnap.id;
      if (slug) slugs.push(String(slug));
    }
    return slugs;
  } catch {
    return [];
  }
}

interface AuditTrailEntry {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  createdMs: number;
}

const VACATING_ACTIONS: Record<string, VacancyReason> = {
  role_revoked: 'role_revoked',
  role_removed: 'role_revoked',
  revoke: 'role_revoked',
  role_reassigned: 'role_reassigned',
  probation_demotion: 'probation_demotion',
  ratification_refused: 'refusal_revocation',
};

const APPOINTING_ACTIONS = ['role_assigned', 'appointment_created', 'apply_role_change', 'role_granted'];

/** ADAPTER: tolerant full read of audit_logs (small collection posture). */
async function readAuditTrail(db: Db): Promise<AuditTrailEntry[]> {
  try {
    const snap = await db.collection('audit_logs').get();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs: any[] = snap?.docs ?? [];
    return docs.map((d) => {
      const data = (typeof d.data === 'function' ? d.data() : null) ?? {};
      return { id: d.id, data, createdMs: toMillis(data.createdAt) };
    });
  } catch {
    return [];
  }
}

function latestVacatingEntry(
  trail: AuditTrailEntry[],
  seat: ExpectedSeat,
): AuditTrailEntry | null {
  let best: AuditTrailEntry | null = null;
  for (const entry of trail) {
    const action = String(entry.data.action ?? '');
    if (!(action in VACATING_ACTIONS)) continue;
    if (entry.data.roleKey !== seat.roleKey) continue;
    if (seat.scope === 'chapter' && entry.data.chapterSlug && entry.data.chapterSlug !== seat.chapterSlug) continue;
    if (!best || entry.createdMs > best.createdMs) best = entry;
  }
  return best;
}

function latestAppointmentId(
  trail: AuditTrailEntry[],
  seat: ExpectedSeat,
  holderUid: string,
): string | null {
  let best: AuditTrailEntry | null = null;
  for (const entry of trail) {
    const action = String(entry.data.action ?? '');
    if (!APPOINTING_ACTIONS.includes(action)) continue;
    if (entry.data.roleKey !== seat.roleKey) continue;
    const target = entry.data.targetUid ?? entry.data.userId ?? null;
    if (target !== holderUid) continue;
    if (!best || entry.createdMs > best.createdMs) best = entry;
  }
  if (!best) return null;
  return typeof best.data.appointmentId === 'string' ? best.data.appointmentId : best.id;
}

// ---------------------------------------------------------------------------
// Alert recipients (D.8)
// ---------------------------------------------------------------------------

async function resolveAppointerUids(db: Db, seat: ExpectedSeat): Promise<string[]> {
  const entry = getAppointerEntryIncludingSupplementary(seat.roleKey);
  if (!entry || entry.appointingRoleKeys.length === 0) return [];
  const appointerKey = entry.appointingRoleKeys[0];
  if (appointerKey === 'founder_appointer') return [FOUNDER_UID];
  if (appointerKey === 'board_of_governors') {
    const seated = await resolveSeatedGovernors(db);
    return seated.map((g) => g.uid);
  }
  if (seat.scope === 'chapter' && seat.chapterSlug && appointerKey !== 'president_national') {
    return resolveRoleHoldersInChapter(db, appointerKey, seat.chapterSlug);
  }
  return resolveRoleHolders(db, appointerKey);
}

async function stageRecipients(
  db: Db,
  seat: ExpectedSeat,
  stage: AlertStage,
  appointerUids: string[],
): Promise<string[]> {
  const recipients = new Set<string>();
  const addAll = (uids: string[]) => uids.forEach((u) => u && recipients.add(u));
  const ngs = () => resolveRoleHolders(db, 'national_general_secretary');
  switch (stage) {
    case 'day0':
      addAll(appointerUids);
      break;
    case 'day7':
      addAll(appointerUids);
      if (seat.scope === 'chapter' && seat.chapterSlug) {
        const advisors = await resolveRoleHoldersInChapter(db, 'faculty_advisor', seat.chapterSlug);
        addAll(advisors);
      }
      addAll(await ngs());
      break;
    case 'day23':
      addAll(appointerUids);
      break;
    case 'day30':
      recipients.add(FOUNDER_UID);
      addAll(appointerUids);
      addAll(await ngs());
      break;
  }
  // A vacancy whose filler is missing is a Founder problem from day 0.
  if (recipients.size === 0) recipients.add(FOUNDER_UID);
  return Array.from(recipients);
}

// ---------------------------------------------------------------------------
// The scan (governance cron action scanVacancies)
// ---------------------------------------------------------------------------

export interface VacancyScanResult {
  seatsScanned: number;
  opened: number;
  filled: number;
  updated: number;
  alertsSent: number;
  errors: number;
}

export async function scanVacancies(db: Db, now: Date): Promise<VacancyScanResult> {
  const result: VacancyScanResult = {
    seatsScanned: 0,
    opened: 0,
    filled: 0,
    updated: 0,
    alertsSent: 0,
    errors: 0,
  };
  const nowMs = now.getTime();
  const chapters = await listActiveChapters(db);
  const trail = await readAuditTrail(db);

  const seats: ExpectedSeat[] = [...nationalSeatInventory()];
  const heldBySeat = new Map<string, string | null>();
  const keyOf = (s: ExpectedSeat) => vacancyDocId(s.scope, s.seatKey, s.chapterSlug);

  for (const seat of nationalSeatInventory()) {
    const holders = await resolveRoleHolders(db, seat.roleKey);
    heldBySeat.set(keyOf(seat), holders.length > 0 ? holders[0] : null);
  }
  const chapterOpenCount = new Map<string, number>();
  for (const slug of chapters) {
    const officers = await resolveChapterOfficers(db, slug);
    let open = 0;
    for (const seat of chapterSeatInventory(slug)) {
      seats.push(seat);
      const holder = officers[seat.seatKey] ?? null;
      heldBySeat.set(keyOf(seat), holder);
      if (!holder) open += 1;
    }
    chapterOpenCount.set(slug, open);
  }

  // Denormalised chapter flag (D.8): readable without a join.
  for (const slug of chapters) {
    try {
      const ref = db.collection('chapters').doc(slug);
      const snap = await ref.get();
      if (snap?.exists) {
        await ref.update({
          underConstitutedOfficerCount: chapterOpenCount.get(slug) ?? 0,
          updatedAt: now,
        });
      }
    } catch (err) {
      result.errors += 1;
      console.error('[lifecycle] vacancy scan: chapter flag update failed', slug, err);
    }
  }

  for (const seat of seats) {
    result.seatsScanned += 1;
    const id = keyOf(seat);
    const ref = db.collection('vacancies').doc(id);
    try {
      const snap = await ref.get();
      const existing = snap?.exists ? (snap.data() ?? {}) : null;
      const holder = heldBySeat.get(id) ?? null;
      const isOpen = existing && existing.status === 'open';

      if (holder) {
        if (isOpen) {
          await ref.update({
            status: 'filled',
            filledByUid: holder,
            filledAt: now,
            fillingAppointmentId: latestAppointmentId(trail, seat, holder),
            chapterUnderConstituted:
              seat.scope === 'chapter' ? (chapterOpenCount.get(seat.chapterSlug ?? '') ?? 0) > 0 : false,
            updatedAt: now,
          });
          result.filled += 1;
          await writeGovernanceAuditOrThrow(db, {
            action: 'vacancy_filled',
            vacancyId: id,
            seatKey: seat.seatKey,
            scope: seat.scope,
            chapterSlug: seat.chapterSlug,
            filledByUid: holder,
          });
        }
        continue;
      }

      // Seat is empty.
      let doc = existing;
      if (!isOpen) {
        const vacating = latestVacatingEntry(trail, seat);
        const auditMs = vacating && vacating.createdMs > 0 && vacating.createdMs <= nowMs ? vacating.createdMs : 0;
        const openedAt = auditMs ? new Date(auditMs) : now;
        const initialDaysOpen = computeDaysOpen(openedAt.getTime(), nowMs);
        doc = {
          id,
          seatKey: seat.seatKey,
          scope: seat.scope,
          chapterSlug: seat.chapterSlug,
          roleKey: seat.roleKey,
          catalogCategory: seat.category,
          status: 'open',
          openedAt,
          openedAtSource: auditMs ? 'audit_trail' : 'first_observation',
          daysOpen: computeDaysOpen(openedAt.getTime(), nowMs),
          lastHolderUid: vacating
            ? ((vacating.data.targetUid ?? vacating.data.userId ?? null) as string | null)
            : null,
          lastHolderVacatedAt: vacating && auditMs ? new Date(auditMs) : null,
          vacancyReason: vacating ? VACATING_ACTIONS[String(vacating.data.action)] : 'unknown',
          founderFallbackDueAt: new Date(openedAt.getTime() + FOUNDER_FALLBACK_DAYS * DAY_MS),
          founderFallbackAvailable: initialDaysOpen >= FOUNDER_FALLBACK_DAYS,
          alertsSent: { day0: null, day7: null, day23: null, day30: null },
          filledByUid: null,
          filledAt: null,
          fillingAppointmentId: null,
          chapterUnderConstituted:
            seat.scope === 'chapter' ? (chapterOpenCount.get(seat.chapterSlug ?? '') ?? 0) > 0 : false,
          createdAt: now,
          updatedAt: now,
        };
        await ref.set(doc);
        result.opened += 1;
        await writeGovernanceAuditOrThrow(db, {
          action: 'vacancy_opened',
          vacancyId: id,
          seatKey: seat.seatKey,
          scope: seat.scope,
          chapterSlug: seat.chapterSlug,
          vacancyReason: doc.vacancyReason,
          openedAtSource: doc.openedAtSource,
        });
      } else {
        const daysOpen = computeDaysOpen(toMillis(existing.openedAt), nowMs);
        const fallbackDue =
          !existing.founderFallbackAvailable && daysOpen >= FOUNDER_FALLBACK_DAYS;
        await ref.update({
          daysOpen,
          chapterUnderConstituted:
            seat.scope === 'chapter' ? (chapterOpenCount.get(seat.chapterSlug ?? '') ?? 0) > 0 : false,
          ...(fallbackDue ? { founderFallbackAvailable: true } : {}),
          updatedAt: now,
        });
        doc = {
          ...existing,
          daysOpen,
          ...(fallbackDue ? { founderFallbackAvailable: true } : {}),
        };
        result.updated += 1;
      }

      // Alert schedule: each stage exactly once, stamps only when sent.
      const daysOpen = computeDaysOpen(toMillis(doc.openedAt), nowMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alertsSent: Record<string, any> = { ...(doc.alertsSent ?? {}) };
      const appointerUids = await resolveAppointerUids(db, seat);
      let stampsChanged = false;
      for (const stage of dueAlertStages(daysOpen)) {
        if (alertsSent[stage]) continue;
        const recipients = await stageRecipients(db, seat, stage, appointerUids);
        const isFallbackStage = stage === 'day30';
        for (const uid of recipients) {
          await sendLifecycleNotification(
            db,
            uid,
            isFallbackStage ? 'vacancy_founder_fallback' : 'vacancy_alert',
            {
              title: isFallbackStage
                ? 'Vacancy open 30 days: Founder fallback available'
                : `Vacancy alert: ${seat.seatKey}`,
              body:
                `Seat ${seat.seatKey}${seat.chapterSlug ? ` (${seat.chapterSlug})` : ''} has been vacant for ${daysOpen} day(s). ` +
                `Appointer: ${getAppointerEntryIncludingSupplementary(seat.roleKey)?.appointingRoleKeys[0] ?? 'unknown'}.` +
                (stage === 'day23' ? ' 7 days remain before Founder fallback.' : '') +
                (isFallbackStage
                  ? ' The Founder may now appoint directly to this seat notwithstanding the catalog appointer (s.5.10).'
                  : ''),
              vacancyId: id,
              seatKey: seat.seatKey,
              chapterSlug: seat.chapterSlug,
              daysOpen,
              stage,
            },
          );
        }
        alertsSent[stage] = now;
        stampsChanged = true;
        result.alertsSent += 1;
      }
      if (stampsChanged) {
        await ref.update({ alertsSent, updatedAt: now });
      }
    } catch (err) {
      result.errors += 1;
      console.error('[lifecycle] vacancy scan failed for seat', id, err);
    }
  }
  return result;
}
