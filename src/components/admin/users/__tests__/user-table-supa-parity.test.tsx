/**
 * G3 Supabase parity pin for the admin directory UI.
 *
 * The directory's data plane is GET /api/admin/users (G1's seam). Under
 * the flag (DECISIONS.md) the response's `searchMethod` changes from
 * "native_firestore" to "supabase" and the search path's `debug` block
 * is a Firestore-mode artefact. This suite renders the REAL UserTable
 * with the API layer (fetch) mocked to each mode's response shape and
 * asserts the rendered output is byte-identical, so a flag flip cannot
 * silently change what the admin sees.
 *
 * It also pins the three flagged stays from SUPA_G3/INVENTORY.md:
 * the chapters client read (R2) still feeds row chapter names, and the
 * leave_audit realtime listener (R3, sweep A14) is still subscribed —
 * G3 does not migrate either silently.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { invalidateChaptersCache } from '@/lib/chapters-client';

// --- Firestore client doubles (records calls; serves one chapter) ---
const fsCalls = { getDocsCols: [] as string[], onSnapshot: 0 };
let chaptersServedResolve: () => void = () => {};
const chaptersServed = new Promise<void>((r) => { chaptersServedResolve = r; });
jest.mock('firebase/firestore', () => ({
  collection: (_fs: any, name: string) => ({ __col: name }),
  query: (...args: any[]) => ({ __q: args }),
  orderBy: () => ({}),
  limit: () => ({}),
  startAfter: () => ({}),
  getDocs: jest.fn(async (ref: any) => {
    const col = ref?.__col ?? ref?.__q?.[0]?.__col;
    fsCalls.getDocsCols.push(String(col));
    if (col === 'chapters') {
      chaptersServedResolve();
      return { docs: [{ id: 'ist', data: () => ({ name: 'IST Chapter' }) }] };
    }
    return { docs: [] };
  }),
  onSnapshot: jest.fn(() => {
    fsCalls.onSnapshot += 1;
    return () => {};
  }),
}));

jest.mock('@/firebase', () => {
  // Stable singleton, like the real hook: a fresh object per render
  // would refire every firestore-dep effect on every render.
  const firestoreSingleton = {};
  return {
  useFirestore: () => firestoreSingleton,
  useUser: () => ({
    user: { uid: 'admin-1', getIdToken: jest.fn(async () => 'test-token') },
    role: 'admin',
    isLoading: false,
  }),
  };
});

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, isLoading: false }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/lib/unified-roles', () => ({
  getUnifiedRoleOptions: jest.fn(async (_fs: any, _uid?: string, chapterId?: string) =>
    chapterId
      ? [{ key: 'custom_poster_lead', label: 'Poster Lead (custom_poster_lead)' }]
      : [{ key: 'member', label: 'Member (member)' }],
  ),
}));

jest.mock('@/lib/role-management', () => ({
  assignRole: jest.fn(async () => true),
}));

jest.mock('@/lib/authority-refresh', () => ({
  refreshTokenAfterRoleChange: jest.fn(async () => {}),
}));

jest.mock('@/components/admin/roles/grant-expiry', () => ({
  isCustomRoleKey: (k: string) => k.startsWith('custom_'),
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

jest.mock('@/lib/client/consent-gate-error', () => ({
  isConsentGateBlocked: () => false,
}));

// Columns are pinned by their own suite; here they are inert so the
// test isolates UserTable's data plane (fetch mapping + enrichment).
jest.mock('../user-table-columns', () => ({
  buildUserColumns: () => [],
}));

// One dynamic stub for both dynamic imports: the virtualized table
// dumps exactly what UserTable hands it; anything else renders null.
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => {
    const ReactLocal = require('react');
    return (props: any) => {
      if (!props || !('rows' in props)) return null;
      return ReactLocal.createElement(
        'div',
        { 'data-testid': 'directory-dump' },
        [
          `roles:${(props.roleOptions || []).map((o: any) => o.key).join(',')}`,
          `chapters:${(props.chapters || []).map((c: any) => `${c.id}=${c.name}`).join(',')}`,
          ...(props.rows || []).map(
            (r: any) => `row:${r.uid}|${r.displayName}|${r.email}|${r.role}|${r.chapterName}`,
          ),
        ].join('\n'),
      );
    };
  },
}));

jest.setTimeout(60000);
jest.retryTimes(2);

import UserTable from '../user-table';

(globalThis as any).React = React;

const USERS = [
  {
    uid: 'u1',
    displayName: 'Ayesha Khan',
    email: 'ayesha@example.com',
    whatsapp: '03001234567',
    role: 'member',
    roleExpiresAt: null,
    chapterId: 'ist',
    isBanned: false,
  },
];

const FLAG_OFF_BODY = {
  users: USERS,
  nextCursor: 'u1',
  pageSize: 20,
  responseTime: 3,
  searchMethod: 'native_firestore',
  debug: { query: '', totalScored: 1 },
};

const FLAG_ON_BODY = {
  users: USERS,
  nextCursor: 'u1',
  pageSize: 20,
  responseTime: 9,
  searchMethod: 'supabase',
  // no debug block: the UI must not depend on it in either mode
};

const fetchUrls: string[] = [];
function mockApi(body: any) {
  fetchUrls.length = 0;
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    fetchUrls.push(String(url));
    // Deterministic ordering: the response only lands after the
    // chapters read has been served, plus a grace beat for React to
    // land the chapters state, refire fetchPage and abort the stale
    // in-flight request. (In production the same race exists — if the
    // API wins, the client cache keeps the raw chapterId as the row's
    // chapterName for the session; flag-independent, see INVENTORY.)
    await chaptersServed;
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, status: 200, json: async () => body };
  });
}

async function renderDirectory(body: any) {
  mockApi(body);
  const utils = render(<UserTable />);
  await waitFor(
    () => expect(screen.getByTestId('directory-dump').textContent).toContain('row:u1|Ayesha Khan'),
    { timeout: 8000 },
  );
  // Chapter enrichment lands via the chapters read + a refetch cycle:
  // the row's chapterName resolves to the chapter's display name.
  await waitFor(
    () =>
      expect(screen.getByTestId('directory-dump').textContent).toContain(
        'row:u1|Ayesha Khan|ayesha@example.com|member|IST Chapter',
      ),
    { timeout: 10000 },
  );
  // Settle: let any in-flight refetch cycle finish so the captured
  // output is the component's resting state in this mode.
  await new Promise((r) => setTimeout(r, 400));
  return utils;
}

beforeEach(() => {
  fsCalls.getDocsCols.length = 0;
  fsCalls.onSnapshot = 0;
  // Read-bleed fix: the chapters read now goes through the shared
  // chapters-client cache (src/lib/chapters-client.ts) — same client
  // getDocs over `chapters`, deduped across components. Its module
  // cache survives across tests in this file, so reset it per test or
  // the flagged-stays pin below observes a cache hit instead of the
  // read it pins.
  invalidateChaptersCache();
});

describe('admin directory UI — Supabase flag parity (G3)', () => {
  it('renders byte-identical output for native_firestore and supabase responses', async () => {
    const off = await renderDirectory(FLAG_OFF_BODY);
    const offText = off.container.textContent;
    const offUrls = [...fetchUrls];
    off.unmount();

    const on = await renderDirectory(FLAG_ON_BODY);
    const onText = on.container.textContent;
    const onUrls = [...fetchUrls];
    on.unmount();

    expect(onText).toBe(offText);
    // Same request shape in both modes (refetch counts vary with
    // effect refires and are not part of the parity contract).
    expect(offUrls.length).toBeGreaterThan(0);
    expect([...new Set(onUrls)]).toEqual([...new Set(offUrls)]);
    expect([...new Set(onUrls)]).toEqual(['/api/admin/users?pageSize=20']);
  });

  it('shows the row, its catalog role option and the chapter name in both modes', async () => {
    for (const body of [FLAG_OFF_BODY, FLAG_ON_BODY]) {
      const utils = await renderDirectory(body);
      const dump = screen.getByTestId('directory-dump').textContent || '';
      expect(dump).toContain('row:u1|Ayesha Khan|ayesha@example.com|member|IST Chapter');
      expect(dump).toContain('roles:member');
      expect(dump).toContain('chapters:ist=IST Chapter');
      expect(utils.container.textContent).toContain('1 Active Profiles Processed');
      utils.unmount();
    }
  });

  it('pins the flagged stays: chapters client read (R2) and leave_audit listener (R3)', async () => {
    const utils = await renderDirectory(FLAG_ON_BODY);
    expect(fsCalls.getDocsCols).toContain('chapters');
    expect(fsCalls.onSnapshot).toBeGreaterThanOrEqual(1);
    utils.unmount();
  });
});
