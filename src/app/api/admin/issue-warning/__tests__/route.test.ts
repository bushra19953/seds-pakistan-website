/**
 * @jest-environment node
 *
 * POST /api/admin/issue-warning was RETIRED by the Phase 2 discipline
 * rebuild (spec E.6.5): direct warning issuance no longer exists. The
 * endpoint answers 410 Gone with a pointer to the disciplinary case
 * API for one release. These tests pin that contract: every method,
 * every payload, every caller gets 410 and nothing is written.
 */
import { NextRequest } from 'next/server';
import { GET, POST } from '../route';

function req(method: string, body?: any) {
  return new NextRequest('http://localhost/api/admin/issue-warning', {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/admin/issue-warning (retired)', () => {
  test('answers 410 Gone with the successor pointer', async () => {
    const res = await POST(req('POST', { userUid: 'u1', reason: 'anything' }));
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe('Gone');
    expect(json.successor).toBe('/api/discipline/cases');
  });

  test('GET also answers 410', async () => {
    const res = await GET(req('GET'));
    expect(res.status).toBe(410);
  });

  test('410 regardless of payload shape', async () => {
    const res = await POST(req('POST', {}));
    expect(res.status).toBe(410);
  });
});
