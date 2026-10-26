/**
 * @jest-environment node
 *
 * WS10 — settings family pins.
 *  - Static: the four settings client files perform no client
 *    Firestore write and no client audit write.
 *  - POST /api/admin/site-settings/write: siteWide set/update with
 *    stamped updatedAt + settings mirror; certificate set-merge +
 *    audit with auditWritten reporting.
 *  - PUT warning-config: set-merge + stamp, Firestore-only.
 *  - POST induction-form: replace set + audit entry.
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../../..');

describe('WS10 settings static pins', () => {
  for (const rel of [
    'components/admin/site-settings-management.tsx',
    'app/admin/store/components/certificate-settings.tsx',
    'components/admin/discipline/discipline-settings-panel.tsx',
    'components/admin/applications/induction-form-editor.tsx',
  ]) {
    it(`${rel} performs no client Firestore write`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
      expect(src).not.toMatch(/from '@\/lib\/audit-logging'|logAuditEntry\(/);
    });
  }
});

/* ------------------------------------------------------------ route fakes */
const sets: Array<{ path: string; data: any; opts?: any }> = [];
const updates: Array<{ path: string; data: any }> = [];
const auditAdds: any[] = [];
const settingsMirrors: Array<{ col: string; id: string; data: any }> = [];
let auditFails = false;

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        set: async (data: any, opts?: any) => { sets.push({ path: `${name}/${id}`, data, opts }); },
        update: async (data: any) => { updates.push({ path: `${name}/${id}`, data }); },
      }),
      add: async (data: any) => {
        if (auditFails) throw new Error('audit down');
        auditAdds.push(data);
        return { id: 'a1' };
      },
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: async () => ({ authenticated: true, user: { userId: 'admin-1' } }),
}));
jest.mock('@/lib/server/permissions', () => ({ hasServerPermissionForUser: async () => true }));
jest.mock('@/lib/server/settings-mirror', () => ({
  mirrorSettingsDoc: async (col: string, id: string, data: any) => {
    settingsMirrors.push({ col, id, data });
    return true;
  },
}));

import { POST as siteSettingsPOST } from '../write/route';
import { PUT as warningConfigPUT } from '../../discipline-settings/warning-config/route';
import { POST as inductionFormPOST } from '../../applications/induction-form/route';
import { NextRequest } from 'next/server';

function req(url: string, body: any, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 settings routes', () => {
  beforeEach(() => {
    sets.length = 0; updates.length = 0; auditAdds.length = 0;
    settingsMirrors.length = 0; auditFails = false;
  });

  it('siteWide update: stamped + mirrored', async () => {
    const res = await siteSettingsPOST(req('http://localhost/api/admin/site-settings/write', {
      op: 'update', payload: { heroTitle: 'X' },
    }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ path: 'settings/siteWide', data: { heroTitle: 'X', updatedAt: '__ST__' } }]);
    expect(settingsMirrors[0]).toMatchObject({ col: 'settings', id: 'siteWide' });
    expect(typeof settingsMirrors[0].data.updatedAt).toBe('string');
  });

  it('certificate: set-merge + audit, auditWritten true; audit failure reported, not hidden', async () => {
    let res = await siteSettingsPOST(req('http://localhost/api/admin/site-settings/write', {
      op: 'certificate', payload: { price: 5 },
      audit: { before: { price: 4 }, after: { price: 5 }, changedFields: ['price'] },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).auditWritten).toBe(true);
    expect(sets).toEqual([{ path: 'settings/certificate_product', data: { price: 5 }, opts: { merge: true } }]);
    expect(auditAdds[0]).toMatchObject({ action: 'store_settings_updated', targetUidOrResource: 'settings/certificate_product' });

    auditFails = true;
    res = await siteSettingsPOST(req('http://localhost/api/admin/site-settings/write', {
      op: 'certificate', payload: { price: 6 },
      audit: { before: {}, after: {}, changedFields: [] },
    }));
    expect((await res.json()).auditWritten).toBe(false);
  });

  it('warning-config: set-merge warningConfig/global with stamp', async () => {
    const res = await warningConfigPUT(req('http://localhost/api/admin/discipline-settings/warning-config', {
      form: { threshold: 3 },
    }, 'PUT'));
    expect(res.status).toBe(200);
    expect(sets).toEqual([{
      path: 'warningConfig/global',
      data: { threshold: 3, updatedAt: '__ST__' },
      opts: { merge: true },
    }]);
  });

  it('induction-form: replace set (no merge) + audit with fieldCount', async () => {
    const res = await inductionFormPOST(req('http://localhost/api/admin/applications/induction-form', {
      fields: [{ id: 'a' }, { id: 'b' }],
    }));
    expect(res.status).toBe(200);
    expect(sets).toEqual([{
      path: 'settings/induction_form',
      data: { fields: [{ id: 'a' }, { id: 'b' }], updatedAt: '__ST__', updatedBy: 'admin-1' },
      opts: undefined,
    }]);
    expect(auditAdds[0]).toMatchObject({ action: 'induction_form_updated', payload: { fieldCount: 2 } });
  });
});
