/**
 * @jest-environment node
 *
 * POST /api/admin/site-settings/mirror: admin-gated, mirrors the
 * siteWide payload via settings-mirror, and a mirror failure still
 * returns 200 { mirrored: false } (invisible to the component).
 */
let mockAuth: any;
let mockAllowed = true;
const mockMirror = jest.fn(async () => true);
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => ({}),
  ensureAdminInitialized: () => true,
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => mockAuth),
}));
jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => mockAllowed),
}));
jest.mock('@/lib/server/settings-mirror', () => ({
  mirrorSettingsDoc: (...args: any[]) => (mockMirror as any)(...args),
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/admin/site-settings/mirror', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const PAYLOAD = { studentsEngaged: 42, siteEnabled: true, updatedBy: 'admin-1' };

beforeEach(() => {
  mockMirror.mockReset();
  mockMirror.mockResolvedValue(true);
  mockAllowed = true;
  mockAuth = { authenticated: true, user: { userId: 'admin-1' } };
});

describe('POST /api/admin/site-settings/mirror', () => {
  it('rejects unauthenticated callers', async () => {
    mockAuth = { authenticated: false, user: null };
    const res = await POST(req({ doc: 'siteWide', payload: PAYLOAD }));
    expect(res.status).toBe(401);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('forbids callers without canManageUsers', async () => {
    mockAllowed = false;
    const res = await POST(req({ doc: 'siteWide', payload: PAYLOAD }));
    expect(res.status).toBe(403);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('mirrors settings/siteWide and reports mirrored:true', async () => {
    const res = await POST(req({ doc: 'siteWide', payload: PAYLOAD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, mirrored: true });
    expect(mockMirror).toHaveBeenCalledWith('settings', 'siteWide', PAYLOAD);
  });

  it('mirror failure still returns 200 with mirrored:false', async () => {
    mockMirror.mockResolvedValue(false);
    const res = await POST(req({ doc: 'siteWide', payload: PAYLOAD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, mirrored: false });
  });

  it('rejects a doc other than siteWide', async () => {
    const res = await POST(req({ doc: 'discipline', payload: PAYLOAD }));
    expect(res.status).toBe(400);
    expect(mockMirror).not.toHaveBeenCalled();
  });
});
