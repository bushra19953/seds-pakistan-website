/**
 * @jest-environment node
 *
 * HOTFIX (fix/supa-read-fallback): GET /api/admin/audit-logs serves
 * the merged stream over fs_audit_logs + fs_auditLogs through the
 * adapter. In production the legacy collection's table name was
 * folded to lowercase by the migration DDL, so the adapter's
 * fs_auditLogs lookup throws PGRST205 and the route answered 500
 * ("Audit logs request failed (500)") with NO fallback, while
 * Firestore holds the complete audit history.
 *
 *  - adapter throws -> Firestore page/totals served (FAILS on the
 *    unmodified tree: 500).
 *  - adapter serves rows -> served as-is (guard).
 */

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => ({
    authenticated: true,
    user: { userId: 'admin-1', role: 'founder_patron' },
  })),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDbHolder.db,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { NextRequest } from 'next/server';
import { createFakeDb } from '@/lib/server/__tests__/fake-firestore';
import {
  setAdminAuditAdapterForTests,
  type AdminAuditAdapter,
} from '@/lib/server/admin-audit-supa';
import { GET } from '../route';

function seedFirestore() {
  const db = createFakeDb();
  db.seed('audit_logs', 'a1', {
    action: 'role_change',
    actorUid: 'admin-1',
    targetUidOrResource: 'u2',
    payload: { previousRole: 'guest', newRole: 'member' },
    timestamp: { _seconds: 1760000000, _nanoseconds: 0 },
  });
  db.seed('audit_logs', 'a2', {
    action: 'application_submitted',
    actorUid: 'u3',
    targetUidOrResource: 'u3',
    payload: { application_id: 'u3' },
    timestamp: { _seconds: 1760001000, _nanoseconds: 0 },
  });
  db.seed('auditLogs', 'l1', {
    action: 'role_change',
    changedBy: 'admin-9',
    userId: 'u7',
    oldRole: 'member',
    newRole: 'chapter_president',
    timestamp: { _seconds: 1760002000, _nanoseconds: 0 },
  });
  db.seed('users', 'u1', { name: 'One' });
  db.seed('users', 'u2', { name: 'Two' });
  db.seed('users', 'u3', { name: 'Three' });
  return db;
}

const throwingAdapter: AdminAuditAdapter = {
  listDocs: jest.fn(async () => {
    throw new Error(
      "Could not find the table 'public.fs_auditLogs' in the schema cache",
    );
  }),
  countDocs: jest.fn(async () => {
    throw new Error(
      "Could not find the table 'public.fs_auditLogs' in the schema cache",
    );
  }),
};

const workingAdapter: AdminAuditAdapter = {
  listDocs: jest.fn(async (collection: string) => {
    if (collection === 'audit_logs') {
      return [
        {
          id: 's1',
          action: 'supa_action',
          actorUid: 'supa-actor',
          targetUidOrResource: 't1',
          timestamp: '2026-10-01T00:00:00.000Z',
        },
      ];
    }
    return [];
  }),
  countDocs: jest.fn(async (collection: string) =>
    collection === 'users' ? 42 : 7,
  ),
};

function req(qs = '') {
  return new NextRequest(`http://localhost/api/admin/audit-logs${qs}`);
}

beforeEach(() => {
  process.env.SUPA_SURFACES = 'admin-audit';
  mockDbHolder.db = seedFirestore();
});

afterEach(() => {
  delete process.env.SUPA_SURFACES;
  setAdminAuditAdapterForTests(null);
  mockDbHolder.db = null;
});

describe('GET /api/admin/audit-logs — Firestore fallback (hotfix)', () => {
  it('adapter throws (fs_auditLogs missing): Firestore merged page served, not 500', async () => {
    setAdminAuditAdapterForTests(throwingAdapter);
    const res = await GET(req('?mode=page'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    const ids = body.logs.map((l: any) => l.id);
    // Contract order: timestamp desc — l1 (…002000) > a2 (…001000) > a1 (…000000)
    expect(ids).toEqual(['l1', 'a2', 'a1']);
    const legacy = body.logs.find((l: any) => l.id === 'l1');
    expect(legacy.source).toBe('auditLogs');
    expect(legacy.actorUid).toBe('admin-9');
    expect(legacy.payload).toEqual({ oldRole: 'member', newRole: 'chapter_president' });
  });

  it('adapter throws: Firestore totals served', async () => {
    setAdminAuditAdapterForTests(throwingAdapter);
    const res = await GET(req('?mode=totals'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ totalUsers: 3, totalAuditLogs: 2 });
  });

  it('adapter serves rows: Supa page served as-is, Firestore never leaked (guard)', async () => {
    setAdminAuditAdapterForTests(workingAdapter);
    const res = await GET(req('?mode=page'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.logs.map((l: any) => l.id)).toEqual(['s1']);
  });

  it('adapter serves totals: Supa totals served as-is (guard)', async () => {
    setAdminAuditAdapterForTests(workingAdapter);
    const res = await GET(req('?mode=totals'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ totalUsers: 42, totalAuditLogs: 7 });
  });
});
