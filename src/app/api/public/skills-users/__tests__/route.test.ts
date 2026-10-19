/**
 * @jest-environment node
 *
 * Tests for GET /api/public/skills-users.
 *
 * (a) Returns users for a given skillId via an array-contains query,
 *     projecting only public fields. Email, phone and other PII are
 *     never leaked.
 * (b) A missing skillId returns { items: [] }, not an error.
 * (c) An empty result returns { items: [] }, not an error.
 * (d) Firestore init failures return 500.
 */

const mockState = {
  dbReady: true,
  getError: null as unknown,
  captured: [] as Array<{ field: string; op: string; value: unknown }>,
  users: [] as Array<Record<string, any>>,
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() =>
    mockState.dbReady
      ? {
          collection: (_name: string) => ({
            where: (field: string, op: string, value: unknown) => ({
              get: async () => {
                if (mockState.getError) throw mockState.getError;
                mockState.captured.push({ field, op, value });
                return {
                  docs: mockState.users
                    .filter((u) => Array.isArray(u.skillIds) && u.skillIds.includes(value))
                    .map((u) => ({
                      id: u.id,
                      data: () => u,
                    })),
                };
              },
            }),
          }),
        }
      : null,
  ),
}));

import { GET } from '@/app/api/public/skills-users/route';
import { NextRequest } from 'next/server';

const DEFAULT_USERS: Array<Record<string, any>> = [
  {
    id: 'u1',
    displayName: 'Member One',
    photoURL: 'https://example.com/u1.png',
    chapterId: 'seds-ist-chapter',
    skillIds: ['rocketry', 'avionics'],
    email: 'memberone@example.com',
    phone: '+92-300-0000001',
  },
  {
    id: 'u2',
    displayName: 'Member Two',
    photoURL: null,
    chapterId: 'seds-ist-chapter',
    skillIds: ['avionics'],
    email: 'membertwo@example.com',
    phone: '+92-300-0000002',
  },
  {
    id: 'u3',
    skillIds: ['other-skill'],
  },
];

function getRequest(path: string) {
  return new NextRequest(path);
}

beforeEach(() => {
  mockState.dbReady = true;
  mockState.getError = null;
  mockState.captured = [];
  mockState.users = DEFAULT_USERS.map((u) => ({ ...u }));
});

describe('GET /api/public/skills-users', () => {
  it('returns users for a skillId via an array-contains query', async () => {
    const res = await GET(
      getRequest('http://localhost/api/public/skills-users?skillId=avionics'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((u: any) => u.id).sort()).toEqual(['u1', 'u2']);
    expect(mockState.captured).toEqual([
      { field: 'skillIds', op: 'array-contains', value: 'avionics' },
    ]);
  });

  it('projects only public fields and never leaks email or phone', async () => {
    const res = await GET(
      getRequest('http://localhost/api/public/skills-users?skillId=rocketry'),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    const user = body.items[0];
    expect(user).toEqual({
      id: 'u1',
      displayName: 'Member One',
      photoURL: 'https://example.com/u1.png',
      chapterId: 'seds-ist-chapter',
      skillIds: ['rocketry', 'avionics'],
    });
    expect(user).not.toHaveProperty('email');
    expect(user).not.toHaveProperty('phone');
    expect(JSON.stringify(body)).not.toContain('memberone@example.com');
    expect(JSON.stringify(body)).not.toContain('+92-300-0000001');
  });

  it('falls back to defaults for missing display fields', async () => {
    const res = await GET(
      getRequest('http://localhost/api/public/skills-users?skillId=other-skill'),
    );
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: 'u3',
      displayName: 'SEDS Member',
      photoURL: null,
      chapterId: null,
      skillIds: ['other-skill'],
    });
  });

  it('returns an empty items array when skillId is missing', async () => {
    const res = await GET(getRequest('http://localhost/api/public/skills-users'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(mockState.captured).toHaveLength(0);
  });

  it('returns an empty items array when no user has the skill', async () => {
    const res = await GET(
      getRequest('http://localhost/api/public/skills-users?skillId=no-such-skill'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('returns 500 when Firestore is not initialized', async () => {
    mockState.dbReady = false;
    const res = await GET(
      getRequest('http://localhost/api/public/skills-users?skillId=avionics'),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Firestore not initialized/);
  });

  it('returns 500 when the Firestore read throws', async () => {
    mockState.getError = new Error('firestore down');
    const res = await GET(
      getRequest('http://localhost/api/public/skills-users?skillId=avionics'),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/firestore down/);
  });
});
