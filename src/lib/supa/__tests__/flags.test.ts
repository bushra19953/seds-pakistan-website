/**
 * @jest-environment node
 *
 * flags.test.ts — useSupa() parses SUPA_SURFACES at call time and defaults
 * to OFF for every surface, so an unconfigured deployment always serves
 * from Firestore.
 */

import { parseSupaSurfaces, useSupa } from '@/lib/supa/flags';

describe('useSupa', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SUPA_SURFACES;
    delete process.env.SUPA_SURFACES;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = saved;
  });

  it('is OFF for everything when SUPA_SURFACES is unset or empty', () => {
    expect(useSupa('announcements')).toBe(false);
    process.env.SUPA_SURFACES = '';
    expect(useSupa('announcements')).toBe(false);
    process.env.SUPA_SURFACES = '  , ,';
    expect(useSupa('announcements')).toBe(false);
  });

  it('turns ON only the listed surfaces', () => {
    process.env.SUPA_SURFACES = 'announcements,directory';
    expect(useSupa('announcements')).toBe(true);
    expect(useSupa('directory')).toBe(true);
    expect(useSupa('tasks')).toBe(false);
  });

  it('matches case-insensitively and trims whitespace', () => {
    process.env.SUPA_SURFACES = ' Announcements , Directory ';
    expect(useSupa('announcements')).toBe(true);
    expect(useSupa('DIRECTORY')).toBe(true);
  });

  it("treats '*' as every surface ON", () => {
    process.env.SUPA_SURFACES = '*';
    expect(useSupa('anything')).toBe(true);
  });

  it('parseSupaSurfaces normalizes the raw value', () => {
    expect(parseSupaSurfaces(undefined)).toEqual(new Set());
    expect(parseSupaSurfaces('A, b ,A')).toEqual(new Set(['a', 'b']));
  });
});
