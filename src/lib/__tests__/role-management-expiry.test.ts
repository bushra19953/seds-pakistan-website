/**
 * role-management assignRole expiry forwarding (EXPIRY-UI plan 4.2,
 * contracts 3.2):
 * - When the caller provides an expiry, the /api/admin/roles/write body
 *   carries expiresAt (ISO string) AND expiresRoleKey together; the two
 *   travel as a pair, because the grant record cannot say which custom
 *   grant expires without the key (contracts 2.2).
 * - When expiresAt is undefined (every non-custom caller), neither key
 *   is sent, so catalog flows post the identical body as before.
 * - An explicit null is sent through as null: the admin cleared the
 *   date in the inspector, which means "grant with no expiry", a state
 *   distinct from "field not provided" (plan 4.3).
 * Gate behaviour for custom slugs itself is assign-path's suite; here
 * the primary role is always a catalog key.
 *
 * No em dashes are used in test names in this file.
 */

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: jest.fn(async () => 'test-token') },
  }),
}));

jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => undefined })),
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: [] })),
}));

import { assignRole } from '../role-management';

const REASON = 'Term grant for the poster team exhibition push';
const EXPIRES_AT = '2027-01-01T00:00:00.000Z';
const EXPIRES_KEY = 'custom_poster_team_lead';

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({}),
  }));
  global.fetch = fetchMock as any;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

function lastWriteBody() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/admin/roles/write');
  return JSON.parse((init as any).body);
}

describe('assignRole expiry forwarding', () => {
  it('forwards expiresAt and expiresRoleKey together when an expiry is provided', async () => {
    const ok = await assignRole(
      null as any,
      'uid-target-1',
      'chapter_design_chair' as any,
      'uid-admin',
      REASON,
      { expiresAt: EXPIRES_AT, expiresRoleKey: EXPIRES_KEY },
    );
    expect(ok).toBe(true);
    const body = lastWriteBody();
    expect(body.action).toBe('assign');
    expect(body.role).toBe('chapter_design_chair');
    expect(body.expiresAt).toBe(EXPIRES_AT);
    expect(body.expiresRoleKey).toBe(EXPIRES_KEY);
  });

  it('omits both expiry keys when no opts are given', async () => {
    const ok = await assignRole(
      null as any,
      'uid-target-1',
      'chapter_design_chair' as any,
      'uid-admin',
      REASON,
    );
    expect(ok).toBe(true);
    const body = lastWriteBody();
    expect('expiresAt' in body).toBe(false);
    expect('expiresRoleKey' in body).toBe(false);
    expect(body.consentRequestId).toBeNull();
  });

  it('omits both expiry keys when opts carry only a consent id', async () => {
    const ok = await assignRole(
      null as any,
      'uid-target-1',
      'chapter_design_chair' as any,
      'uid-admin',
      REASON,
      { consentRequestId: 'consent-1' },
    );
    expect(ok).toBe(true);
    const body = lastWriteBody();
    expect('expiresAt' in body).toBe(false);
    expect('expiresRoleKey' in body).toBe(false);
    expect(body.consentRequestId).toBe('consent-1');
  });

  it('sends an explicit null expiresAt through as null (cleared date means no expiry)', async () => {
    const ok = await assignRole(
      null as any,
      'uid-target-1',
      'chapter_design_chair' as any,
      'uid-admin',
      REASON,
      { expiresAt: null, expiresRoleKey: null },
    );
    expect(ok).toBe(true);
    const body = lastWriteBody();
    expect('expiresAt' in body).toBe(true);
    expect(body.expiresAt).toBeNull();
  });
});
