/**
 * @jest-environment node
 *
 * Public Board endpoint tests (spec C.7 cases 28-31): seated seats only,
 * allow-list fields only, recursive forbidden-key scan, seatOrder order,
 * and the boardLive off state.
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
  seatOrder: 2,
  category: 'founder_appointed',
  status: 'seated',
  holderUid: 'secret-uid-1',
  holderName: 'Dr. Example Governor',
  holderEmail: 'private@example.com',
  holderExternalId: 'passport-123',
  holderRoleKey: 'governor_founder',
  publicBio: 'Aerospace professor.',
  photoUrl: 'https://example.com/p.jpg',
  termStart: new Date('2026-01-15T00:00:00Z'),
  termEnd: null,
  seatedAt: new Date('2026-01-15T00:00:00Z'),
  appointmentRecordRef: { kind: 'consent', id: 'cr-secret', label: 'Schedule s.3.2(b) Consent' },
  consentRequestId: 'cr-secret',
  voteRecordId: 'vote-secret',
  electionResult: { electionDate: '2026-01-01', votesForHolder: 9 },
  appointedBy: 'founder-uid',
  appointedByName: 'Founder',
  notes: 'internal note',
  termAlertStage: 'none',
  version: 3,
  lastHolderName: 'Previous Person',
  lastHolderUid: 'prev-uid',
  removalRecord: { cause: 'founder_discretion' },
};

const SEATED_FOUNDER = {
  seatKey: 'seat_founder',
  seatOrder: 1,
  category: 'founder_ex_officio',
  status: 'seated',
  holderUid: 'founder-uid',
  holderName: 'The Founder',
  holderEmail: 'founder@example.com',
  holderRoleKey: 'founder_patron',
  termStart: new Date('2026-01-01T00:00:00Z'),
  termEnd: null,
  version: 1,
  termAlertStage: 'none',
};

const LAPSED_CO = {
  seatKey: 'seat_co_1',
  seatOrder: 6,
  category: 'co_opted',
  status: 'seated',
  holderUid: 'lapsed-uid',
  holderName: 'Lapsed Governor',
  holderEmail: 'lapsed@example.com',
  holderRoleKey: 'governor_coopted',
  termStart: new Date('2023-01-01T00:00:00Z'),
  termEnd: new Date('2026-01-01T00:00:00Z'), // in the past at request time
  version: 2,
  termAlertStage: 't30_sent',
};

const VACANT_ME = {
  seatKey: 'seat_me_1',
  seatOrder: 8,
  category: 'member_elected',
  status: 'awaiting_election',
  holderUid: null,
  holderName: null,
  version: 1,
  termAlertStage: 'none',
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
        docs: [
          { id: 'seat_fa_1', data: () => SEATED_FA },
          { id: 'seat_founder', data: () => SEATED_FOUNDER },
          { id: 'seat_co_1', data: () => LAPSED_CO },
          { id: 'seat_me_1', data: () => VACANT_ME },
        ],
      }),
    }),
  });
});

it('boardLive off answers 200 with an empty board (case 30)', async () => {
  mockLive.mockResolvedValue(false);
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ boardLive: false, board: [] });
});

it('returns only effectively seated seats, founder first by seatOrder (cases 29, 31)', async () => {
  mockLive.mockResolvedValue(true);
  const res = await GET();
  const body = await res.json();
  expect(body.boardLive).toBe(true);
  // The lapsed co-opted seat and the awaiting-election seat are excluded.
  expect(body.board.map((s: { seatKey: string }) => s.seatKey)).toEqual(['seat_founder', 'seat_fa_1']);
});

it('the public payload contains NO forbidden key at any depth (case 28)', async () => {
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
  expect(raw).not.toContain('Aerospace professor.');
});

it('a seated Governor shows exactly the allow-listed fields', async () => {
  mockLive.mockResolvedValue(true);
  const res = await GET();
  const body = await res.json();
  const fa1 = body.board.find((s: { seatKey: string }) => s.seatKey === 'seat_fa_1');
  expect(fa1).toEqual({
    seatKey: 'seat_fa_1',
    seatCategory: 'founder_appointed',
    categoryLabel: 'Founder-Appointed Governor',
    holderName: 'Dr. Example Governor',
    termStart: '2026-01-15T00:00:00.000Z',
    termEnd: null,
    isFounderSeat: false,
  });
  const founder = body.board[0];
  expect(founder.isFounderSeat).toBe(true);
});

it('the live response carries the specced cache headers', async () => {
  mockLive.mockResolvedValue(true);
  const res = await GET();
  expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
});
