/**
 * Suite G-core: instrument codes + content hash (spec G.5.3).
 * The canonical key order is part of the hash contract; the salt is
 * G's own env and a missing salt must throw (fail closed), never fall
 * back to an unsalted hash.
 */

import {
  MisconfiguredError,
  canonicalInstrumentJson,
  computeInstrumentContentHash,
  generateInstrumentCode,
  hashPayloadFromSnapshot,
  isValidInstrumentCode,
  requireInstrumentSalt,
  verifyInstrumentContentHash,
  type InstrumentHashPayload,
} from '@/lib/appointments/hash';
import type { LetterSnapshot } from '@/types/appointment-instrument';

const SALT = 'test-instrument-salt-0123456789abcdef';

const PAYLOAD: InstrumentHashPayload = {
  instrumentNumber: 'APT-abc123',
  appointeeName: 'Ayesha Khan',
  roleKey: 'national_treasurer',
  roleDisplayName: 'National Treasurer',
  chapterId: null,
  appointedByUid: 'founder-uid',
  appointedByOffice: 'Founder',
  authorityReference: 'Constitution 7.3; Role Catalog 6.1',
  appointedAtIso: '2026-10-01T04:00:00.000Z',
  effectiveFromIso: '2026-10-01T04:00:00.000Z',
  termEndsAtIso: null,
  templateVersion: 'appointment-letter-v1',
};

describe('generateInstrumentCode', () => {
  it('produces SEDS-PK-APT-XXXXX codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInstrumentCode();
      expect(isValidInstrumentCode(code)).toBe(true);
      expect(code).not.toMatch(/[01IO]/);
    }
  });
});

describe('canonical JSON + content hash', () => {
  it('serializes in exactly the G.5.3 key order', () => {
    const json = canonicalInstrumentJson(PAYLOAD);
    const keys = [...json.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    expect(keys).toEqual([
      'instrumentNumber',
      'appointeeName',
      'roleKey',
      'roleDisplayName',
      'chapterId',
      'appointedByUid',
      'appointedByOffice',
      'authorityReference',
      'appointedAtIso',
      'effectiveFromIso',
      'termEndsAtIso',
      'templateVersion',
    ]);
  });

  it('is deterministic and salt-sensitive', () => {
    const a = computeInstrumentContentHash(PAYLOAD, SALT);
    const b = computeInstrumentContentHash(PAYLOAD, SALT);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(computeInstrumentContentHash(PAYLOAD, 'another-salt')).not.toBe(a);
  });

  it('changes when any covered field changes', () => {
    const base = computeInstrumentContentHash(PAYLOAD, SALT);
    expect(
      computeInstrumentContentHash({ ...PAYLOAD, appointeeName: 'Other' }, SALT),
    ).not.toBe(base);
    expect(
      computeInstrumentContentHash({ ...PAYLOAD, termEndsAtIso: '2029-10-01T00:00:00.000Z' }, SALT),
    ).not.toBe(base);
  });

  it('verify accepts the matching hash and rejects others', () => {
    const hash = computeInstrumentContentHash(PAYLOAD, SALT);
    expect(verifyInstrumentContentHash(hash, PAYLOAD, SALT)).toBe(true);
    expect(verifyInstrumentContentHash('0'.repeat(64), PAYLOAD, SALT)).toBe(false);
    expect(verifyInstrumentContentHash('garbage', PAYLOAD, SALT)).toBe(false);
    expect(verifyInstrumentContentHash('', PAYLOAD, SALT)).toBe(false);
  });

  it('hashPayloadFromSnapshot projects the frozen snapshot fields', () => {
    const snapshot: LetterSnapshot = {
      instrumentNumber: 'APT-abc123',
      verificationCode: 'SEDS-PK-APT-XYZ23',
      appointeeName: 'Ayesha Khan',
      roleKey: 'national_treasurer',
      roleDisplayName: 'National Treasurer',
      chapterId: null,
      chapterName: null,
      appointedByName: 'Muhammad Zubair Mongol',
      appointedByOffice: 'Founder',
      authorityReference: 'Constitution 7.3; Role Catalog 6.1',
      appointedAtIso: '2026-10-01T04:00:00.000Z',
      effectiveFromIso: '2026-10-01T04:00:00.000Z',
      termEndsAtIso: null,
      issuedAtIso: '2026-10-02T04:00:00.000Z',
      ratificationRequired: true,
      catalogReference: 'Role Catalog 6.1',
      registrationStatusLine: 'in process',
      statusLine: null,
    };
    expect(hashPayloadFromSnapshot(snapshot, 'founder-uid')).toEqual(PAYLOAD);
  });
});

describe('salt handling', () => {
  const ENV = 'APPOINTMENT_INSTRUMENT_SALT';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('throws MisconfiguredError when the salt env is unset', () => {
    delete process.env[ENV];
    expect(() => requireInstrumentSalt()).toThrow(MisconfiguredError);
    expect(() => computeInstrumentContentHash(PAYLOAD)).toThrow(
      MisconfiguredError,
    );
  });

  it('uses the env salt when no explicit salt is passed', () => {
    process.env[ENV] = SALT;
    expect(requireInstrumentSalt()).toBe(SALT);
    expect(computeInstrumentContentHash(PAYLOAD)).toBe(
      computeInstrumentContentHash(PAYLOAD, SALT),
    );
  });
});
