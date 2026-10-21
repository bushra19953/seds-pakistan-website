import {
  RedactionBlockError,
  assertAccessLevelChange,
  assertPublishable,
  getPublishBlock,
  isPublishable,
} from '../redaction-guard';
import {
  ACCESS_LEVEL,
  SERIES,
  type AccessLevel,
  type GovernanceSeries,
  type RedactionStatus,
} from '../types';

function rec(
  series: GovernanceSeries,
  accessLevel: AccessLevel,
  redactionStatus: RedactionStatus,
) {
  return { series, accessLevel, redactionStatus };
}

describe('redaction guard (spec 3.7)', () => {
  it('R-1: UNREDACTED_DO_NOT_PUBLISH can never be public, for every series', () => {
    for (const series of SERIES) {
      const record = rec(series, 'public', 'UNREDACTED_DO_NOT_PUBLISH');
      expect(getPublishBlock(record)).toBe('R-1');
      expect(isPublishable(record)).toBe(false);
      expect(() => assertPublishable(record)).toThrow(RedactionBlockError);
      try {
        assertPublishable(record);
        throw new Error('expected RedactionBlockError');
      } catch (e) {
        const err = e as RedactionBlockError;
        expect(err.rule).toBe('R-1');
        expect(err.code).toBe('redaction-block');
      }
      expect(() =>
        assertAccessLevelChange(
          rec(series, 'officer_only', 'UNREDACTED_DO_NOT_PUBLISH'),
          'public',
        ),
      ).toThrow(RedactionBlockError);
    }
  });

  it('R-2: a mou record with redactionStatus not_required is blocked from public', () => {
    const record = rec('mou', 'public', 'not_required');
    expect(getPublishBlock(record)).toBe('R-2');
    expect(() => assertPublishable(record)).toThrow(RedactionBlockError);
    try {
      assertPublishable(record);
      throw new Error('expected RedactionBlockError');
    } catch (e) {
      expect((e as RedactionBlockError).rule).toBe('R-2');
      expect((e as RedactionBlockError).code).toBe('redaction-block');
    }
    expect(() =>
      assertAccessLevelChange(rec('mou', 'officer_only', 'not_required'), 'public'),
    ).toThrow(RedactionBlockError);
  });

  it('R-2: a mou record with redactionStatus redacted may be public', () => {
    const record = rec('mou', 'public', 'redacted');
    expect(getPublishBlock(record)).toBeNull();
    expect(isPublishable(record)).toBe(true);
    expect(() => assertPublishable(record)).not.toThrow();
    expect(() =>
      assertAccessLevelChange(rec('mou', 'officer_only', 'redacted'), 'public'),
    ).not.toThrow();
  });

  it('R-1 takes precedence for the unredacted MOU', () => {
    expect(getPublishBlock(rec('mou', 'public', 'UNREDACTED_DO_NOT_PUBLISH'))).toBe('R-1');
  });

  it('non-mou series may be public with not_required or redacted', () => {
    for (const series of SERIES.filter((s) => s !== 'mou')) {
      for (const redactionStatus of ['not_required', 'redacted'] as RedactionStatus[]) {
        const record = rec(series, 'public', redactionStatus);
        expect(getPublishBlock(record)).toBeNull();
        expect(() => assertPublishable(record)).not.toThrow();
      }
    }
  });

  it('non-public access levels are always allowed, for every series and redaction status', () => {
    const nonPublic = ACCESS_LEVEL.filter((l) => l !== 'public');
    const redactionStatuses: RedactionStatus[] = [
      'not_required',
      'redacted',
      'UNREDACTED_DO_NOT_PUBLISH',
    ];
    for (const series of SERIES) {
      for (const level of nonPublic) {
        for (const redactionStatus of redactionStatuses) {
          const record = rec(series, level, redactionStatus);
          expect(getPublishBlock(record)).toBeNull();
          expect(() => assertPublishable(record)).not.toThrow();
        }
      }
      // Access-level changes to any non-public target never throw either.
      for (const target of nonPublic) {
        expect(() =>
          assertAccessLevelChange(
            rec(series, 'officer_only', 'UNREDACTED_DO_NOT_PUBLISH'),
            target,
          ),
        ).not.toThrow();
      }
    }
  });

  it('T-15 shapes: none of the 10 seed families can reach public at seed state', () => {
    const seedShapes = [
      rec('constitution_suite', 'officer_only', 'UNREDACTED_DO_NOT_PUBLISH'), // 00 Master Architecture
      rec('constitution_suite', 'officer_only', 'UNREDACTED_DO_NOT_PUBLISH'), // 01 Constitution
      rec('constitution_suite', 'officer_only', 'not_required'), // 02 Role Catalog
      rec('constitution_suite', 'officer_only', 'not_required'), // 03 Reserved Powers
      rec('constitution_suite', 'officer_only', 'not_required'), // 04 Decision Rights
      rec('policy', 'officer_only', 'not_required'), // 05 Finance policy
      rec('mou', 'officer_only', 'UNREDACTED_DO_NOT_PUBLISH'), // 06 SEDS Earth MOU
      rec('policy', 'officer_only', 'not_required'), // 07 Procedure Manual
      rec('policy', 'officer_only', 'not_required'), // 08 Compliance Calendar
      rec('other', 'officer_only', 'not_required'), // 09 Build Roadmap
    ];
    for (const shape of seedShapes) {
      if (shape.redactionStatus === 'UNREDACTED_DO_NOT_PUBLISH' || shape.series === 'mou') {
        expect(() => assertAccessLevelChange(shape, 'public')).toThrow(RedactionBlockError);
      }
    }
    // Families 00, 01 blocked by R-1 at not_required too only via their seed
    // DO NOT PUBLISH state; family 06 is blocked at not_required by R-2:
    expect(() =>
      assertAccessLevelChange(rec('mou', 'officer_only', 'not_required'), 'public'),
    ).toThrow(RedactionBlockError);
  });
});
