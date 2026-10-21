/**
 * @jest-environment node
 *
 * Public Board endpoint tests (spec C.7 cases 27-31): allow-list output with
 * a recursive forbidden-key scan, and the boardLive off state.
 */

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(),
  ensureAdminInitialized: () => true,
}));

jest.mock('@/lib/server/governance-settings', () => ({
  isPhase2Live: jest.fn(),
}));

import { GET } from '@/app/api/board/route';
import { getDb } from '@/lib/server/firebase-admin';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { PUBLIC_BOARD_FORBIDDEN_KEYS } from '@/lib/board-public';

const mockGetDb = getDb as jest.Mock;
const mockLive = isPhase2Live as jest.Mock;

const SEATED_FA = {
  seatKey: 'seat_fa_1',
  category: 'Founder-Appointed',
  status: 'seated',
  holderUid: 'secret-uid-1',
  holderName: 'Dr. Example Governor',
  holderEmail: 'private@example.com',
  holderExternalId: 'passport-123',
  publicBio: 'Aerospace professor.',
  photoUrl: 'https://example.com/p.jpg',
  seatedAt: new Date('2026-01-15T00:00:00Z'),
  termExpiresAt: new Date('2029-01-15T00:00:00Z'),
  appointmentBasis: 'Founder appointment under the Reserved Powers Schedule s.3.2(b), Consent on file',
  consentRequestId: 'cr-secret',
  voteRecordId: 'vote-secret',
  electionResult: { meetingDate: '2026-01-01', votesFor: 9, holderEmail: 'nested@example.com' },
  appointedBy: 'founder-uid',
  appointedByName: 'Founder',
  notes: 'internal note',
  termAlertStage: 1,
  version: 3,
  lastHolderName: 'Previous Person',
  lastHolderUid: 'prev-uid',
  vacateRecord: { reason: 'resigned', by: 'founder-uid' },
  removalRecord: { reason: 'removed', by: 'founder-uid' },
};

function collectKeys(value: unknown, acc: Set<string>) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDb.mockReturnValue({
    collection: () => ({
      get: async () => ({
        docs: [{ id: 'seat_fa_1', data: () => SEATED_FA }],
      }),
    }),
  });
});

it('boardLive off answers 200 with an empty board', async () => {
  mockLive.mockResolvedValue(false);
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ boardLive: false, board: [] });
});

it('boardLive on returns all nine seats in register order', async () => {
  mockLive.mockResolvedValue(true);
  const res = await GET();
  const body = await res.json();
  expect(body.boardLive).toBe(true);
  expect(body.board).toHaveLength(9);
  expect(body.board.map((s: { seatKey: string }) => s.seatKey)).toEqual([
    'seat_founder', 'seat_fa_1', 'seat_fa_2', 'seat_fa_3', 'seat_fa_4',
    'seat_co_1', 'seat_co_2', 'seat_me_1', 'seat_me_2',
  ]);
});

it('the public payload contains NO forbidden key at any depth', async () => {
  mockLive.mockResolvedValue(true);
  const res = await GET();
  const body = await res.json();
  const keys = new Set<string>();
  collectKeys(body, keys);
  for (const forbidden of PUBLIC_BOARD_FORBIDDEN_KEYS) {
    expect(keys.has(forbidden)).toBe(false);
  }
  const raw = JSON.stringify(body);
  expect(raw).not.toContain('private@example.com');
  expect(raw).not.toContain('secret-uid-1');
  expect(raw).not.toContain('cr-secret');
  expect(raw).not.toContain('internal note');
  expect(raw).not.toContain('Previous Person');
});

it('a seated Governor shows only the public fields', async () => {
  mockLive.mockResolvedValue(true);
  const res = await GET();
  const body = await res.json();
  const fa1 = body.board.find((s: { seatKey: string }) => s.seatKey === 'seat_fa_1');
  expect(fa1).toEqual({
    seatKey: 'seat_fa_1',
    category: 'Founder-Appointed',
    categoryLabel: 'Founder-Appointed Governor',
    status: 'seated',
    holderName: 'Dr. Example Governor',
    publicBio: 'Aerospace professor.',
    photoUrl: 'https://example.com/p.jpg',
    seatedAt: '2026-01-15T00:00:00.000Z',
    termExpiresAt: '2029-01-15T00:00:00.000Z',
  });
  const vacant = body.board.find((s: { seatKey: string }) => s.seatKey === 'seat_co_1');
  expect(vacant.status).toBe('vacant');
  expect(vacant.holderName).toBeNull();
});
