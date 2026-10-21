/**
 * @jest-environment node
 *
 * Suite E3b: intake window templates (Workstream E, spec 4.4).
 * Templates are shapes only: created inactive, create no window, and
 * reject invalid shapes.
 */

import { NextRequest } from 'next/server';
import { FakeDb } from '@/lib/intake-windows/__tests__/fake-firestore';

const mockGetDb = jest.fn();
const mockVerify = jest.fn();
const mockResolveRole = jest.fn();
const mockHasPermission = jest.fn();

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
}));

import { GET, POST } from '../templates/route';

let db: FakeDb;

function jsonReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  db = new FakeDb();
  mockGetDb.mockReset().mockReturnValue(db);
  mockVerify
    .mockReset()
    .mockResolvedValue({ authenticated: true, user: { userId: 'admin-uid-1' } });
  mockResolveRole.mockReset().mockResolvedValue('superadmin');
  mockHasPermission.mockReset().mockResolvedValue(true);
});

describe('POST /api/admin/intake-windows/templates', () => {
  it('creates the annual drive template INACTIVE and creates no window', async () => {
    const res = await POST(
      jsonReq('http://localhost/api/admin/intake-windows/templates', 'POST', {
        templateId: 'drive-annual-august',
        kind: 'drive',
        labelTemplate: 'Annual Intake Drive, {fy}',
        opensMonthDay: '08-01',
        durationDays: 31,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template.templateId).toBe('drive-annual-august');
    expect(body.template.active).toBe(false);

    const stored = db.docData('intake_window_templates', 'drive-annual-august');
    expect(stored).toBeDefined();
    expect(stored!.active).toBe(false);
    // No window is materialized by template creation.
    expect(db.allDocs('intake_windows')).toHaveLength(0);
    expect(
      db.allDocs('audit_logs').map((d) => d.data.action),
    ).toContain('intake_template_created');
  });

  it('forces active=false even when the body asks for active', async () => {
    const res = await POST(
      jsonReq('http://localhost/api/admin/intake-windows/templates', 'POST', {
        kind: 'drive',
        labelTemplate: 'Annual Intake Drive, {fy}',
        opensMonthDay: '08-01',
        durationDays: 31,
        active: true,
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).template.active).toBe(false);
  });

  it('rejects a bad opensMonthDay and an out-of-range durationDays', async () => {
    const badDay = await POST(
      jsonReq('http://localhost/api/admin/intake-windows/templates', 'POST', {
        kind: 'drive',
        labelTemplate: 'Annual Intake Drive, {fy}',
        opensMonthDay: '13-40',
        durationDays: 31,
      }),
    );
    expect(badDay.status).toBe(400);
    expect((await badDay.json()).field).toBe('opensMonthDay');

    const badDuration = await POST(
      jsonReq('http://localhost/api/admin/intake-windows/templates', 'POST', {
        kind: 'drive',
        labelTemplate: 'Annual Intake Drive, {fy}',
        opensMonthDay: '08-01',
        durationDays: 121,
      }),
    );
    expect(badDuration.status).toBe(400);
    expect((await badDuration.json()).field).toBe('durationDays');
  });

  it('lists created templates', async () => {
    await POST(
      jsonReq('http://localhost/api/admin/intake-windows/templates', 'POST', {
        templateId: 'drive-annual-august',
        kind: 'drive',
        labelTemplate: 'Annual Intake Drive, {fy}',
        opensMonthDay: '08-01',
        durationDays: 31,
      }),
    );
    const res = await GET(
      jsonReq('http://localhost/api/admin/intake-windows/templates', 'GET'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0].templateId).toBe('drive-annual-august');
  });
});
