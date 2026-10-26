// Production wiring for the erasure flow (Workstream F).
import { admin, getDb } from '@/lib/server/firebase-admin';
import type { ErasureDeps } from './erasure';
import { createSupaErasureDb, retentionSupaEnabled } from './supa-seam';

export function createErasureDeps(): ErasureDeps {
  const db = getDb();
  if (!db) {
    throw new Error('Firestore Admin SDK not initialized (getDb() returned null)');
  }
  return {
    db: db as unknown as ErasureDeps['db'],
    deleteAuthUser: async (uid: string) => {
      await admin.auth().deleteUser(uid);
    },
    writeAudit: async (entry) => {
      await db.collection('audit_logs').add({
        ...entry,
        timestamp: new Date(),
      });
    },
    now: () => new Date(),
  };
}

/**
 * Supa deps for the erasure REQUEST LIFECYCLE (cutover; residual
 * compliance consumer #2 — plan G3's named design point, whose db
 * half is createSupaErasureDb in supa-seam.ts): the erasure_requests
 * db is the seam facade; Auth deletion and the audit write stay on
 * the production Firestore deps, exactly as the seam's wrap list
 * rules (audit_logs is a foreign cluster). erasure.ts changes zero
 * lines.
 *
 * Per ruling G3-2 the EXECUTE path never runs on these deps — the
 * execute route keeps createErasureDeps() (the facade itself throws
 * for any collection other than erasure_requests). Only the
 * request/withdraw lifecycle (account erasure-request route) selects
 * these, via createErasureDepsForLifecycle().
 */
export function createErasureDepsSupa(): ErasureDeps {
  const base = createErasureDeps();
  return {
    ...base,
    db: createSupaErasureDb() as unknown as ErasureDeps['db'],
  };
}

/**
 * Lifecycle deps selector: Supa deps when the 'erasure-consent'
 * surface is enabled, otherwise exactly createErasureDeps()
 * (byte-identical flag-OFF behaviour).
 */
export function createErasureDepsForLifecycle(): ErasureDeps {
  return retentionSupaEnabled() ? createErasureDepsSupa() : createErasureDeps();
}
