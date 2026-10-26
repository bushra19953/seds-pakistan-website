/**
 * @jest-environment node
 *
 * GET /api/workflows/chat-state — contract tests (mocked transport;
 * zero live I/O). Pins:
 *   - unauthenticated -> 401 (identity is token-only);
 *   - missing workflowId -> 400;
 *   - the messages membership filter is applied against the TOKEN
 *     uid server-side, never against a client-supplied identity;
 *   - the participants param only ever reaches the typing/presence
 *     `userId in` filter, sliced to 10;
 *   - response shape is { messages, typing, presence } rows of
 *     { ...data, id }.
 * The Supa adapter is mocked OFF so the Firestore path runs against
 * the fake Admin DB (backend selection is the missions-route
 * pattern; the adapter arm's listDocs shapes are the adapter's own
 * contract suites).
 */

import { NextRequest } from 'next/server';

const mockWhereCalls: Array<{ collection: string; field: string; op: string; value: unknown }> = [];

const DOCS: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {
  messages: [
    { id: 'm1', data: { workflowId: 'wf-1', senderId: 'caller-1', message: 'hi', participantIds: ['caller-1', 'u2'] } },
  ],
  workflow_typing: [{ id: 'wf-1_u2', data: { workflowId: 'wf-1', userId: 'u2', isTyping: true } }],
  workflow_presence: [{ id: 'wf-1_u2', data: { workflowId: 'wf-1', userId: 'u2', isOnline: true } }],
};

function fakeQuery(collection: string) {
  const q: any = {
    where: (field: string, op: string, value: unknown) => {
      mockWhereCalls.push({ collection, field, op, value });
      return q;
    },
    orderBy: () => q,
    get: async () => ({
      docs: (DOCS[collection] ?? []).map((d) => ({ id: d.id, data: () => d.data })),
    }),
  };
  return q;
}

const mockDb = { collection: (name: string) => fakeQuery(name) };

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));

const mockVerify = jest.fn(async (_req?: unknown) => ({
  authenticated: true,
  user: { userId: 'caller-1' },
}));
jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: (req: unknown) => mockVerify(req),
}));

jest.mock('@/lib/supa', () => ({
  useSupa: () => false,
  getSupaClient: () => null,
  getSupaAdapter: () => {
    throw new Error('adapter must not be touched when the surface is OFF');
  },
}));

import { GET } from '../route';

function req(qs: string) {
  return new NextRequest(`http://localhost/api/workflows/chat-state?${qs}`);
}

beforeEach(() => {
  mockWhereCalls.length = 0;
  mockVerify.mockResolvedValue({ authenticated: true, user: { userId: 'caller-1' } } as never);
});

describe('GET /api/workflows/chat-state', () => {
  it('rejects unauthenticated callers with 401', async () => {
    mockVerify.mockResolvedValue({ authenticated: false, user: null } as never);
    const res = await GET(req('workflowId=wf-1'));
    expect(res.status).toBe(401);
  });

  it('rejects a missing workflowId with 400', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
  });

  it('serves all three payloads with the membership filter bound to the token uid', async () => {
    const res = await GET(req('workflowId=wf-1&participants=u2,u3'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([
      { workflowId: 'wf-1', senderId: 'caller-1', message: 'hi', participantIds: ['caller-1', 'u2'], id: 'm1' },
    ]);
    expect(body.typing).toHaveLength(1);
    expect(body.presence).toHaveLength(1);

    const membership = mockWhereCalls.find(
      (c) => c.collection === 'messages' && c.field === 'participantIds',
    );
    expect(membership?.op).toBe('array-contains');
    expect(membership?.value).toBe('caller-1');

    const typingIn = mockWhereCalls.find((c) => c.collection === 'workflow_typing' && c.field === 'userId');
    expect(typingIn?.op).toBe('in');
    expect(typingIn?.value).toEqual(['u2', 'u3']);
  });
});
