// Production wiring for the erasure flow (Workstream F).
import { admin, getDb } from '@/lib/server/firebase-admin';
import type { ErasureDeps } from './erasure';

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
