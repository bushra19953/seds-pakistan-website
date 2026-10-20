/**
 * @jest-environment node
 *
 * Tests for GET /api/public/portfolio/[username] (WS3).
 *
 * - Unauthenticated resolution; no-auth callers succeed for opted-in members.
 * - Resolution order: explicit username field, then doc id, then
 *   displayName-slug scan.
 * - Privacy: non-opted-in members (default false) 404; the response never
 *   carries email/whatsapp/warning/ban fields; mission timeline carries no
 *   proof links.
 */

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

function makeDoc(id: string, data: any) {
  return { id, data: () => data };
}

const state = {
  userByUsernameQuery: [] as any[],
  userDocById: null as any,
  scanDocs: [] as any[],
  tasks: [
    makeDoc('t1', {
      title: 'Done task',
      status: 'completed',
      completedAt: ts('2026-10-09T00:00:00Z'),
      deliverableFiles: [{ downloadUrl: 'https://drive.example/secret' }],
      assigneeId: 'u-optin',
    }),
  ],
  skillsDocs: [makeDoc('cad', { name: 'CAD Design' })],
  certDocs: [
    makeDoc('c1', { code: 'SEDS-1', achievement: 'X', issueDate: ts('2026-05-01T00:00:00Z'), userId: 'u-optin' }),
  ],
};

const mockDb = {
  collection: jest.fn((name: string) => ({
    where: jest.fn((field: string, _op: string, value: unknown) => ({
      limit: jest.fn(() => ({
        get: jest.fn(async () => {
          if (name === 'users' && field === 'username') {
            const docs = state.userByUsernameQuery.filter((d: any) => d.data().username === value);
            return { empty: docs.length === 0, docs };
          }
          if (name === 'tasks') return { docs: state.tasks };
          if (name === 'certificates') return { docs: state.certDocs };
          return { docs: [] };
        }),
      })),
      get: jest.fn(async () => {
        if (name === 'users' && field === 'updatedAt') return { docs: state.scanDocs };
        if (name === 'skills') return { docs: state.skillsDocs };
        return { docs: [] };
      }),
    })),
    doc: jest.fn((id: string) => ({
      id,
      get: jest.fn(async () => ({ exists: state.userDocById !== null, id, data: () => state.userDocById })),
    })),
    orderBy: jest.fn((_f: string, _d: string) => ({
      limit: jest.fn(() => ({
        get: jest.fn(async () => ({ docs: state.scanDocs })),
      })),
    })),
  })),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
}));

import { GET, resolvePortfolioUser } from '@/app/api/public/portfolio/[username]/route';
import { NextRequest } from 'next/server';

const req = () => new NextRequest('http://localhost/api/public/portfolio/x');

const optedIn = {
  displayName: 'Maira Batool',
  username: 'maira-batool',
  email: 'maira@example.com',
  whatsappNumber: '+92-300-1111111',
  publicDirectoryOptIn: true,
  warningCount: 3,
  isBlacklisted: true,
  role: 'member',
  points: 100,
  skillIds: ['cad'],
  badges: ['rocket'],
};

const privateUser = { ...optedIn, publicDirectoryOptIn: false };

describe('resolvePortfolioUser', () => {
  test('resolves via explicit username field first', async () => {
    state.userByUsernameQuery = [makeDoc('u-optin', optedIn)];
    const r = await resolvePortfolioUser(mockDb as any, 'maira-batool');
    expect(r?.uid).toBe('u-optin');
  });

  test('falls back to doc id, then to the displayName-slug scan', async () => {
    state.userByUsernameQuery = [];
    state.userDocById = { ...optedIn, username: undefined };
    const byId = await resolvePortfolioUser(mockDb as any, 'u-optin');
    expect(byId?.uid).toBe('u-optin');

    state.userDocById = null;
    state.scanDocs = [makeDoc('u-scan', { displayName: 'Maira Batool', publicDirectoryOptIn: true })];
    const byScan = await resolvePortfolioUser(mockDb as any, 'maira-batool');
    expect(byScan?.uid).toBe('u-scan');

    state.scanDocs = [];
    expect(await resolvePortfolioUser(mockDb as any, 'nobody')).toBeNull();
  });
});

describe('GET /api/public/portfolio/[username]', () => {
  beforeEach(() => {
    state.userByUsernameQuery = [];
    state.userDocById = null;
    state.scanDocs = [];
  });

  test('returns sanitised portfolio for an opted-in member with no auth token', async () => {
    state.userByUsernameQuery = [makeDoc('u-optin', optedIn)];
    const res = await GET(req(), { params: Promise.resolve({ username: 'maira-batool' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    const json = JSON.stringify(body);

    // Privacy: no contact, no disciplinary, no proof links
    expect(json).not.toContain('maira@example.com');
    expect(json).not.toContain('300-1111111');
    expect(json).not.toContain('warningCount');
    expect(json).not.toContain('isBlacklisted');
    expect(json).not.toContain('drive.example/secret');
    expect(body.probation).toBeUndefined();

    expect(body.profile.displayName).toBe('Maira Batool');
    expect(body.profile.username).toBe('maira-batool');
    expect(body.skillNames.cad).toBe('CAD Design');
    expect(body.telemetry.tasksCompleted).toBe(1);
    expect(body.missionTimeline[0].title).toBe('Done task');
    expect(body.certificates[0].verificationUrl).toBe('/verify/SEDS-1');
  });

  test('404s for a member who has not opted in (default false)', async () => {
    state.userByUsernameQuery = [makeDoc('u-private', privateUser)];
    const res = await GET(req(), { params: Promise.resolve({ username: 'maira-batool' }) });
    expect(res.status).toBe(404);
  });

  test('executive default: president_national resolves without an explicit opt-in', async () => {
    state.userByUsernameQuery = [
      makeDoc('u-exec', { displayName: 'Exec', username: 'exec', role: 'president_national' }),
    ];
    const res = await GET(req(), { params: Promise.resolve({ username: 'exec' }) });
    expect(res.status).toBe(200);
  });
});
