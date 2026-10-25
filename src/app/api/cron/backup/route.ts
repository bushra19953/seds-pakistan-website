import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import {
  createDefaultBackupDeps,
  runBackup,
  type BackupDb,
  type BackupDocSnapshot,
  type BackupRunRecord,
} from '@/lib/backup/engine';
import { getG4Handle } from '@/lib/server/backup-exports/g4-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/backup
 *
 * Scheduled server-side backup (Workstream F): exports every collection
 * in the backup registry to the private "SEDS Backups" Drive folder as
 * JSON plus a manifest, and writes a backup_runs run record.
 *
 * Authorization follows the /api/cron/clear-probation convention: Vercel
 * Cron supplies Authorization: Bearer <CRON_SECRET>; an authenticated
 * admin (canManagePermissions, the permission that gated the old manual
 * backup page) may also trigger it manually.
 *
 * Idempotency: each run gets a unique runId, collection files are named
 * with that runId, and the run record is written with set() semantics,
 * so a duplicate invocation creates a second complete run record rather
 * than corrupting the first.
 */

// --- Read-reduction wrapper (internal only, Workstream C read-burn fix) ---
//
// The backup engine (src/lib/backup/engine.ts) reads each registry
// collection with one unbounded collection.get(). This route is the
// engine's only scheduled entry point, so the reduction lives here as a
// wrapper around the engine's `db` dependency: the engine, the backup
// payload, the manifest and the run record are all untouched, and the
// wrapper returns exactly the documents the unbounded get() would have
// returned (same snapshots, document-id order).
//
// What the wrapper does per collection, per run:
//   1. Aggregate count() first (when the underlying reference supports
//      it). An empty collection is answered { docs: [] } with NO
//      document get() at all. The count also sizes non-empty reads, so
//      pagination can stop at the known total instead of issuing one
//      extra empty page when the size is an exact page multiple.
//   2. Non-empty collections are read in bounded pages of
//      BACKUP_PAGE_SIZE using orderBy('__name__') + limit() +
//      startAfter(last snapshot), instead of one unbounded get().
//      Total documents read for a non-empty collection is unchanged;
//      what changes is the per-query bound (peak snapshot size and
//      per-request duration), not the document set.
//   3. Results are memoised per run: a second get() for the same
//      collection name in the same run reuses the first read instead
//      of reading the collection again.
// Every capability is duck-typed and optional. A reference that offers
// no count()/limit()/startAfter() (e.g. the plain mocks in the engine
// tests) falls back to the original single get(), a failed count()
// falls back to a document read, and a failed first page falls back to
// the original get() — a reduction must never fail a backup that the
// unbounded read would have completed.

const BACKUP_PAGE_SIZE = 500;

interface BackupSnapshotLike {
  docs: BackupDocSnapshot[];
}

// Structural view of the extra Query surface a real Firestore
// CollectionReference carries beyond the engine's minimal BackupDb
// contract. Every member is optional; absence means "not supported".
interface FirestoreQueryLike {
  get: () => Promise<BackupSnapshotLike>;
  count?: () => { get: () => Promise<{ data: () => { count: number } }> };
  limit?: (n: number) => FirestoreQueryLike;
  orderBy?: (field: string) => FirestoreQueryLike;
  startAfter?: (
    snapshot: BackupDocSnapshot,
  ) => FirestoreQueryLike;
}

async function readCollectionBounded(
  ref: FirestoreQueryLike,
): Promise<BackupSnapshotLike> {
  // 1. Size the collection with an aggregate count when available.
  let expectedCount: number | null = null;
  if (typeof ref.count === 'function') {
    try {
      const countSnap = await ref.count().get();
      const value = countSnap.data()?.count;
      if (typeof value === 'number' && Number.isFinite(value)) {
        expectedCount = value;
      }
    } catch {
      // Count is an optimisation only; a failed count must not fail
      // the backup. Fall through to a document read.
      expectedCount = null;
    }
  }
  if (expectedCount === 0) {
    return { docs: [] };
  }

  // 2. Bounded pagination when the query surface supports it.
  const canPaginate =
    typeof ref.limit === 'function' && typeof ref.startAfter === 'function';
  if (!canPaginate) {
    return ref.get();
  }

  const docs: BackupDocSnapshot[] = [];
  let cursor: BackupDocSnapshot | undefined;
  for (;;) {
    let page: BackupSnapshotLike;
    try {
      let query: FirestoreQueryLike = ref;
      if (typeof query.orderBy === 'function') {
        query = query.orderBy('__name__');
      }
      if (typeof query.limit !== 'function') {
        // The ordered query lost the pagination surface (exotic
        // reference shape): correctness beats bounding, fall back.
        if (docs.length === 0 && !cursor) return ref.get();
        throw new Error('paginated query does not support limit()');
      }
      query = query.limit(BACKUP_PAGE_SIZE);
      if (cursor) {
        if (typeof query.startAfter !== 'function') {
          throw new Error('paginated query does not support startAfter()');
        }
        query = query.startAfter(cursor);
      }
      page = await query.get();
    } catch (err) {
      // A first-page failure falls back to the original unbounded read
      // so behaviour matches the pre-fix route; a later-page failure
      // is a genuine partial read and surfaces to the engine, which
      // records the collection as failed (same as a failed get()).
      if (docs.length === 0 && !cursor) return ref.get();
      throw err;
    }
    docs.push(...page.docs);
    if (page.docs.length < BACKUP_PAGE_SIZE) break;
    if (expectedCount !== null && docs.length >= expectedCount) break;
    cursor = page.docs[page.docs.length - 1];
  }
  return { docs };
}

function withBoundedCollectionReads(db: BackupDb): BackupDb {
  const cache = new Map<string, Promise<BackupSnapshotLike>>();
  return {
    collection: (name: string) => ({
      get: () => {
        const cached = cache.get(name);
        if (cached) {
          // Reuse the run's first read; hand back a fresh container so
          // a caller mutating the docs array cannot corrupt the cache.
          return cached.then((snap) => ({ docs: [...snap.docs] }));
        }
        const pending = readCollectionBounded(
          db.collection(name) as unknown as FirestoreQueryLike,
        );
        cache.set(name, pending);
        // A failed read is not memoised: a later caller may retry.
        pending.catch(() => {
          if (cache.get(name) === pending) cache.delete(name);
        });
        return pending.then((snap) => ({ docs: [...snap.docs] }));
      },
    }),
  };
}

async function handleBackup(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const cronSecret = process.env.CRON_SECRET;
    const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
    if (!isCron) {
      const auth = await verifyAuthentication(req);
      if (!auth.authenticated || !auth.user?.role) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const allowed = await hasServerPermission(auth.user.role, 'canManagePermissions');
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const deps = createDefaultBackupDeps();
    // Source-of-record rule (PLAN_G4 section 4, C-G4-1): the backup's
    // collection READS always come from Firestore (deps.db, the engine
    // factory's own db) — never from the Supabase mirror. A mirror read
    // would invert the backup (a copy of the mirror is not a backup of
    // the record), and a collection missing from the mirror landing
    // would back up silently EMPTY. There is deliberately no code path
    // from this route's read wrapper to the handle; the wrapper below
    // only ever wraps the Firestore db. Flip-readiness for this route
    // is STAYS-FIRESTORE.
    //
    // The one handle touchpoint: the backup_runs RUN RECORD (run
    // bookkeeping, not backup content) follows the 'backup-exports'
    // surface, so it lands where its reader (admin/backup-runs, same
    // surface) reads when the flag is ON. With the flag OFF the
    // engine's default Firestore writeRunRecord is used unchanged.
    const handle = getG4Handle();
    const result = await runBackup({
      ...deps,
      db: withBoundedCollectionReads(deps.db),
      ...(handle
        ? {
            writeRunRecord: async (
              runId: string,
              record: BackupRunRecord,
            ) => {
              await handle
                .collection('backup_runs')
                .doc(runId)
                .set(record as unknown as Record<string, unknown>);
            },
          }
        : {}),
    });

    return NextResponse.json({
      runId: result.runId,
      status: result.status,
      collections: result.totals.collections,
      documents: result.totals.documents,
    });
  } catch (error: any) {
    console.error('[cron/backup] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to run backup' },
      { status: 500 },
    );
  }
}

// Vercel Cron Jobs invoke the path with GET.
export async function GET(req: NextRequest) {
  return handleBackup(req);
}

// Manual / admin-triggered invocation.
export async function POST(req: NextRequest) {
  return handleBackup(req);
}
