/**
 * @jest-environment node
 *
 * Supabase-migration CONTRACT tests for GET/POST /api/cron/backup —
 * companion to the existing route.test.ts in this folder (which pins
 * the bounded-read wrapper and the no-auth 401). This file pins the
 * rest of the route surface: the canManagePermissions manual arm
 * (401/403 split), the exact response projection, the delegation
 * shape handed to runBackup, and the 500 error paths.
 *
 * The backup engine is mocked; zero live reads.
 */

import { NextRequest } from 'next/server';

const state = {
  authResult: { authenticated: false } as any,
  allowed: false,
  result: {
    runId: 'backup_run_fixture',
    status: 'success',
    totals: { collections: 7, documents: 1234, bytes: 999 },
  } as any,
  runError: null as any,
  depsError: null as any,
  runCalls: [] as any[],
  permissionCalls: [] as any[],
  rawDb: { __sentinel: 'raw-backup-db' },
};

jest.mock('@/lib/backup/engine', () => ({
  createDefaultBackupDeps: jest.fn(() => {
    if (state.depsError) throw state.depsError;
    return {
      db: state.rawDb,
      uploadToDrive: jest.fn(async () => ({ fileId: 'drive-1' })),
      writeRunRecord: jest.fn(async () => undefined),
      writeAudit: jest.fn(async () => undefined),
    };
  }),
  runBackup: jest.fn(async (deps: any) => {
    state.runCalls.push(deps);
    if (state.runError) throw state.runError;
    return state.result;
  }),
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

import { GET, POST } from '../route';

const SECRET = 'test-cron-secret';

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/cron/backup', { method, headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  state.authResult = { authenticated: false };
  state.allowed = false;
  state.runError = null;
  state.depsError = null;
  state.runCalls = [];
  state.permissionCalls = [];
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('/api/cron/backup — auth + response contract', () => {
  it('cron bearer: response is exactly { runId, status, collections, documents } projected from the engine result', async () => {
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runId: 'backup_run_fixture',
      status: 'success',
      collections: 7,
      documents: 1234,
    });
  });

  it('cron bearer: runBackup receives the default deps with db replaced by the bounded-read wrapper', async () => {
    await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(state.runCalls).toHaveLength(1);
    const deps = state.runCalls[0];
    expect(deps.db).not.toBe(state.rawDb);
    expect(typeof deps.db.collection).toBe('function');
    expect(typeof deps.uploadToDrive).toBe('function');
    expect(typeof deps.writeRunRecord).toBe('function');
    expect(typeof deps.writeAudit).toBe('function');
  });

  it('manual arm: authenticated caller WITH canManagePermissions runs the backup', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-admin', role: 'admin' } };
    state.allowed = true;
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(200);
    expect(state.permissionCalls).toEqual([['admin', 'canManagePermissions']]);
    expect(state.runCalls).toHaveLength(1);
  });

  it('manual arm: authenticated caller WITHOUT canManagePermissions gets 403 { error: "Forbidden" }', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1', role: 'member' } };
    state.allowed = false;
    const res = await POST(req({}, 'POST'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(state.runCalls).toHaveLength(0);
  });

  it('manual arm: authenticated caller with NO role gets 401 (role is checked before permissions)', async () => {
    state.authResult = { authenticated: true, user: { userId: 'u-1' } };
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.permissionCalls).toHaveLength(0);
    expect(state.runCalls).toHaveLength(0);
  });

  it('engine failure -> 500 { error: <message> }', async () => {
    state.runError = new Error('drive upload failed');
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'drive upload failed' });
  });

  it('deps construction throwing a non-Error -> 500 { error: "Failed to run backup" }', async () => {
    state.depsError = {};
    const res = await GET(req({ Authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to run backup' });
  });
});
