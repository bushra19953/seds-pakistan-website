/**
 * @jest-environment node
 *
 * Suite E3: intake window admin routes (Workstream E, spec 5.1/5.2).
 * Covers the gate, create validation + PKT wall-time conversion, id
 * derivation, overlap warnings, default clearing, audit + mirror side
 * effects, cancel/uncancel transitions, and Gate E-2 on the
 * enforcement toggle.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';
import { FakeDb } from '@/lib/intake-windows/__tests__/fake-firestore';

const mockGetDb = jest.fn();
const mockVerify = jest.fn();
const mockResolveRole = jest.fn();
const mockHasPermission = jest.fn();
const mockHasPermissionForUser = jest.fn();

jest.mock('@/lib/server/firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin/firestore');
  return {
    getDb: () => mockGetDb(),
    admin: {
      firestore: { Timestamp: actual.Timestamp, FieldValue: actual.FieldValue },
    },
  };
});
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (...args: unknown[]) => mockVerify(...args),
}));
jest.mock('@/lib/server/permissions', () => ({
  resolveUserRole: (...args: unknown[]) => mockResolveRole(...args),
  hasServerPermission: (...args: unknown[]) => mockHasPermission(...args),
  hasServerPermissionForUser: (...args: unknown[]) =>
    mockHasPermissionForUser(...args),
}));

import { GET as listGET, POST as createPOST } from '../route';
import { GET as itemGET, PATCH as itemPATCH } from '../[windowId]/route';
import { GET as configGET, PATCH as configPATCH } from '../config/route';

const NOW_MS = Date.parse('2026-10-21T10:00:00.000Z');
const ADMIN_UID = 'admin-uid-1';
let db: FakeDb;
let nowSpy: jest.SpyInstance;

function jsonReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(windowId: string) {
  return { params: Promise.resolve({ windowId }) };
}

function seedWindow(id: string, overrides: Record<string, unknown> = {}) {
  db.seed('intake_windows', id, {
    windowId: id,
    label: 'Existing Window',
    kind: 'induction',
    opensAt: Timestamp.fromMillis(Date.parse('2026-10-01T00:00:00.000Z')),
    closesAt: Timestamp.fromMillis(Date.parse('2026-10-25T00:00:00.000Z')),
    timezone: 'Asia/Karachi',
    isDefault: false,
    storedStatus: null,
    source: 'manual',
    templateId: null,
    createdBy: ADMIN_UID,
    createdAt: Timestamp.fromMillis(Date.parse('2026-09-01T00:00:00.000Z')),
    updatedAt: Timestamp.fromMillis(Date.parse('2026-09-01T00:00:00.000Z')),
    ...overrides,
  });
}

function auditActions(): string[] {
  return db
    .allDocs('audit_logs')
    .map((d) => String(d.data.action))
    .sort();
}

beforeEach(() => {
  db = new FakeDb();
  mockGetDb.mockReset().mockReturnValue(db);
  mockVerify
    .mockReset()
    .mockResolvedValue({ authenticated: true, user: { userId: ADMIN_UID } });
  mockResolveRole.mockReset().mockResolvedValue('superadmin');
  mockHasPermission.mockReset().mockResolvedValue(true);
  mockHasPermissionForUser.mockReset().mockResolvedValue(true);
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('gate', () => {
  it('returns 401 when unauthenticated', async () => {
    mockVerify.mockResolvedValue({ authenticated: false });
    const res = await listGET(jsonReq('http://localhost/api/admin/intake-windows', 'GET'));
    expect(res.status).toBe(401);
  });

  it('returns 403 without canManageApplications', async () => {
    mockHasPermission.mockResolvedValue(false);
    mockHasPermissionForUser.mockResolvedValue(false);
    const res = await listGET(jsonReq('http://localhost/api/admin/intake-windows', 'GET'));
    expect(res.status).toBe(403);
  });

  it('D6 parity: admits a plain-member holder whose custom grant supplies canManageApplications', async () => {
    // Primary-only answer denies (member holds no such grant); the
    // holder-scoped answer admits via the custom grant in
    // additionalRoles (canonical fixture shape, mocked at the
    // permissions boundary the helper now calls).
    mockResolveRole.mockResolvedValue('member');
    mockHasPermission.mockResolvedValue(false);
    mockHasPermissionForUser.mockResolvedValue(true);
    const res = await listGET(jsonReq('http://localhost/api/admin/intake-windows', 'GET'));
    expect(res.status).toBe(200);
    expect(mockHasPermissionForUser).toHaveBeenCalledWith(
      expect.anything(),
      ADMIN_UID,
      'canManageApplications',
    );
  });

  it('D6 parity: a holder whose grant is expired / absent is denied unchanged', async () => {
    mockResolveRole.mockResolvedValue('member');
    mockHasPermission.mockResolvedValue(false);
    mockHasPermissionForUser.mockResolvedValue(false);
    const res = await listGET(jsonReq('http://localhost/api/admin/intake-windows', 'GET'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });
});

describe('POST /api/admin/intake-windows', () => {
  const validBody = {
    label: 'Spring Induction',
    kind: 'induction',
    opensAt: '2026-10-01T09:00',
    closesAt: '2026-10-22T23:59',
  };

  it('creates a window: id derived, PKT wall time converted, audit + mirror written', async () => {
    const res = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', validBody),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.window.windowId).toBe('induction-2026-10-spring-induction');
    expect(body.warnings).toEqual([]);

    const stored = db.docData(
      'intake_windows',
      'induction-2026-10-spring-induction',
    );
    expect(stored).toBeDefined();
    // 2026-10-22T23:59 PKT == 2026-10-22T18:59:00.000Z
    expect((stored!.closesAt as Timestamp).toMillis()).toBe(
      Date.parse('2026-10-22T18:59:00.000Z'),
    );
    // 2026-10-01T09:00 PKT == 2026-10-01T04:00:00.000Z
    expect((stored!.opensAt as Timestamp).toMillis()).toBe(
      Date.parse('2026-10-01T04:00:00.000Z'),
    );
    expect(auditActions()).toContain('intake_window_created');

    const mirror = db.docData('intake_config', 'current');
    expect(mirror).toBeDefined();
    expect(mirror!.currentInductionWindowId).toBe(
      'induction-2026-10-spring-induction',
    );
    expect(mirror!.enforcementEnabled).toBe(false);
  });

  it('rejects closesAt <= opensAt naming the field', async () => {
    const res = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', {
        ...validBody,
        closesAt: '2026-10-01T09:00',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.field).toBe('closesAt');
  });

  it('rejects an offset-carrying closesAt (wall time only)', async () => {
    const res = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', {
        ...validBody,
        closesAt: '2026-10-22T23:59:59+05:00',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('closesAt');
  });

  it('returns 201 with an overlap warning for an intersecting same-kind window', async () => {
    seedWindow('induction-2026-10-existing-window');
    const res = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', validBody),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('overlap_same_kind');
    expect(body.warnings[0].windowIds).toContain(
      'induction-2026-10-existing-window',
    );
  });

  it('clears a sibling default in the same write', async () => {
    seedWindow('induction-2026-10-existing-window', { isDefault: true });
    const res = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', {
        ...validBody,
        isDefault: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(
      db.docData('intake_windows', 'induction-2026-10-existing-window')!
        .isDefault,
    ).toBe(false);
    expect(
      db.docData('intake_windows', 'induction-2026-10-spring-induction')!
        .isDefault,
    ).toBe(true);
    expect(auditActions()).toContain('intake_window_default_set');
  });

  it('returns 409 on a duplicate derived id', async () => {
    const first = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', validBody),
    );
    expect(first.status).toBe(201);
    const second = await createPOST(
      jsonReq('http://localhost/api/admin/intake-windows', 'POST', validBody),
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('window_id_conflict');
  });
});

describe('PATCH /api/admin/intake-windows/[windowId]', () => {
  const ID = 'induction-2026-10-existing-window';

  it('edits closesAt and audits before/after instants', async () => {
    seedWindow(ID);
    const res = await itemPATCH(
      jsonReq(`http://localhost/api/admin/intake-windows/${ID}`, 'PATCH', {
        closesAt: '2026-10-30T23:59',
      }),
      params(ID),
    );
    expect(res.status).toBe(200);
    const stored = db.docData('intake_windows', ID)!;
    expect((stored.closesAt as Timestamp).toMillis()).toBe(
      Date.parse('2026-10-30T18:59:00.000Z'),
    );
    const audit = db
      .allDocs('audit_logs')
      .find((d) => d.data.action === 'intake_window_updated');
    expect(audit).toBeDefined();
    const payload = audit!.data.payload as {
      before: { closesAt: string };
      after: { closesAt: string };
    };
    expect(payload.before.closesAt).toBe('2026-10-25T00:00:00.000Z');
    expect(payload.after.closesAt).toBe('2026-10-30T18:59:00.000Z');
  });

  it('requires a cancel reason of at least 3 chars', async () => {
    seedWindow(ID);
    const res = await itemPATCH(
      jsonReq(`http://localhost/api/admin/intake-windows/${ID}`, 'PATCH', {
        storedStatus: 'cancelled',
        cancelReason: 'no',
      }),
      params(ID),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('cancelReason');
  });

  it('cancels with a reason, then rejects further edits with 409', async () => {
    seedWindow(ID);
    const cancel = await itemPATCH(
      jsonReq(`http://localhost/api/admin/intake-windows/${ID}`, 'PATCH', {
        storedStatus: 'cancelled',
        cancelReason: 'Created in error',
      }),
      params(ID),
    );
    expect(cancel.status).toBe(200);
    expect(db.docData('intake_windows', ID)!.storedStatus).toBe('cancelled');
    expect(auditActions()).toContain('intake_window_cancelled');

    const edit = await itemPATCH(
      jsonReq(`http://localhost/api/admin/intake-windows/${ID}`, 'PATCH', {
        label: 'Renamed Window',
      }),
      params(ID),
    );
    expect(edit.status).toBe(409);
    expect((await edit.json()).error).toBe('window_cancelled');
  });

  it('uncancel is superadmin-only', async () => {
    seedWindow(ID, {
      storedStatus: 'cancelled',
      cancelReason: 'Created in error',
    });
    mockResolveRole.mockResolvedValue('president_national');
    const denied = await itemPATCH(
      jsonReq(`http://localhost/api/admin/intake-windows/${ID}`, 'PATCH', {
        storedStatus: null,
      }),
      params(ID),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe('superadmin_required');

    mockResolveRole.mockResolvedValue('superadmin');
    const allowed = await itemPATCH(
      jsonReq(`http://localhost/api/admin/intake-windows/${ID}`, 'PATCH', {
        storedStatus: null,
      }),
      params(ID),
    );
    expect(allowed.status).toBe(200);
    expect(db.docData('intake_windows', ID)!.storedStatus).toBeNull();
  });

  it('returns 404 for an unknown window', async () => {
    const res = await itemGET(
      jsonReq('http://localhost/api/admin/intake-windows/nope', 'GET'),
      params('nope'),
    );
    expect(res.status).toBe(404);
  });
});

describe('config route + Gate E-2', () => {
  function seedHealthyMirror() {
    seedWindow('induction-2026-10-existing-window');
    const updatedAt = Timestamp.fromMillis(
      Date.parse('2026-09-01T00:00:00.000Z'),
    );
    db.seed('intake_config', 'current', {
      currentInductionWindowId: 'induction-2026-10-existing-window',
      currentInductionOpensAt: Timestamp.fromMillis(
        Date.parse('2026-10-01T00:00:00.000Z'),
      ),
      currentInductionClosesAt: Timestamp.fromMillis(
        Date.parse('2026-10-25T00:00:00.000Z'),
      ),
      currentInductionState: 'open',
      enforcementEnabled: false,
      mirrorUpdatedAt: updatedAt,
      mirrorUpdatedBy: ADMIN_UID,
      mirrorSourceUpdatedAt: updatedAt,
      mirrorVersion: 3,
    });
  }

  it('reports a healthy mirror on GET', async () => {
    seedHealthyMirror();
    const res = await configGET(
      jsonReq('http://localhost/api/admin/intake-windows/config', 'GET'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mirrorHealthy).toBe(true);
    expect(body.config.enforcementEnabled).toBe(false);
    expect(body.config.mirrorVersion).toBe(3);
  });

  it('refuses to arm enforcement with no mirror (409 mirror_unhealthy)', async () => {
    seedWindow('induction-2026-10-existing-window');
    const res = await configPATCH(
      jsonReq('http://localhost/api/admin/intake-windows/config', 'PATCH', {
        enforcementEnabled: true,
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('mirror_unhealthy');
  });

  it('arms enforcement with a healthy mirror and audits the toggle', async () => {
    seedHealthyMirror();
    const res = await configPATCH(
      jsonReq('http://localhost/api/admin/intake-windows/config', 'PATCH', {
        enforcementEnabled: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(db.docData('intake_config', 'current')!.enforcementEnabled).toBe(
      true,
    );
    expect(auditActions()).toContain('intake_enforcement_toggled');
  });

  it('always allows turning enforcement OFF, even with no mirror', async () => {
    const res = await configPATCH(
      jsonReq('http://localhost/api/admin/intake-windows/config', 'PATCH', {
        enforcementEnabled: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(db.docData('intake_config', 'current')!.enforcementEnabled).toBe(
      false,
    );
  });
});
