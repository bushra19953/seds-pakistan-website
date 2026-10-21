/**
 * Suite G-core: appointment letter adapter (spec G.5.2/G.9).
 * The adapter is pure: the snapshot freezes register + taxonomy values,
 * and renderer data is assembled from the snapshot ONLY, so a later
 * register change can never move an issued letter.
 */

import {
  REGISTRATION_STATUS_LINE_IN_PROCESS,
  appointmentToLetterData,
  buildLetterSnapshot,
  letterDataFromSnapshot,
} from '@/lib/appointment-letter-adapter';
import type {
  AppointmentInstrument,
  RegisterRecord,
  RoleTaxonomyEntry,
} from '@/types/appointment-instrument';

const LONG_NAME =
  'Muhammad Alexander Christopher Jonathan Smith al-Rashid bin Abdullah';

function registerFixture(overrides: Partial<RegisterRecord> = {}): RegisterRecord {
  return {
    roleHistoryId: 'rh-1',
    positionId: 'pos-1',
    appointeeUid: 'uid-appointee',
    appointeeDisplayName: LONG_NAME,
    roleKey: 'national_treasurer',
    chapterId: null,
    chapterName: null,
    appointedByUid: 'founder-uid',
    appointedByDisplayName: 'Muhammad Zubair Mongol',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    appointedAtMs: Date.parse('2026-10-01T04:00:00.000Z'),
    effectiveFromMs: Date.parse('2026-10-01T04:00:00.000Z'),
    backdateReason: null,
    ...overrides,
  };
}

function taxonomyFixture(overrides: Partial<RoleTaxonomyEntry> = {}): RoleTaxonomyEntry {
  return {
    roleKey: 'national_treasurer',
    displayName: 'National Treasurer',
    category: 'B',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    ratificationRequired: true,
    catalogReference: 'Role Catalog 6.1',
    termEndsAtMs: null,
    ...overrides,
  };
}

describe('buildLetterSnapshot', () => {
  it('freezes register + taxonomy values verbatim, long names included', () => {
    const snapshot = buildLetterSnapshot({
      instrumentId: 'inst1',
      verificationCode: 'SEDS-PK-APT-ABC23',
      record: registerFixture(),
      taxonomy: taxonomyFixture(),
      appointeeDisplayName: LONG_NAME,
      issuedAtMs: Date.parse('2026-10-02T04:00:00.000Z'),
    });
    expect(snapshot.instrumentNumber).toBe('APT-inst1');
    expect(snapshot.appointeeName).toBe(LONG_NAME);
    expect(snapshot.appointedByName).toBe('Muhammad Zubair Mongol');
    expect(snapshot.appointedByOffice).toBe('Founder');
    expect(snapshot.authorityReference).toBe('Constitution 7.3; Role Catalog 6.1');
    expect(snapshot.appointedAtIso).toBe('2026-10-01T04:00:00.000Z');
    expect(snapshot.effectiveFromIso).toBe('2026-10-01T04:00:00.000Z');
    expect(snapshot.ratificationRequired).toBe(true);
    expect(snapshot.registrationStatusLine).toBe(
      REGISTRATION_STATUS_LINE_IN_PROCESS,
    );
    expect(snapshot.registrationStatusLine).toContain('currently in process');
    expect(snapshot.registrationStatusLine).not.toMatch(/registered society/i);
  });

  it('carries a null term for at-pleasure offices', () => {
    const snapshot = buildLetterSnapshot({
      instrumentId: 'inst2',
      verificationCode: 'SEDS-PK-APT-ABC23',
      record: registerFixture(),
      taxonomy: taxonomyFixture({ termEndsAtMs: null }),
      appointeeDisplayName: 'A Person',
      issuedAtMs: Date.parse('2026-10-02T04:00:00.000Z'),
    });
    expect(snapshot.termEndsAtIso).toBeNull();
  });

  it('carries the fixed term when the taxonomy sets one', () => {
    const snapshot = buildLetterSnapshot({
      instrumentId: 'inst3',
      verificationCode: 'SEDS-PK-APT-ABC23',
      record: registerFixture(),
      taxonomy: taxonomyFixture({
        termEndsAtMs: Date.parse('2029-10-01T04:00:00.000Z'),
      }),
      appointeeDisplayName: 'A Person',
      issuedAtMs: Date.parse('2026-10-02T04:00:00.000Z'),
    });
    expect(snapshot.termEndsAtIso).toBe('2029-10-01T04:00:00.000Z');
  });
});

describe('appointmentToLetterData', () => {
  function instrumentFromSnapshot(): AppointmentInstrument {
    const snapshot = buildLetterSnapshot({
      instrumentId: 'inst1',
      verificationCode: 'SEDS-PK-APT-ABC23',
      record: registerFixture(),
      taxonomy: taxonomyFixture(),
      appointeeDisplayName: LONG_NAME,
      issuedAtMs: Date.parse('2026-10-02T04:00:00.000Z'),
    });
    return {
      id: 'inst1',
      roleHistoryId: 'rh-1',
      positionId: 'pos-1',
      appointeeUid: 'uid-appointee',
      appointeeDisplayName: LONG_NAME,
      roleKey: 'national_treasurer',
      roleDisplayName: 'National Treasurer',
      chapterId: null,
      category: 'B',
      appointedByUid: 'founder-uid',
      appointedByDisplayName: 'Muhammad Zubair Mongol',
      appointedByOffice: 'Founder',
      authorityReference: 'Constitution 7.3; Role Catalog 6.1',
      appointedAt: null as never,
      effectiveFrom: null as never,
      backdateReason: null,
      termEndsAt: null,
      ratificationRequired: true,
      ratificationState: 'pending_ratification',
      ratificationDeadline: null,
      ratificationDecisionId: null,
      letter: {
        status: 'issued',
        generatedAt: null as never,
        generatedByUid: 'admin-uid',
        templateVersion: 'appointment-letter-v1',
        verificationCode: 'SEDS-PK-APT-ABC23',
        contentHash: 'abcdef0123456789'.repeat(4),
        snapshot,
        driveFileId: null,
        driveWebViewLink: null,
        fileName: null,
        sizeBytes: null,
      },
      acceptance: { status: 'awaiting_upload' },
      supersededByInstrumentId: null,
      supersedesInstrumentId: null,
      createdAt: null as never,
      updatedAt: null as never,
      createdByUid: 'admin-uid',
    };
  }

  it('assembles renderer data from the snapshot only', () => {
    const instrument = instrumentFromSnapshot();
    const data = appointmentToLetterData(
      instrument,
      'https://sedspakistan.live/verify-appointment/SEDS-PK-APT-ABC23',
    );
    expect(data.appointeeName).toBe(LONG_NAME);
    expect(data.verificationCode).toBe('SEDS-PK-APT-ABC23');
    expect(data.contentHashShort).toBe('abcdef0123456789');
    expect(data.effectiveFromLine).toBe('1 October 2026');
    expect(data.termEndsAtLine).toBeNull();
    expect(data.ratificationRequired).toBe(true);
  });

  it('throws when the instrument has no issued letter', () => {
    const instrument = instrumentFromSnapshot();
    instrument.letter = null;
    expect(() =>
      appointmentToLetterData(instrument, 'https://example.invalid/x'),
    ).toThrow(/no issued letter snapshot/);
  });

  it('letterDataFromSnapshot omits the term line when termEndsAt is null', () => {
    const snapshot = buildLetterSnapshot({
      instrumentId: 'inst9',
      verificationCode: 'SEDS-PK-APT-ABC23',
      record: registerFixture(),
      taxonomy: taxonomyFixture(),
      appointeeDisplayName: 'A Person',
      issuedAtMs: Date.parse('2026-10-02T04:00:00.000Z'),
    });
    const data = letterDataFromSnapshot(snapshot, 'https://x.invalid/v', 'f'.repeat(64));
    expect(data.termEndsAtLine).toBeNull();
  });
});
