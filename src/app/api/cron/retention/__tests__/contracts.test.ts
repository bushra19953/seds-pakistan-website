/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/retention.
 *
 * This route had NO tests before this suite. Pins CURRENT behaviour:
 * backup-style auth (CRON_SECRET bearer, or an authenticated caller
 * holding canManagePermissions), the RetentionDeps object the route
 * builds for runRetention, the audit_logs write that follows every
 * run, and the exact response projection ({ startedAt, classes } —
 * nothing else from the engine report reaches the response).
 *
 * All collaborators mocked; zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  allowed: false,
  db: null as any,
  report: null as any,
  runError: null as any,
  folderId: 'fixture-folder-id',
  auditAdds: [] as any[],
  runCalls: [] as any[],
  permissionCalls: [] as any[],
  uploads: [] as any[],
};

function makeDb() {
  return {
    collection: jest.fn((name: string) => {
      if (name !== 'audit_logs') throw new Error(`unexpected collection: ${name}`);
      return {
        add: jest.fn(async (data: any) => {
          state.auditAdds.push(data);
          return { id: 'audit-1' };
        }),
      };
    }),
  };
}

function defaultReport() {
  return {
    startedAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:01:00.000Z', // engine-only field: must NOT reach the response
    classes: [
      {
        key: 'rejected_applications',
        archived: 4,
        scrubbed: 4,
        deleted: 0,
        flaggedForReview: 0,
        errors: [],
        engineNote: 'must-be-stripped-from-audit',
      },
      {
        key: 'audit_logs',
        archived: 10,
        scrubbed: 0,
        deleted: 10,
        flaggedForReview: 0,
        errors: ['one row failed'],
      },
    ],
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => state.db),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => state.authResult),
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: jest.fn(async (...args: any[]) => {
    state.permissionCalls.push(args);
    return state.allowed;
  }),
}));

jest.mock('@/lib/backup/engine', () => ({
  resolveBackupFolderId: jest.fn(async () => state.folderId),
  serializeFirestoreValue: jest.fn((v: any) => v),
}));

jest.mock('@/lib/drive/client', () => ({
  uploadToVault: jest.fn(async (...args: any[]) => {
    state.uploads.push(args);
  }),
}));

jest.mock('@/lib/retention/engine', () => ({
  runRetention: jest.fn(async (deps: any) => {
    state.runCalls.push(deps);
    if (state.runError) throw state.runError;
    return state.report;
  }),
}));

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/retention', { method, headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.allowed = false;
  state.db = makeDb();
  state.report = defaultReport();
  state.runError = null;
  state.auditAdds = [];
  state.runCalls = [];
  state.permissionCalls = [];
  state.uploads = [];
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/retention — migration contract', () => {
  it('unauthenticated caller gets 401 { error: "Unauthorized" }, engine never runs', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('authenticated caller without a role gets 401', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1' } };
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(state.runCalls).toHaveLength(0);
  });

  it('authenticated caller without canManagePermissions gets 403 { error: "Forbidden" }', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1', role: 'member' } };
    state.allowed = false;
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(state.permissionCalls).toEqual([['member', 'canManagePermissions']]);
    expect(state.runCalls).toHaveLength(0);
  });

  it('db unavailable -> 500 { error: "Database not initialized" }, engine never runs', async () => {
    state.db = null;
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Database not initialized' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('cron run: response is exactly { startedAt, classes } from the report (no other report fields)', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['classes', 'startedAt']);
    expect(body.startedAt).toBe('2026-10-25T00:00:00.000Z');
    expect(body.classes).toEqual(state.report.classes);
  });

  it('cron run: delegates once with deps { db, archiveDocs: fn, now: fn returning a Date }', async () => {
    await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(state.runCalls).toHaveLength(1);
    const deps = state.runCalls[0];
    expect(deps.db).toBe(state.db);
    expect(typeof deps.archiveDocs).toBe('function');
    expect(typeof deps.now).toBe('function');
    expect(deps.now()).toBeInstanceOf(Date);
  });

  it('cron run: writes ONE audit_logs record with the exact field set and per-class projection', async () => {
    await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(state.auditAdds).toHaveLength(1);
    const audit = state.auditAdds[0];
    expect(audit.type).toBe('RETENTION_RUN');
    expect(audit.actorId).toBe('cron');
    expect(audit.targetId).toBeNull();
    expect(audit.timestamp).toBeInstanceOf(Date);
    expect(audit.data).toEqual({
      startedAt: '2026-10-25T00:00:00.000Z',
      classes: [
        { key: 'rejected_applications', archived: 4, scrubbed: 4, deleted: 0, flaggedForReview: 0, errors: [] },
        { key: 'audit_logs', archived: 10, scrubbed: 0, deleted: 10, flaggedForReview: 0, errors: ['one row failed'] },
      ],
    });
  });

  it('manual admin run: audit actorId is "admin", not "cron"', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-admin', role: 'admin' } };
    state.allowed = true;
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(200);
    expect(state.auditAdds[0].actorId).toBe('admin');
  });

  it('archiveDocs dep: uploads retention_<collection>_<date>.json to the backup folder, private, with the serialized payload', async () => {
    await GET(req({ Authorization: `Bearer ${SECRET}` }));
    const deps = state.runCalls[0];
    await deps.archiveDocs('applications', [{ id: 'app-1', data: { name: 'Fixture' } }]);
    expect(state.uploads).toHaveLength(1);
    const [filename, mime, buffer, folderId, opts] = state.uploads[0];
    expect(filename).toMatch(/^retention_applications_\d{4}-\d{2}-\d{2}\.json$/);
    expect(mime).toBe('application/json');
    expect(folderId).toBe('fixture-folder-id');
    expect(opts).toEqual({ makePublic: false });
    const payload = JSON.parse(Buffer.from(buffer).toString('utf8'));
    expect(payload.collection).toBe('applications');
    expect(payload.count).toBe(1);
    expect(payload.docs).toEqual([{ id: 'app-1', data: { name: 'Fixture' } }]);
    expect(typeof payload.exportedAt).toBe('string');
  });

  it('engine throwing an Error -> 500 { error: <message> } and NO audit record', async () => {
    state.runError = new Error('retention engine died');
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'retention engine died' });
    expect(state.auditAdds).toHaveLength(0);
  });

  it('engine throwing a non-Error -> 500 { error: "Failed to run retention" }', async () => {
    state.runError = {};
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to run retention' });
  });
});
