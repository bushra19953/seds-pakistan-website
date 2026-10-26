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
 * Inclusion and status mirror the admin register (the Register tab of
 * /admin/discipline, DefaultersRegister) exactly:
 *  - candidate set is the union of the register's three queries on
 *    `users`: warningCount > 0, isBlacklisted == true, isBanned == true;
 *  - status is the register's own derivation:
 *    isBlacklisted -> 'blacklisted', else isBanned -> 'banned',
 *    else 'probation';
 *  - the warning count is shown against the blacklist threshold from
 *    warningConfig/global (default 3), as the register shows it.
 *
 * A sanction stops appearing as soon as it lapses or is cleared: the
 * clear-probation cron archives expired warnings and recomputes the
 * derived warningCount, so a cleared member no longer matches the
 * candidate queries. Blacklist/ban flags persist until a founder
 * reinstatement clears them, exactly as in the admin register.
 *
 * Reads go through the Admin SDK: Firestore rules deny `users` and the
 * `warnings` subcollection to public visitors, and raw docs carry
 * internal fields that must never be exposed.
 */

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

    // Candidate set: the admin register's three queries, unioned by uid.
    const usersRef = db.collection('users');
    const [warnedSnap, blacklistedSnap, bannedSnap] = await Promise.all([
      usersRef.where('warningCount', '>', 0).get(),
      usersRef.where('isBlacklisted', '==', true).get(),
      usersRef.where('isBanned', '==', true).get(),
    ]);

    const userMap = new Map<string, Record<string, any>>();
    const addDocs = (snap: any) => {
      snap.docs.forEach((d: any) => {
        if (!userMap.has(d.id)) {
          userMap.set(d.id, { uid: d.id, ...(d.data() as any) });
        }
      });
    };
    addDocs(warnedSnap);
    addDocs(blacklistedSnap);
    addDocs(bannedSnap);

    // Register sort: banned first, then blacklisted, then warningCount
    // descending; name ascending as a stable final tiebreak.
    const users = Array.from(userMap.values()).sort((a, b) => {
      if (a.isBanned && !b.isBanned) return -1;
      if (!a.isBanned && b.isBanned) return 1;
      if (a.isBlacklisted && !b.isBlacklisted) return -1;
      if (!a.isBlacklisted && b.isBlacklisted) return 1;
      const byCount = (b.warningCount || 0) - (a.warningCount || 0);
      if (byCount !== 0) return byCount;
      return String(a.displayName || '').localeCompare(
        String(b.displayName || '')
      );
    });

    const entries: PublicWarningRegistryEntry[] = [];
    for (const user of users) {
      const status: PublicWarningRegistryEntry['status'] = user.isBlacklisted
        ? 'blacklisted'
        : user.isBanned
          ? 'banned'
          : 'probation';

      // Date of the latest sanction: the newest warning in the member's
      // warnings subcollection (the same records the admin register
      // lazy-loads), or the blacklist date when it is later.
      let latestMillis = 0;
      try {
        const latestWarnSnap = await db
          .collection('users')
          .doc(user.uid)
          .collection('warnings')
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();
        if (!latestWarnSnap.empty) {
          latestMillis = toMillisSafe(latestWarnSnap.docs[0].data().createdAt);
        }
      } catch (e) {
        console.warn(
          '[api/public/warning-registry] Failed to load latest warning for a member:',
          e
        );
      }
      if (user.isBlacklisted) {
        latestMillis = Math.max(
          latestMillis,
          toMillisSafe(user.blacklistedAt)
        );
      }

      const chapter = user.chapterId
        ? chapterMap[user.chapterId] || user.chapterName || user.chapterId
        : user.chapterName || null;

      entries.push({
        name: user.displayName || 'Member',
        chapter,
        status,
        warnings: `${user.warningCount || 0}/${threshold}`,
        lastSanctionDate:
          latestMillis > 0 ? new Date(latestMillis).toISOString() : null,
      });
    }

    return NextResponse.json({ entries });
  } catch (e) {
    console.error('[api/public/warning-registry] Failed:', e);
    return NextResponse.json(
      { error: 'Failed to load the warning registry.' },
      { status: 500 }
    );
  }
}
