/**
 * @jest-environment node
 *
 * Flag-ON behaviour for GET /api/cron/retention (Supabase migration,
 * cluster cron G3): the route and the SHARED retention engine run
 * against the shared Firestore-shaped db handle over the adapter
 * (FakeSupa underneath); the Drive upload is mocked (never called for
 * real). Pins the F-G2 flow end-to-end through the handle:
 *  - a rejected application older than 24 months (ISO-string
 *    createdAt, the adapter's storage shape) is ARCHIVED FIRST — the
 *    vault payload carries the doc with PII intact, serialized
 *    identically to the Firestore path (see the serializer comparison
 *    test) — and only then scrubbed in place (PII fields nulled,
 *    retentionArchivedAt/retentionScrubbedAt stamped);
 *  - a recent rejected application is untouched;
 *  - the RETENTION_RUN audit record lands in fs_audit_logs via the
 *    handle's add();
 *  - governance classes stay flag-for-review only (never modified).
 * Zero live reads; dummy fixture secret.
 */
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter } from '@/lib/supa';
import { FakeSupa, landingRow } from '@/lib/supa/__tests__/fake-supa';
import { createSupaDbHandle } from '@/lib/server/supa-db-handle';

const mockState = { handle: null as unknown };
const mockUploads: Array<{ name: string; body: string }> = [];

jest.mock('@/lib/server/cron/g3-data', () => ({
  G3_SURFACE: 'cron-g3',
  getG3Db: () => mockState.handle,
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({ authenticated: false })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async () => false),
}));

jest.mock('@/lib/drive/client', () => ({
  uploadToVault: jest.fn(
    async (name: string, _mime: string, buffer: Buffer) => {
      mockUploads.push({ name, body: buffer.toString('utf8') });
      return { id: 'drive-file-1' };
    },
  ),
}));

jest.mock('@/lib/backup/engine', () => {
  const actual = jest.requireActual('@/lib/backup/engine');
  return {
    ...actual,
    resolveBackupFolderId: jest.fn(async () => 'folder-test'),
  };
});

import { GET } from '../route';

const SECRET = 'g3-test-secret';
const DAY = 24 * 60 * 60 * 1000;

function req() {
  return new NextRequest('http://localhost/api/cron/retention', {
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
  mockUploads.length = 0;
});

describe('retention flag ON (Supabase handle)', () => {
  it('archives then scrubs an old rejected application; audit run record lands via add()', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 800 * DAY).toISOString();
    const fake = new FakeSupa()
      .seed('fs_applications', [
        landingRow('app-old', {
          status: 'rejected',
          createdAt: oldIso,
          fullName: 'Test Person',
          email: 'person@example.test',
          phoneNumber: '0300-0000000',
          cnic: '00000-0000000-0',
          statementOfPurpose: 'I want to join.',
          dateOfBirth: '2004-01-01',
        }),
        landingRow('app-recent', {
          status: 'rejected',
          createdAt: new Date(now - 30 * DAY).toISOString(),
          fullName: 'Recent Person',
          email: 'recent@example.test',
        }),
        landingRow('app-approved', {
          status: 'approved',
          createdAt: oldIso,
          fullName: 'Approved Person',
        }),
      ])
      .seed('fs_audit_logs', [])
      .seed('fs_warnings', [])
      .seed('fs_governance_records', [])
      .seed('fs_consents', [])
      .seed('fs_decisions', [])
      .seed('fs_retention_policies', []);
    mockState.handle = createSupaDbHandle(
      createSupaAdapter(fake as unknown as SupabaseClient),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    const rejected = body.classes.find(
      (c: { key: string }) => c.key === 'rejected_applications',
    );
    expect(rejected.scanned).toBe(2);
    expect(rejected.archived).toBe(1);
    expect(rejected.scrubbed).toBe(1);
    expect(rejected.deleted).toBe(0);
    expect(rejected.errors).toEqual([]);

    // Archive happened, with PII intact, before the scrub.
    expect(mockUploads).toHaveLength(1);
    expect(mockUploads[0].name).toContain('retention_applications_');
    const payload = JSON.parse(mockUploads[0].body);
    expect(payload.collection).toBe('applications');
    expect(payload.count).toBe(1);
    expect(payload.docs[0].id).toBe('app-old');
    expect(payload.docs[0].data.fullName).toBe('Test Person');
    expect(payload.docs[0].data.createdAt).toBe(oldIso);

    const apps = new Map(fake.rows('fs_applications').map((r) => [r.id, r.data]));
    const old = apps.get('app-old')!;
    expect(typeof old.retentionArchivedAt).toBe('string');
    expect(typeof old.retentionScrubbedAt).toBe('string');
    expect(old.fullName).toBeNull();
    expect(old.email).toBeNull();
    expect(old.cnic).toBeNull();
    expect(old.statementOfPurpose).toBeNull();
    expect(old.status).toBe('rejected');

    const recent = apps.get('app-recent')!;
    expect(recent.fullName).toBe('Recent Person');
    expect(recent.retentionArchivedAt).toBeUndefined();

    const audit = fake.rows('fs_audit_logs');
    expect(audit).toHaveLength(1);
    expect(audit[0].data.type).toBe('RETENTION_RUN');
    expect(audit[0].data.actorId).toBe('cron');
  });
});
