/**
 * @jest-environment node
 *
 * Cutover primacy for GET /api/cron/backup: the C-G4-1
 * source-of-record rule INVERTS under isSupaPrimary('backup-exports').
 *  - PRIMARY on + handle: collection reads come from the HANDLE
 *    (Supabase is the source of record) — the FakeSupa users doc is
 *    in the uploaded payload, the Firestore-factory doc is NOT;
 *    the run record follows the surface as before.
 *  - PRIMARY on + NO handle: loud 500, nothing is backed up (no
 *    silent Firestore-sourced backup of the stale store).
 * The companion supa-flag-on.test.ts pins the non-primary behaviour
 * (SURFACES-only does NOT invert). Real runBackup engine; only the
 * deps factory is stubbed. Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockUploads: Array<{ fileName: string; body: string }> = [];
const mockDefaultRunRecords: Array<{ runId: string }> = [];

jest.mock('@/lib/server/backup-exports/g4-data', () => ({
  BACKUP_EXPORTS_SURFACE: 'backup-exports',
  getG4Handle: () => mockState.handle,
  getG4Db: () => null,
  rehydratePartnerTimestamps: (x: unknown) => x,
}));

jest.mock('@/lib/backup/engine', () => {
  const actual = jest.requireActual('@/lib/backup/engine');
  return {
    ...actual,
    createDefaultBackupDeps: () => ({
      db: {
        collection: (name: string) => ({
          get: async () => {
            if (name === 'users') {
              return {
                docs: [
                  {
                    id: 'u-firestore',
                    data: () => ({ displayName: 'From Firestore' }),
                  },
                ],
              };
            }
            return { docs: [] };
          },
        }),
      },
      uploadToDrive: async ({
        fileName,
        buffer,
      }: {
        fileName: string;
        buffer: Buffer;
      }) => {
        mockUploads.push({ fileName, body: buffer.toString('utf8') });
        return { fileId: 'drive-stub' };
      },
      writeRunRecord: async (runId: string) => {
        mockDefaultRunRecords.push({ runId });
      },
      writeAudit: async () => {},
      resolveFolderId: async () => 'folder-test',
    }),
  };
});

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => false),
}));

import { GET } from '../route';

const SECRET = 'backup-primacy-secret';

function req() {
  return new NextRequest('http://localhost/api/cron/backup', {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
  saved.SUPA_SURFACES = process.env.SUPA_SURFACES;
  saved.SUPA_PRIMARY = process.env.SUPA_PRIMARY;
  process.env.SUPA_SURFACES = 'backup-exports';
  process.env.SUPA_PRIMARY = 'backup-exports';
});
afterAll(() => {
  delete process.env.CRON_SECRET;
  for (const k of ['SUPA_SURFACES', 'SUPA_PRIMARY']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  mockUploads.length = 0;
  mockDefaultRunRecords.length = 0;
  mockState.handle = null;
});

describe('cron/backup under SUPA_PRIMARY=backup-exports', () => {
  it('inverts the source of record: reads come from the handle, not Firestore', async () => {
    const fake = new FakeSupa().seed('fs_users', [
      landingRow('u-supa', { displayName: 'From Supabase' }),
    ]);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);

    const payload = mockUploads.map((u) => u.body).join('\n');
    expect(payload).toContain('From Supabase');
    expect(payload).not.toContain('From Firestore');
    // Run record follows the surface (handle), not the default writer.
    expect(mockDefaultRunRecords).toHaveLength(0);
    expect(fake.rows('fs_backup_runs').length).toBeGreaterThanOrEqual(1);
  });

  it('primacy with no handle: loud 500, no backup produced', async () => {
    mockState.handle = null;
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain('SUPA_PRIMARY=backup-exports');
    expect(mockUploads).toHaveLength(0);
  });
});
