/**
 * @jest-environment node
 *
 * sendPushToUser user-doc dedupe: when the caller passes the user doc
 * it already fetched (NotificationService.send / broadcastByRoles),
 * the push leg must not re-get the identical document. Without the
 * pass-through, behavior is exactly as before (own fetch, not-found
 * branch intact). No live Firestore: getDb is a counting fake.
 */

jest.mock('firebase-admin', () => ({
  messaging: jest.fn(() => ({ sendEachForMulticast: jest.fn() })),
  firestore: { FieldValue: { arrayRemove: (...args: unknown[]) => args } },
}));

const dbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => dbHolder.db,
}));

jest.mock('@/lib/server/supa-identity-primary', () => ({
  identityPrimaryFlagOn: jest.fn(async () => false),
  primaryIdentitySet: jest.fn(async () => undefined),
}));

import { sendPushToUser } from '@/lib/server/push-server';

function makeDb(userData: Record<string, unknown> | null) {
  let userDocGets = 0;
  const db = {
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (_uid: string) => ({
          get: async () => {
            userDocGets += 1;
            return {
              exists: userData !== null,
              data: () => userData ?? undefined,
            };
          },
          update: async () => undefined,
        }),
      };
    },
  };
  return { db, gets: () => userDocGets };
}

const NOTIF = { title: 'T', body: 'B' };

beforeEach(() => {
  dbHolder.db = null;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.log as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();
});

describe('sendPushToUser prefetched user data', () => {
  it('prefetched data: no user-doc get, tokens honored from the passed data', async () => {
    const { db, gets } = makeDb({ fcmTokens: ['tok-1'], pushEnabled: true });
    dbHolder.db = db;
    // Empty-token prefetch keeps the test off the messaging path while
    // still proving the read is skipped.
    const res = await sendPushToUser('user-1', NOTIF, { fcmTokens: [], pushEnabled: true });
    expect(res).toEqual({ success: true, sent: 0, failed: 0 });
    expect(gets()).toBe(0);
  });

  it('prefetched pushEnabled === false: still no get, nothing sent', async () => {
    const { db, gets } = makeDb(null);
    dbHolder.db = db;
    const res = await sendPushToUser('user-1', NOTIF, { fcmTokens: ['tok-1'], pushEnabled: false });
    expect(res).toEqual({ success: true, sent: 0, failed: 0 });
    expect(gets()).toBe(0);
  });

  it('no prefetch: fetches the user doc exactly once, as before', async () => {
    const { db, gets } = makeDb({ fcmTokens: [], pushEnabled: true });
    dbHolder.db = db;
    const res = await sendPushToUser('user-1', NOTIF);
    expect(res).toEqual({ success: true, sent: 0, failed: 0 });
    expect(gets()).toBe(1);
  });

  it('no prefetch + missing user: not-found result preserved', async () => {
    const { db, gets } = makeDb(null);
    dbHolder.db = db;
    const res = await sendPushToUser('ghost', NOTIF);
    expect(res).toEqual({ success: false, sent: 0, failed: 0 });
    expect(gets()).toBe(1);
  });
});
