/**
 * @jest-environment node
 *
 * WS10 (client-direct write elimination) — skills group pins.
 *
 *  - Static: the admin skills page and the register-capability modal
 *    no longer import a Firestore write (wrapper or SDK); their writes
 *    go through /api/skills.
 *  - Route parity for the modal payload: explicit nulls for cleared
 *    optional fields (iconKey / image_url / displayOrder) are stored
 *    and mirrored, exactly as the old client updateDoc/addDoc stored
 *    them (the pre-WS10 route dropped null keys).
 *  - The public-skills seed mirrors each seeded doc into fs_skills
 *    (public-skills population, the fs_skills writer the flip held on).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');

describe('WS10 skills static pins', () => {
  for (const rel of [
    'app/admin/skills/page.tsx',
    'app/admin/skills/components/register-capability-modal.tsx',
  ]) {
    it(`${rel} performs no client Firestore write`, () => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/firestore-wrapper/);
      expect(src).not.toMatch(/from 'firebase\/firestore'/);
      expect(src).toContain('/api/skills');
    });
  }
});

/* ------------------------------------------------------------ route fakes */
const store = new Map<string, Record<string, any>>();
const mirrors: Array<{ fn: string; id: string; data: any }> = [];

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (name: string) => ({
      add: async (data: any) => {
        const id = `doc-${store.size + 1}`;
        store.set(`${name}/${id}`, data);
        return { id };
      },
      doc: (id: string) => ({
        set: async (data: any, opts?: any) => {
          const key = `${name}/${id}`;
          store.set(key, opts?.merge ? { ...(store.get(key) || {}), ...data } : data);
        },
        get: async () => ({ exists: store.has(`${name}/${id}`), data: () => store.get(`${name}/${id}`) }),
      }),
      where: () => ({ get: async () => ({ docs: [] }) }),
      get: async () => ({ docs: [] }),
    }),
  }),
  admin: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'admin-1' }) }),
    firestore: { FieldPath: { documentId: () => '__id__' }, FieldValue: { arrayRemove: (v: any) => v } },
  },
}));

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermission: async () => true,
}));

jest.mock('@/lib/server/skills-supa', () => ({
  mirrorSkillCreate: async (id: string, data: any) => { mirrors.push({ fn: 'create', id, data }); },
  mirrorSkillUpdate: async (id: string, data: any) => { mirrors.push({ fn: 'update', id, data }); },
  mirrorSkillDelete: async () => {},
  mirrorUserSkillRevoke: async () => {},
  supaListSkillsAdmin: async () => null,
  supaSkillGrantCounts: async () => null,
}));

import { POST, PATCH } from '../route';
import { NextRequest } from 'next/server';

function req(method: string, body: any): NextRequest {
  return new NextRequest('http://localhost/api/skills', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  });
}

describe('WS10 skills route payload parity', () => {
  beforeEach(() => {
    store.clear(); mirrors.length = 0;
    store.set('roles/admin-1', { role: 'superadmin' });
  });

  it('POST stores explicit nulls from the modal payload and mirrors them', async () => {
    const res = await POST(req('POST', {
      name: 'Orbital Mechanics', category: 'Aerospace', status: 'active',
      isFeatured: false, iconKey: null, image_url: null, displayOrder: null,
    }));
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const saved = store.get(`skills/${id}`);
    expect(saved).toMatchObject({ name: 'Orbital Mechanics', iconKey: null, image_url: null, displayOrder: null });
    expect(mirrors).toEqual([{ fn: 'create', id, data: saved }]);
  });

  it('PATCH stores explicit nulls (field clears) and mirrors them', async () => {
    store.set('skills/s1', { name: 'X', iconKey: 'old', displayOrder: 3 });
    const res = await PATCH(req('PATCH', { id: 's1', status: 'archived', iconKey: null, displayOrder: null }));
    expect(res.status).toBe(200);
    expect(store.get('skills/s1')).toMatchObject({ status: 'archived', iconKey: null, displayOrder: null });
    expect(mirrors[0].fn).toBe('update');
    expect(mirrors[0].data).toMatchObject({ iconKey: null, displayOrder: null });
  });
});

describe('WS10 public-skills seed population', () => {
  it('ensureSkillsSeeded mirrors every seeded doc', async () => {
    const src = readFileSync(join(root, 'app/api/public/skills/route.ts'), 'utf8');
    expect(src).toContain('mirrorSkillCreate(skill.slug, data)');
  });
});
