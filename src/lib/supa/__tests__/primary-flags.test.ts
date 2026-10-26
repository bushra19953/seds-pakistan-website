/**
 * @jest-environment node
 *
 * primary-flags.test.ts — isSupaPrimary() / parseSupaPrimary() contracts
 * (cutover foundation wave). FLAG LAW: a surface is write-primary iff its
 * token is in BOTH SUPA_SURFACES and SUPA_PRIMARY; SUPA_PRIMARY parsing is
 * the shipped SUPA_SURFACES comma-only parser, edge case for edge case.
 */

import { isSupaPrimary, parseSupaPrimary, parseSupaSurfaces } from '@/lib/supa/flags';

describe('isSupaPrimary', () => {
  let savedSurfaces: string | undefined;
  let savedPrimary: string | undefined;

  beforeEach(() => {
    savedSurfaces = process.env.SUPA_SURFACES;
    savedPrimary = process.env.SUPA_PRIMARY;
    delete process.env.SUPA_SURFACES;
    delete process.env.SUPA_PRIMARY;
  });

  afterEach(() => {
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
    if (savedPrimary === undefined) delete process.env.SUPA_PRIMARY;
    else process.env.SUPA_PRIMARY = savedPrimary;
  });

  it('is OFF for everything when SUPA_PRIMARY is unset or empty (default = dual-write)', () => {
    process.env.SUPA_SURFACES = 'events,elections';
    expect(isSupaPrimary('events')).toBe(false);
    process.env.SUPA_PRIMARY = '';
    expect(isSupaPrimary('events')).toBe(false);
    process.env.SUPA_PRIMARY = '  , ,';
    expect(isSupaPrimary('events')).toBe(false);
  });

  it('requires the token in BOTH flags', () => {
    process.env.SUPA_SURFACES = 'events,elections';
    process.env.SUPA_PRIMARY = 'events,motions';
    expect(isSupaPrimary('events')).toBe(true); // in both
    expect(isSupaPrimary('elections')).toBe(false); // surfaces only: dual-write
    expect(isSupaPrimary('motions')).toBe(false); // primary only: not even flipped
    expect(isSupaPrimary('tasks')).toBe(false); // in neither
  });

  it('a SUPA_PRIMARY token alone never flips an unflipped surface', () => {
    process.env.SUPA_PRIMARY = 'events';
    expect(isSupaPrimary('events')).toBe(false);
    process.env.SUPA_SURFACES = '';
    expect(isSupaPrimary('events')).toBe(false);
  });

  it('matches case-insensitively and trims whitespace, like useSupa', () => {
    process.env.SUPA_SURFACES = ' Events , ELECTIONS ';
    process.env.SUPA_PRIMARY = ' eVeNtS, elections ';
    expect(isSupaPrimary('EVENTS')).toBe(true);
    expect(isSupaPrimary(' elections ')).toBe(true);
  });

  it("'*' in SUPA_PRIMARY makes every SURFACES-flipped surface primary, and no others", () => {
    process.env.SUPA_SURFACES = 'events';
    process.env.SUPA_PRIMARY = '*';
    expect(isSupaPrimary('events')).toBe(true);
    expect(isSupaPrimary('tasks')).toBe(false);
  });

  it("'*' in SUPA_SURFACES plus a named SUPA_PRIMARY token is primary for that token only", () => {
    process.env.SUPA_SURFACES = '*';
    process.env.SUPA_PRIMARY = 'events';
    expect(isSupaPrimary('events')).toBe(true);
    expect(isSupaPrimary('tasks')).toBe(false);
  });

  it("'*' in both is primary for everything", () => {
    process.env.SUPA_SURFACES = '*';
    process.env.SUPA_PRIMARY = '*';
    expect(isSupaPrimary('anything')).toBe(true);
  });

  it('reads the env at call time (rollback = removing the token)', () => {
    process.env.SUPA_SURFACES = 'events';
    process.env.SUPA_PRIMARY = 'events';
    expect(isSupaPrimary('events')).toBe(true);
    process.env.SUPA_PRIMARY = '';
    expect(isSupaPrimary('events')).toBe(false);
  });
});

describe('parseSupaPrimary (comma-only parser parity with parseSupaSurfaces)', () => {
  const cases: Array<string | undefined> = [
    undefined,
    '',
    '  , ,',
    'events',
    'Events, ELECTIONS ,events',
    ' a ,, b ',
    '*',
  ];

  it.each(cases.map((c) => [String(c), c] as const))(
    'parses %s identically to parseSupaSurfaces',
    (_label, raw) => {
      expect(parseSupaPrimary(raw)).toEqual(parseSupaSurfaces(raw));
    },
  );

  it('normalizes tokens exactly like the shipped parser', () => {
    expect(parseSupaPrimary(undefined)).toEqual(new Set());
    expect(parseSupaPrimary('A, b ,A')).toEqual(new Set(['a', 'b']));
  });
});
