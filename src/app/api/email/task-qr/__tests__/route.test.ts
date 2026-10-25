/**
 * @jest-environment node
 *
 * route.test.ts — GET /api/email/task-qr, the hosted QR image embedded by
 * the task_assigned email template. Pins: a canonical-domain link yields a
 * real PNG; off-domain, non-https, credentialed, and missing links are
 * refused so the endpoint cannot mint QR codes for third-party URLs.
 */

import { NextRequest } from 'next/server';
import { GET } from '../route';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function requestFor(link?: string) {
  const base = 'https://sedspakistan.live/api/email/task-qr';
  const url = link === undefined ? base : `${base}?link=${encodeURIComponent(link)}`;
  return new NextRequest(url);
}

describe('GET /api/email/task-qr', () => {
  it('returns a PNG for a canonical-domain task link', async () => {
    const res = await GET(
      requestFor('https://sedspakistan.live/profile/unified?uid=cadet-1&task=task-9'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual(PNG_MAGIC);
    expect(bytes.length).toBeGreaterThan(100);
  });

  it('rejects a link to a third-party host', async () => {
    const res = await GET(requestFor('https://evil.example.com/phish'));
    expect(res.status).toBe(400);
  });

  it('rejects a non-https link', async () => {
    const res = await GET(requestFor('http://sedspakistan.live/profile/unified'));
    expect(res.status).toBe(400);
  });

  it('rejects a credentialed link', async () => {
    const res = await GET(requestFor('https://user:pass@sedspakistan.live/x'));
    expect(res.status).toBe(400);
  });

  it('rejects a missing link parameter', async () => {
    const res = await GET(requestFor(undefined));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed link parameter', async () => {
    const res = await GET(requestFor('not a url'));
    expect(res.status).toBe(400);
  });
});
