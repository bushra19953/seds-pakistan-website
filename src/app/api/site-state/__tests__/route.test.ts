/**
 * @jest-environment node
 *
 * GET /api/site-state (F14 read-bleed bound): the response carries a
 * 60-second shared-cache header so repeat polls across tabs do not each
 * pay a fresh licence read. Body shape is unchanged: only the mode, plus
 * the public notice when revoked.
 */

const mockState = {
  mode: 'live' as string,
  licencePublicNotice: undefined as string | undefined,
};

jest.mock('@/lib/server/platform-licence', () => ({
  getEffectiveSiteState: jest.fn(async () => ({
    mode: mockState.mode,
    licencePublicNotice: mockState.licencePublicNotice,
  })),
}));

import { GET } from '@/app/api/site-state/route';

beforeEach(() => {
  mockState.mode = 'live';
  mockState.licencePublicNotice = undefined;
});

describe('GET /api/site-state', () => {
  it('responds with Cache-Control s-maxage=60', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60');
  });

  it('returns only the mode while live', async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ mode: 'live' });
  });

  it('surfaces the public notice only when revoked', async () => {
    mockState.mode = 'revoked';
    mockState.licencePublicNotice = 'Licence revoked notice';
    const res = await GET();
    expect(await res.json()).toEqual({
      mode: 'revoked',
      licencePublicNotice: 'Licence revoked notice',
    });
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60');
  });
});
