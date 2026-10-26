import { NextResponse, type NextRequest } from 'next/server';
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
 * v2 (founder order 2026-10-26): every entry also carries the
 * sanction's expiry and a link to the member's public profile, and
 * the feed is paginated and filterable so the register stays fast
 * as SEDS grows.
 *
 * The registry publishes the FACT of a current sanction only. The
 * projection below is a whitelist enforced here, server-side: display
 * name, chapter, status, warning count, the date of the latest
 * sanction, the sanction expiry, and the member's public profile
 * path. Reasons, case details, notes, and all contact data never
 * leave the server. The profile path is built here from the member's
 * document id; it is never read from a user-controlled field.
 *
 * Who appears mirrors the admin register (the Register tab of
 * /admin/discipline, DefaultersRegister), with "current" judged on
 * the underlying records, exactly as the register's own warning badge
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
 *  - the sanction date is the latest CURRENT sanction's date: the
 *    newest current warning, or blacklistedAt / bannedAt when that
 *    flag sanction is later (so a banned-only entry shows its ban
 *    date) (audit WR-20; WR-21 is subsumed by the current-warning
 *    judgment above, which is stricter than isActive alone: it also
 *    excludes expired warnings).
 *  - expiry (v2): for a probation entry, the LATEST expiry among the
 *    member's current warnings, because that is when the member
 *    comes off the register; null when any current warning is
 *    permanent or has no derivable expiry, which the page renders
 *    as "No expiry". Flag entries (blacklisted, banned) have no
 *    expiry: null, rendered as "Until reinstated".
 *  - if warningConfig cannot be read, the feed fails closed and
 *    serves no entries, rather than defaulting to public (WR-26).
 *
 * Pagination and filters (v2): query params page (1-based, default
 * 1), pageSize (default 25, capped at 50), chapter (chapter id or
 * chapter name), status (probation | blacklisted | banned), and q
 * (case-insensitive substring on the display name). The response is
 * the page of entries plus pagination metadata only: total, page,
 * pageSize, totalPages. An unrecognized status value matches nobody.
 *
 * Read bound (v2): a request never scans the users collection. It
 * reads warningConfig (1), the chapters collection (one doc per
 * chapter, a small bounded set), and at most CANDIDATE_SCAN_LIMIT
 * member docs across the four sanction-marker queries (each query's
 * limit is the capacity remaining, with the flag queries first so a
 * flag sanction is never truncated away). Chapter, status, and name
 * filters are all member-doc fields, so they are applied BEFORE any
 * warnings read: the warnings subcollection is read only for members
 * who pass the filters. Exact totals, the register sort, and exact
 * per-entry expiry cannot be derived without judging every filtered
 * candidate's warnings, so warnings reads equal the warning docs of
 * the filtered candidates; the bound that matters as SEDS grows is
 * that reads never grow with total membership, only with the number
 * of sanctioned members inside the scan cap.
 *
 * Reads go through the Admin SDK: Firestore rules deny `users` and
 * the `warnings` subcollection to public visitors, and raw docs
 * carry internal fields that must never be exposed.
 */

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const CANDIDATE_SCAN_LIMIT = 500;

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

type RegistryStatus = 'probation' | 'blacklisted' | 'banned';

function statusOf(user: Record<string, any>): RegistryStatus {
  return user.isBlacklisted
    ? 'blacklisted'
    : user.isBanned
      ? 'banned'
      : 'probation';
}

export interface PublicWarningRegistryEntry {
  name: string;
  chapter: string | null;
  status: RegistryStatus;
  warnings: string;
  lastSanctionDate: string | null;
  expiresAt: string | null;
  profilePath: string;
}

interface RegistryQuery {
  page: number;
  pageSize: number;
  chapter: string | null;
  status: RegistryStatus | 'invalid' | null;
  q: string | null;
}

function parseQuery(request?: NextRequest): RegistryQuery {
  const params = new URL(
    request?.url ?? 'http://localhost/api/public/warning-registry'
  ).searchParams;

  const rawPage = Number.parseInt(params.get('page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawSize = Number.parseInt(params.get('pageSize') ?? '', 10);
  const pageSize = Number.isFinite(rawSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize))
    : DEFAULT_PAGE_SIZE;

  const chapterRaw = (params.get('chapter') ?? '').trim();
  const qRaw = (params.get('q') ?? '').trim();

  const statusRaw = (params.get('status') ?? '').trim().toLowerCase();
  const status: RegistryQuery['status'] =
    statusRaw === ''
      ? null
      : statusRaw === 'probation' ||
          statusRaw === 'blacklisted' ||
          statusRaw === 'banned'
        ? statusRaw
        : 'invalid';

  return {
    page,
    pageSize,
    chapter: chapterRaw === '' ? null : chapterRaw,
    status,
    q: qRaw === '' ? null : qRaw.toLowerCase(),
  };
}

function emptyPage(query: RegistryQuery) {
  return NextResponse.json({
    entries: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: 0,
  });
}

export async function GET(request?: NextRequest) {
  const query = parseQuery(request);
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
    // Fail CLOSED on a read error (audit WR-26): this is a
    // privacy-sensitive public surface, so if warningConfig cannot be
    // read the stored "off" might be in effect and no entry may be
    // served. Withhold every entry and return the same valid empty
    // response the clear register produces, rather than defaulting to
    // public or failing with a 500. A config doc that simply does not
    // exist is not an error: the defaults apply, as before.
    let settings: WarningSettings = { ...DEFAULT_WARNING_SETTINGS };
    let settingsReadFailed = false;
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
      settingsReadFailed = true;
      console.warn(
        '[api/public/warning-registry] Failed to load warningConfig, withholding entries (fail closed):',
        e
      );
    }

    if (settingsReadFailed) {
      return emptyPage(query);
    }

    if (settings.publicVisibility === false) {
      return NextResponse.json(
        { error: 'Warning registry is not public.' },
        { status: 403 }
      );
    }

    if (query.status === 'invalid') {
      return emptyPage(query);
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

    const chapterOf = (user: Record<string, any>): string | null =>
      user.chapterId
        ? chapterMap[user.chapterId] || user.chapterName || user.chapterId
        : user.chapterName || null;

    // Candidate set: members whose record carries any sanction marker
    // (the admin register's queries, plus the derived live-warning
    // counter). Inclusion is then judged per member on the warning
    // records themselves, so stale counters cannot publish anyone.
    // The four queries share one read budget: each query's limit is
    // the capacity remaining under CANDIDATE_SCAN_LIMIT, and the flag
    // queries run first so a blacklist or ban is never truncated
    // away by the cap.
    const usersRef = db.collection('users');
    const markerQueries: Array<() => any> = [
      () => usersRef.where('isBanned', '==', true),
      () => usersRef.where('isBlacklisted', '==', true),
      () => usersRef.where('activeWarningCount', '>', 0),
      () => usersRef.where('warningCount', '>', 0),
    ];
    const userMap = new Map<string, Record<string, any>>();
    let readsUsed = 0;
    for (const makeQuery of markerQueries) {
      const remaining = CANDIDATE_SCAN_LIMIT - readsUsed;
      if (remaining <= 0) break;
      const snap = await makeQuery().limit(remaining).get();
      readsUsed += snap.docs.length;
      snap.docs.forEach((d: any) => {
        if (!userMap.has(d.id)) {
          userMap.set(d.id, { uid: d.id, ...(d.data() as any) });
        }
      });
    }

    // Filters that live on the member doc apply BEFORE any warnings
    // read, so a filtered request only pays warnings reads for the
    // members who pass.
    const candidates = [...userMap.values()].filter((user) => {
      if (query.status !== null && statusOf(user) !== query.status) {
        return false;
      }
      if (query.chapter !== null) {
        const wanted = query.chapter.toLowerCase();
        const resolved = chapterOf(user);
        const matches =
          user.chapterId === query.chapter ||
          (resolved !== null && resolved.toLowerCase().includes(wanted)) ||
          (typeof user.chapterName === 'string' &&
            user.chapterName.toLowerCase().includes(wanted));
        if (!matches) return false;
      }
      if (query.q !== null) {
        const name = String(user.displayName || '').toLowerCase();
        if (!name.includes(query.q)) return false;
      }
      return true;
    });

    interface Judged {
      user: Record<string, any>;
      activeCount: number;
      latestActiveMillis: number;
      latestExpiryMillis: number;
      hasOpenEndedWarning: boolean;
    }
    const judged: Judged[] = [];
    for (const user of candidates) {
      let activeCount = 0;
      let latestActiveMillis = 0;
      let latestExpiryMillis = 0;
      let hasOpenEndedWarning = false;
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
            // Register expiry: the member comes off the register
            // when their LAST current warning lapses. A permanent
            // warning, or one with no derivable expiry, keeps them
            // on it indefinitely.
            if (w.isPermanent === true) {
              hasOpenEndedWarning = true;
            } else {
              const exp = warningExpiryMillis(w, expirationDays);
              if (exp <= 0) {
                hasOpenEndedWarning = true;
              } else {
                latestExpiryMillis = Math.max(latestExpiryMillis, exp);
              }
            }
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
      judged.push({
        user,
        activeCount,
        latestActiveMillis,
        latestExpiryMillis,
        hasOpenEndedWarning,
      });
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

    const allEntries: PublicWarningRegistryEntry[] = judged.map(
      ({
        user,
        activeCount,
        latestActiveMillis,
        latestExpiryMillis,
        hasOpenEndedWarning,
      }) => {
        const status = statusOf(user);

        // Date of the latest sanction: the newest current warning, or
        // the blacklist / ban date when it is later (the flag is itself
        // the standing sanction for a flagged member; a banned-only
        // entry therefore shows its ban date, audit WR-20).
        let latestMillis = latestActiveMillis;
        if (user.isBlacklisted) {
          latestMillis = Math.max(latestMillis, toMillisSafe(user.blacklistedAt));
        }
        if (user.isBanned) {
          latestMillis = Math.max(latestMillis, toMillisSafe(user.bannedAt));
        }

        // Flag sanctions end only on reinstatement, so they carry no
        // expiry. A probation entry expires at its latest current
        // warning's expiry, or never when an open-ended warning is
        // current.
        const expiresAt =
          status !== 'probation' || hasOpenEndedWarning || latestExpiryMillis <= 0
            ? null
            : new Date(latestExpiryMillis).toISOString();

        return {
          name: user.displayName || 'Member',
          chapter: chapterOf(user),
          status,
          warnings: `${activeCount}/${threshold}`,
          lastSanctionDate:
            latestMillis > 0 ? new Date(latestMillis).toISOString() : null,
          expiresAt,
          profilePath: `/profile/unified/${user.uid}`,
        };
      }
    );

    const total = allEntries.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / query.pageSize);
    const start = (query.page - 1) * query.pageSize;
    const entries = allEntries.slice(start, start + query.pageSize);

    return NextResponse.json({
      entries,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
    });
  } catch (e) {
    console.error('[api/public/warning-registry] Failed:', e);
    return NextResponse.json(
      { error: 'Failed to load the warning registry.' },
      { status: 500 }
    );
  }
}
