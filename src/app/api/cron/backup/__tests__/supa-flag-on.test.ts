/**
 * @jest-environment node
 *
 * C-G4-1 pin for GET /api/cron/backup (Supabase migration, cluster S
 * group G4): the source-of-record inversion rule. With the
 * 'backup-exports' flag ON and a handle present:
 *  - collection READS still come from Firestore (here the engine
 *    factory's fake Firestore db) — a mirror doc seeded in FakeSupa
 *    must NOT appear in the uploaded backup payload;
 *  - the backup_runs RUN RECORD (bookkeeping, not backup content)
 *    follows the surface and lands in fs_backup_runs through the
 *    handle; the engine's default Firestore record writer is NOT used.
 * With the flag OFF, the default writer is used and reads are
 * unchanged. The REAL runBackup engine runs in both cases; only the
 * deps factory is stubbed (Firestore fake + capturing Drive stub).
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockReads: string[] = [];
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
            mockReads.push(name);
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

const SECRET = 'g4-test-secret';

function req() {
  return new NextRequest('http://localhost/api/cron/backup', {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

beforeAll(() => {
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});
beforeEach(() => {
  mockReads.length = 0;
  mockUploads.length = 0;
  mockDefaultRunRecords.length = 0;
  mockState.handle = null;
});

describe('cron/backup source-of-record rule (C-G4-1)', () => {
  it('flag ON: reads stay on Firestore; the run record follows the surface into fs_backup_runs', async () => {
    const fake = new FakeSupa()
      .seed('fs_users', [
        landingRow('u-mirror', { displayName: 'MIRROR DECOY' }),
      ])
      .seed('fs_backup_runs', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.documents).toBe(1);

    // Reads were served by the Firestore fake, not the mirror.
    expect(mockReads).toContain('users');
    const usersUpload = mockUploads.find((u) =>
      u.fileName.includes('users'),
    );
    expect(usersUpload).toBeDefined();
    expect(usersUpload!.body).toContain('From Firestore');
    expect(usersUpload!.body).not.toContain('MIRROR DECOY');

    // Run record landed in the mirror via the handle; the default
    // Firestore writer was bypassed.
    const runs = fake.rows('fs_backup_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(body.runId);
    expect(mockDefaultRunRecords).toHaveLength(0);
  });

  it('flag OFF: default Firestore run-record writer is used; reads unchanged', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toBe(1);
    expect(mockReads).toContain('users');
    expect(mockDefaultRunRecords).toHaveLength(1);
    expect(mockDefaultRunRecords[0].runId).toBe(body.runId);
  });
});
