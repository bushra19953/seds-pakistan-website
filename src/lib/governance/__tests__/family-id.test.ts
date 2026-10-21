import {
  SERIES,
  SERIES_CODE,
  isValidFamilyId,
  isValidSlug,
  makeFamilyId,
  makeRecordId,
  parseFamilyId,
  parseRecordId,
} from '../types';

describe('family and record id scheme (spec 3.3)', () => {
  it('SERIES_CODE matches the fixed spec map', () => {
    expect(SERIES_CODE).toEqual({
      constitution_suite: 'cs',
      policy: 'pol',
      mou: 'mou',
      minutes: 'min',
      resolution: 'res',
      registrar_filing: 'reg',
      fbr_receipt: 'fbr',
      benchmarking_pack: 'bench',
      charter: 'chr',
      acceptance_letter: 'acc',
      consent_record: 'con',
      other: 'oth',
    });
    expect(Object.keys(SERIES_CODE).sort()).toEqual([...SERIES].sort());
  });

  it('makeFamilyId builds govfam-<code>-<slug>', () => {
    expect(makeFamilyId('constitution_suite', 'constitution')).toBe('govfam-cs-constitution');
    expect(makeFamilyId('constitution_suite', 'master-architecture')).toBe(
      'govfam-cs-master-architecture',
    );
    expect(makeFamilyId('mou', 'seds-earth-mou')).toBe('govfam-mou-seds-earth-mou');
    expect(makeFamilyId('policy', 'finance-related-party-ip')).toBe(
      'govfam-pol-finance-related-party-ip',
    );
    expect(makeFamilyId('minutes', 'board-2026-q3')).toBe('govfam-min-board-2026-q3');
  });

  it('makeRecordId appends --v<NNN> zero-padded to 3', () => {
    expect(makeRecordId('govfam-cs-constitution', 1)).toBe('govfam-cs-constitution--v001');
    expect(makeRecordId('govfam-cs-constitution', 2)).toBe('govfam-cs-constitution--v002');
    expect(makeRecordId('govfam-cs-constitution', 12)).toBe('govfam-cs-constitution--v012');
    expect(makeRecordId('govfam-cs-constitution', 123)).toBe('govfam-cs-constitution--v123');
  });

  it('parseRecordId round-trips makeRecordId for every series', () => {
    for (const series of SERIES) {
      const familyId = makeFamilyId(series, 'sample-doc');
      for (const version of [1, 7, 42, 100]) {
        const recordId = makeRecordId(familyId, version);
        expect(parseRecordId(recordId)).toEqual({ familyId, version });
      }
    }
  });

  it('parseFamilyId round-trips makeFamilyId', () => {
    expect(parseFamilyId('govfam-cs-constitution')).toEqual({
      series: 'constitution_suite',
      seriesCode: 'cs',
      slug: 'constitution',
    });
    expect(parseFamilyId('govfam-mou-seds-earth-mou')).toEqual({
      series: 'mou',
      seriesCode: 'mou',
      slug: 'seds-earth-mou',
    });
    expect(parseFamilyId('govfam-xxx-constitution')).toBeNull();
    expect(parseFamilyId('not-a-family')).toBeNull();
  });

  it('isValidFamilyId accepts spec examples and rejects malformed ids', () => {
    expect(isValidFamilyId('govfam-cs-constitution')).toBe(true);
    expect(isValidFamilyId('govfam-bench-q3-pack')).toBe(true);
    expect(isValidFamilyId('govfam-zz-constitution')).toBe(false);
    expect(isValidFamilyId('cs-constitution')).toBe(false);
    expect(isValidFamilyId('govfam-cs-Constitution')).toBe(false);
    expect(isValidFamilyId('govfam-cs-')).toBe(false);
    expect(isValidFamilyId('')).toBe(false);
    expect(isValidFamilyId(null)).toBe(false);
  });

  it('slug validation: kebab-case, [a-z0-9-], max 40 chars', () => {
    expect(isValidSlug('constitution')).toBe(true);
    expect(isValidSlug('board-minutes-2026-q3')).toBe(true);
    expect(isValidSlug('a'.repeat(40))).toBe(true);
    expect(isValidSlug('a'.repeat(41))).toBe(false);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('Constitution')).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('has_underscore')).toBe(false);
    expect(isValidSlug('-leading-hyphen')).toBe(false);
    expect(isValidSlug('trailing-hyphen-')).toBe(false);
    expect(isValidSlug('double--hyphen')).toBe(false);
    expect(isValidSlug(42)).toBe(false);
  });

  it('makeFamilyId throws on an invalid slug or unknown series', () => {
    expect(() => makeFamilyId('policy', 'Bad Slug')).toThrow();
    expect(() => makeFamilyId('policy', '')).toThrow();
    expect(() => makeFamilyId('policy', 'x'.repeat(41))).toThrow();
    // @ts-expect-error unknown series is rejected at runtime too
    expect(() => makeFamilyId('nope', 'valid-slug')).toThrow();
  });

  it('makeRecordId throws on an invalid family or version', () => {
    expect(() => makeRecordId('bogus', 1)).toThrow();
    expect(() => makeRecordId('govfam-cs-constitution', 0)).toThrow();
    expect(() => makeRecordId('govfam-cs-constitution', -1)).toThrow();
    expect(() => makeRecordId('govfam-cs-constitution', 1.5)).toThrow();
  });

  it('parseRecordId returns null for malformed record ids', () => {
    expect(parseRecordId('govfam-cs-constitution')).toBeNull();
    expect(parseRecordId('govfam-cs-constitution--v1')).toBeNull();
    expect(parseRecordId('govfam-cs-constitution--v01')).toBeNull();
    expect(parseRecordId('govfam-cs-constitution-v001')).toBeNull();
    expect(parseRecordId('govfam-cs-constitution--vabc')).toBeNull();
    expect(parseRecordId('govfam-zz-thing--v001')).toBeNull();
    expect(parseRecordId('')).toBeNull();
  });
});
