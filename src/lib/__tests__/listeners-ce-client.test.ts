/**
 * listeners-ce-client — contract tests (mocked fetch + mocked
 * firebase/auth; zero live I/O).
 *
 * Pins: every helper talks only to its token-verified server route
 * with a Bearer token; payload shapes map to the listener shapes;
 * any failure (non-2xx, malformed payload, fetch throw) returns
 * null, which callers treat as "keep last good state".
 */

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: async () => 'test-token' },
  }),
}));

import {
  fetchAuthorityRoleDoc,
  fetchRoleDefinitionsList,
  fetchChatState,
  ceToDate,
} from '@/lib/listeners-ce-client';

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
});

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

describe('fetchAuthorityRoleDoc (A21/A22)', () => {
  it('reads roles/{uid} through the roles seam route with a Bearer token', async () => {
    fetchMock.mockResolvedValue(okJson({ doc: { id: 'u1', exists: true, data: { role: 'member' } } }));
    const res = await fetchAuthorityRoleDoc('u1');
    expect(res).toEqual({ exists: true, data: { role: 'member' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/roles/reads?');
    expect(url).toContain('kind=doc');
    expect(url).toContain('collection=roles');
    expect(url).toContain('id=u1');
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('maps a missing doc to exists:false with null data', async () => {
    fetchMock.mockResolvedValue(okJson({ doc: { id: 'u1', exists: false, data: null } }));
    expect(await fetchAuthorityRoleDoc('u1')).toEqual({ exists: false, data: null });
  });

  it('returns null on non-2xx and on malformed payloads', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await fetchAuthorityRoleDoc('u1')).toBeNull();
    fetchMock.mockResolvedValue(okJson({ nope: true }));
    expect(await fetchAuthorityRoleDoc('u1')).toBeNull();
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await fetchAuthorityRoleDoc('u1')).toBeNull();
  });
});

describe('fetchRoleDefinitionsList (B10)', () => {
  it('maps seam docs to the useCollection shape { ...data, id }', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        docs: [
          { id: 'chair_design', exists: true, data: { name: 'Design Chair' } },
          { id: 'broken', exists: true, data: null },
          { noId: true },
          'junk',
        ],
      }),
    );
    const res = await fetchRoleDefinitionsList();
    expect(res).toEqual([
      { name: 'Design Chair', id: 'chair_design' },
      { id: 'broken' },
    ]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('kind=list');
    expect(url).toContain('collection=roleDefinitions');
  });

  it('returns null when docs is not an array', async () => {
    fetchMock.mockResolvedValue(okJson({ docs: 'nope' }));
    expect(await fetchRoleDefinitionsList()).toBeNull();
  });
});

describe('fetchChatState (B17/A19/A20/A18)', () => {
  it('queries the chat-state route with workflowId and the first-10 participant hint', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        messages: [{ id: 'm1', message: 'hi' }, 'junk', null],
        typing: [{ id: 't1' }],
        presence: 'not-an-array',
      }),
    );
    const ids = Array.from({ length: 14 }, (_, i) => `u${i}`);
    const res = await fetchChatState('wf-1', ids);
    expect(res).toEqual({
      messages: [{ id: 'm1', message: 'hi' }],
      typing: [{ id: 't1' }],
      presence: [],
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/workflows/chat-state?');
    expect(url).toContain('workflowId=wf-1');
    const participants = new URLSearchParams(url.split('?')[1]).get('participants');
    expect(participants?.split(',')).toHaveLength(10);
  });

  it('omits the participants param when no hint is given (A18 shape)', async () => {
    fetchMock.mockResolvedValue(okJson({ messages: [], typing: [], presence: [] }));
    await fetchChatState('wf-1', []);
    const [url] = fetchMock.mock.calls[0];
    expect(url).not.toContain('participants=');
  });

  it('returns null on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await fetchChatState('wf-1', [])).toBeNull();
  });
});

describe('ceToDate', () => {
  it('converts ISO strings and Timestamp-like objects, defaults to now', () => {
    expect(ceToDate('2026-01-02T03:04:05.000Z').toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(ceToDate({ toDate: () => new Date('2026-03-04T00:00:00.000Z') }).toISOString()).toBe(
      '2026-03-04T00:00:00.000Z',
    );
    const before = Date.now();
    const d = ceToDate('not-a-date');
    expect(d.getTime()).toBeGreaterThanOrEqual(before);
    expect(d.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
