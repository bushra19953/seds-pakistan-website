import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/warning-registry
 *
 * Public read-only feed for the warning registry page (/warning-registry).
 * RESTORED 2026-10-26 by founder decision, reversing the Phase 2
 * discipline rebuild's retirement (spec E.7 Variant R, the default).
 *
 * The registry publishes the FACT of a current sanction only. The
 * projection below is a whitelist enforced here, server-side: display
 * name, chapter, status, warning count, and the date of the latest
 * sanction. Reasons, case details, notes, and all contact data never
 * leave the server.
 *
 * Who appears mirrors the admin register (the Register tab of
 * /admin/discipline, DefaultersRegister), with "current" judged on the
 * underlying records, exactly as the register's own warning badge
 * judges it:
 *  - a warning counts only while it is CURRENT: isActive, and not
 *    expired. Expiry follows the clear-probation cron
 *    (getWarningExpiryMillis): expiresAt when stored, otherwise
 *    createdAt + warningConfig expirationDays. A permanent warning
 *    never expires. A revoked or archived warning is never current,
 *    whatever the stored counters still say: the feed does not wait
 *    for a cleanup pass to stop publishing a lapsed or voided
 *    sanction.
 *  - the published warning count is the count of CURRENT warnings.
 *  - blacklist and ban are flag sanctions on the member record: they
 *    persist until a founder reinstatement clears them (the
 *    clear-probation cron never clears them), so a flagged member
 *    appears even when every warning has lapsed.
 *  - status is the register's own derivation:
 *    isBlacklisted -> 'blacklisted', else isBanned -> 'banned',
 *    else 'probation'.
 *
 * Reads go through the Admin SDK: Firestore rules deny `users` and the
 * `warnings` subcollection to public visitors, and raw docs carry
 * internal fields that must never be exposed.
 */

const DAY_MILLIS = 24 * 60 * 60 * 1000;

function toMillisSafe(val: any): number {
  if (val === null || val === undefined) return 0;
  if (typeof val.toMillis === 'function') {
    try {
      const ms = val.toMillis();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof val.toDate === 'function') {
    try {
      const ms = val.toDate().getTime();
      return Number.isFinite(ms) ? ms : 0;
    } catch {
      return 0;
    }
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000 + (val.nanoseconds || 0) / 1000000;
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

// Expiry of a warning, computed exactly as the clear-probation cron
// computes it (getWarningExpiryMillis): expiresAt when stored, else
// createdAt + expirationDays, else 0 (no expiry derivable).
function warningExpiryMillis(w: Record<string, any>, expirationDays: number): number {
  const exp = toMillisSafe(w.expiresAt);
  if (exp > 0) return exp;
  const created = toMillisSafe(w.createdAt);
  if (created > 0) return created + expirationDays * DAY_MILLIS;
  return 0;
}

// A warning is a CURRENT sanction while it is active and unexpired.
// isActive false covers revoked (admin action) and archived
// (probation_cleared) warnings alike.
function isCurrentlyActive(
  w: Record<string, any>,
  expirationDays: number,
  nowMillis: number
): boolean {
  if (w.isActive !== true) return false;
  if (w.isPermanent === true) return true;
  const expMillis = warningExpiryMillis(w, expirationDays);
  return expMillis <= 0 || expMillis > nowMillis;
}

export interface PublicWarningRegistryEntry {
  name: string;
  chapter: string | null;
  status: 'probation' | 'blacklisted' | 'banned';
  warnings: string;
  lastSanctionDate: string | null;
}

export async function GET() {
  try {
    if (!ensureAdminInitialized()) {
      return NextResponse.json(
        { error: 'Firebase Admin not initialized' },
        { status: 500 }
      );
    }
    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'Firestore not initialized' },
        { status: 500 }
      );
    }

    // Warning settings; publicVisibility gates the whole registry (the
    // admin kill switch in /admin/warning-settings).
    let settings: WarningSettings = { ...DEFAULT_WARNING_SETTINGS };
    try {
      const settingsSnap = await db
        .collection('warningConfig')
        .doc('global')
        .get();
      if (settingsSnap.exists) {
        settings = {
          ...DEFAULT_WARNING_SETTINGS,
          ...(settingsSnap.data() as Partial<WarningSettings>),
        };
      }
    } catch (e) {
      console.warn(
        '[api/public/warning-registry] Failed to load warningConfig, using defaults:',
        e
      );
    }

    if (settings.publicVisibility === false) {
      return NextResponse.json(
        { error: 'Warning registry is not public.' },
        { status: 403 }
      );
    }

    const threshold = settings.blacklistThreshold ?? 3;
    const expirationDays =
      settings.expirationDays ?? DEFAULT_WARNING_SETTINGS.expirationDays;
    const nowMillis = Date.now();

    // Chapter lookup, built exactly as the admin register builds it.
    const chapterMap: Record<string, string> = {};
    try {
      const chaptersSnap = await db.collection('chapters').get();
      chaptersSnap.docs.forEach((d: any) => {
        const data = d.data() as any;
        chapterMap[d.id] = data.name || data.title || d.id;
      });
    } catch (e) {
      console.warn('[api/public/warning-registry] Failed to load chapters:', e);
    }

    // Candidate set: members whose record carries any sanction marker
    // (the admin register's queries, plus the derived live-warning
    // counter). Inclusion is then judged per member on the warning
    // records themselves, so stale counters cannot publish anyone.
    const usersRef = db.collection('users');
    const candidateSnaps = await Promise.all([
      usersRef.where('warningCount', '>', 0).get(),
      usersRef.where('activeWarningCount', '>', 0).get(),
      usersRef.where('isBlacklisted', '==', true).get(),
      usersRef.where('isBanned', '==', true).get(),
    ]);

    const userMap = new Map<string, Record<string, any>>();
    for (const snap of candidateSnaps) {
      snap.docs.forEach((d: any) => {
        if (!userMap.has(d.id)) {
          userMap.set(d.id, { uid: d.id, ...(d.data() as any) });
        }
      });
    }

    interface Judged {
      user: Record<string, any>;
      activeCount: number;
      latestActiveMillis: number;
    }
    const judged: Judged[] = [];
    for (const user of userMap.values()) {
      let activeCount = 0;
      let latestActiveMillis = 0;
      try {
        const warningsSnap = await db
          .collection('users')
          .doc(user.uid)
          .collection('warnings')
          .get();
        warningsSnap.docs.forEach((wd: any) => {
          const w = wd.data() as Record<string, any>;
          if (isCurrentlyActive(w, expirationDays, nowMillis)) {
            activeCount += 1;
            latestActiveMillis = Math.max(
              latestActiveMillis,
              toMillisSafe(w.createdAt)
            );
          }
        });
      } catch (e) {
        console.warn(
          '[api/public/warning-registry] Failed to load warnings for a member:',
          e
        );
      }

      // Flag sanctions persist until founder reinstatement; warning
      // sanctions publish only while at least one warning is current.
      if (!user.isBlacklisted && !user.isBanned && activeCount === 0) {
        continue;
      }
      judged.push({ user, activeCount, latestActiveMillis });
    }

    // Register sort: banned first, then blacklisted, then warning
    // count descending; name ascending as a stable final tiebreak.
    judged.sort((a, b) => {
      if (a.user.isBanned && !b.user.isBanned) return -1;
      if (!a.user.isBanned && b.user.isBanned) return 1;
      if (a.user.isBlacklisted && !b.user.isBlacklisted) return -1;
      if (!a.user.isBlacklisted && b.user.isBlacklisted) return 1;
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
      return String(a.user.displayName || '').localeCompare(
        String(b.user.displayName || '')
      );
    });

    const entries: PublicWarningRegistryEntry[] = judged.map(
      ({ user, activeCount, latestActiveMillis }) => {
        const status: PublicWarningRegistryEntry['status'] = user.isBlacklisted
          ? 'blacklisted'
          : user.isBanned
            ? 'banned'
            : 'probation';

        // Date of the latest sanction: the newest current warning, or
        // the blacklist date when it is later (the blacklist is itself
        // the standing sanction for a flagged member).
        let latestMillis = latestActiveMillis;
        if (user.isBlacklisted) {
          latestMillis = Math.max(latestMillis, toMillisSafe(user.blacklistedAt));
        }

        const chapter = user.chapterId
          ? chapterMap[user.chapterId] || user.chapterName || user.chapterId
          : user.chapterName || null;

        return {
          name: user.displayName || 'Member',
          chapter,
          status,
          warnings: `${activeCount}/${threshold}`,
          lastSanctionDate:
            latestMillis > 0 ? new Date(latestMillis).toISOString() : null,
        };
      }
    );

    return NextResponse.json({ entries });
  } catch (e) {
    console.error('[api/public/warning-registry] Failed:', e);
    return NextResponse.json(
      { error: 'Failed to load the warning registry.' },
      { status: 500 }
    );
  }
}
