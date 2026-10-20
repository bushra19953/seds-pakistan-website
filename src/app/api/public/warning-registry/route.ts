import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { DEFAULT_WARNING_SETTINGS, WarningSettings } from '@/types/user';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/warning-registry
 *
 * Public read-only feed for the warning registry page (/warning-registry).
 *
 * Why this exists: the page used to read `users` and `users/{uid}/warnings`
 * directly from the client. Firestore rules deny both reads to non-admin
 * visitors (`users` list requires sign-in; the `warnings` subcollection is
 * owner/admin-only), so the public page silently failed with
 * PERMISSION_DENIED and showed 0 records while /admin/defaulters showed
 * active probation records. Opening those rules publicly is not an option:
 * raw warning docs carry internal notes and admin UIDs, and user docs carry
 * email/phone fields.
 *
 * This route reads the SAME source the admin panel reads
 * (`users/{uid}/warnings` with `isActive == true`, non-expired only) via the
 * Admin SDK and returns a sanitized projection. No rule changes needed.
 *
 * "Active" mirrors the admin Defaulters badge (WarningStatusBadge):
 * isActive == true, and (isPermanent OR expiresAt is missing OR in future).
 */

type DateLike =
  | { toMillis?: () => number; toDate?: () => Date; seconds?: number }
  | Date
  | string
  | number
  | null
  | undefined;

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

function toIsoOrNull(val: any): string | null {
  const ms = toMillisSafe(val);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

// Active-warning predicate shared with /admin/defaulters: an isActive doc
// stays active when it is permanent, has no expiry recorded, or expires in
// the future.
function isCurrentlyActive(w: Record<string, any>, nowMillis: number): boolean {
  if (w.isPermanent === true) return true;
  const expMillis = toMillisSafe(w.expiresAt);
  if (expMillis <= 0) return true;
  return expMillis > nowMillis;
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

    // Load warning settings; publicVisibility gates the whole registry.
    let settings: WarningSettings = { ...DEFAULT_WARNING_SETTINGS };
    try {
      const settingsSnap = await db.collection('warningConfig').doc('global').get();
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

    const usersRef = db.collection('users');
    const nowMillis = Date.now();

    // Same member set the admin defaulters panel builds: everyone with at
    // least one recorded warning, plus blacklisted and banned members (they
    // may carry warningCount = 0 after expiry).
    const [warnedSnap, blacklistedSnap, bannedSnap] = await Promise.all([
      usersRef.where('warningCount', '>', 0).get(),
      usersRef.where('isBlacklisted', '==', true).get(),
      usersRef.where('isBanned', '==', true).get(),
    ]);

    const userDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const snap of [warnedSnap, blacklistedSnap, bannedSnap]) {
      for (const doc of snap.docs) {
        if (!userDocs.has(doc.id)) userDocs.set(doc.id, doc);
      }
    }

    // Same source as the admin panel: users/{uid}/warnings with
    // isActive == true, filtered to currently-active ones. Fields are
    // projected to the public subset only; internal notes, admin UIDs,
    // revokedBy/revokedAt metadata and raw task links stay private.
    const entries = await Promise.all(
      Array.from(userDocs.values()).map(async (doc) => {
        const data = (doc.data() || {}) as Record<string, any>;
        let warnings: any[] = [];
        try {
          const warnSnap = await doc.ref
            .collection('warnings')
            .where('isActive', '==', true)
            .get();
          warnings = warnSnap.docs
            .map((w) => {
              const wd = (w.data() || {}) as Record<string, any>;
              return { id: w.id, ...wd };
            })
            .filter((w) => isCurrentlyActive(w, nowMillis))
            .sort(
              (a, b) => toMillisSafe(b.createdAt) - toMillisSafe(a.createdAt)
            )
            .map((w) => {
              const publicWarning: Record<string, any> = {
                id: w.id,
                reason: String(w.reason || 'Warning issued'),
                type: w.type || 'other',
                severity: w.severity || 'medium',
                createdAt: toIsoOrNull(w.createdAt),
                expiresAt: toIsoOrNull(w.expiresAt),
                isPermanent: w.isPermanent === true,
                taskTitle:
                  typeof w.taskTitle === 'string' ? w.taskTitle : null,
                penaltyPoints:
                  typeof w.penaltyPoints === 'number' ? w.penaltyPoints : 0,
                appealStatus: w.appealStatus || 'none',
              };
              // Forward-compatible pass-through for fields the client page
              // already renders when present.
              if (typeof w.demotedTitle === 'string')
                publicWarning.demotedTitle = w.demotedTitle;
              if (typeof w.demoteToRole === 'string')
                publicWarning.demoteToRole = w.demoteToRole;
              return publicWarning;
            });
        } catch (e) {
          console.warn(
            `[api/public/warning-registry] Failed to load warnings for ${doc.id}:`,
            e
          );
        }

        return {
          uid: doc.id,
          displayName: String(data.displayName || 'Unknown'),
          chapterId: data.chapterId || null,
          chapterName: data.chapterName || null,
          photoURL: data.photoURL || null,
          warningCount:
            typeof data.warningCount === 'number' ? data.warningCount : 0,
          isBlacklisted: data.isBlacklisted === true,
          isBanned: data.isBanned === true,
          activeWarnings: warnings,
        };
      })
    );

    // Same ordering as the public page used before the read-path fix:
    // blacklisted first, then most active warnings first.
    entries.sort((a, b) => {
      if (a.isBlacklisted && !b.isBlacklisted) return -1;
      if (!a.isBlacklisted && b.isBlacklisted) return 1;
      return (b.activeWarnings.length || 0) - (a.activeWarnings.length || 0);
    });

    return NextResponse.json({
      success: true,
      generatedAt: new Date(nowMillis).toISOString(),
      settings: {
        blacklistThreshold: settings.blacklistThreshold,
        expirationDays: settings.expirationDays,
        publicVisibility: true,
      },
      users: entries,
    });
  } catch (e: any) {
    console.error('[api/public/warning-registry] Error:', e);
    return NextResponse.json(
      { error: e?.message || 'Failed to load warning registry' },
      { status: 500 }
    );
  }
}
