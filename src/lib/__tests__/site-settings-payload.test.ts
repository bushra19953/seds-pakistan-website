/**
 * Payload-builder tests for settings/siteWide (parity table section 6).
 * Fixtures and expectations are the harness values verbatim from
 * feat/supa-admin-6 (SITEWIDE_STATE / SITEWIDE_STUDENTS_COUNT in
 * admin-parity-fixtures.ts; oracle builders in admin-parity.test.ts),
 * inlined because that branch is not on this tree.
 */
import { createSiteWidePayload, buildSiteWideSave } from '@/lib/site-settings-payload';

const SITEWIDE_STATE: Record<string, any> = {
  studentsEngaged: 9999, // ignored on save: dynamic users count wins
  activeProjects: 12,
  partners: 4,
  globalChapters: 0, // falsy -> saved as 25
  contactFormDestinationEmail: 'hello@example.com',
  bugReportEmail: 'bugs@example.com',
  enableDonations: true,
  enableChapterRegistration: undefined,
  registrationStatus: 'registered',
  registrationNumber: 'ICT-123',
  registrationDate: '2026-01-15',
  registrarJurisdiction: 'Islamabad',
  siteEnabled: undefined, // !== false -> true
  maintenanceMode: undefined, // === true -> false
  evilExtraField: 'must not persist',
};
const SITEWIDE_STUDENTS_COUNT = 42;

describe('createSiteWidePayload', () => {
  it('matches the harness creation payload verbatim', () => {
    const created = createSiteWidePayload(SITEWIDE_STUDENTS_COUNT, 'admin-1');
    expect(created).toEqual({
      studentsEngaged: 42,
      activeProjects: 0,
      partners: 0,
      globalChapters: 25,
      contactFormDestinationEmail: '',
      enableDonations: false,
      enableChapterRegistration: false,
      registrationStatus: 'in_process',
      registrationNumber: '',
      registrationDate: '',
      registrarJurisdiction: '',
      updatedBy: 'admin-1',
    });
  });

  it('omits bugReportEmail, siteEnabled and maintenanceMode at creation', () => {
    const created = createSiteWidePayload(SITEWIDE_STUDENTS_COUNT, 'admin-1') as Record<
      string,
      unknown
    >;
    expect('bugReportEmail' in created).toBe(false);
    expect('siteEnabled' in created).toBe(false);
    expect('maintenanceMode' in created).toBe(false);
    expect('updatedAt' in created).toBe(false); // caller adds serverTimestamp()
  });

  it("falls back to 'system' when uid is empty", () => {
    expect(createSiteWidePayload(0, '').updatedBy).toBe('system');
  });
});

describe('buildSiteWideSave', () => {
  it('matches the harness save whitelist verbatim, with all traps', () => {
    const saved = buildSiteWideSave(SITEWIDE_STATE, SITEWIDE_STUDENTS_COUNT, 'admin-1');
    expect(saved).toEqual({
      studentsEngaged: 42, // not 9999: dynamic count wins
      activeProjects: 12,
      partners: 4,
      globalChapters: 25, // 0 -> || 25
      contactFormDestinationEmail: 'hello@example.com',
      bugReportEmail: 'bugs@example.com',
      enableDonations: true,
      enableChapterRegistration: false, // undefined -> || false
      registrationStatus: 'registered',
      registrationNumber: 'ICT-123',
      registrationDate: '2026-01-15',
      registrarJurisdiction: 'Islamabad',
      siteEnabled: true, // undefined !== false
      maintenanceMode: false, // undefined !== true
      updatedBy: 'admin-1',
    });
    expect('evilExtraField' in saved).toBe(false);
    expect('updatedAt' in saved).toBe(false); // caller adds serverTimestamp()
    // exactly 14 whitelist fields + updatedBy
    expect(Object.keys(saved)).toHaveLength(15);
  });

  it('preserves explicit switch values (siteEnabled false, maintenanceMode true)', () => {
    const saved = buildSiteWideSave(
      { ...SITEWIDE_STATE, siteEnabled: false, maintenanceMode: true },
      SITEWIDE_STUDENTS_COUNT,
      'admin-1',
    );
    expect(saved.siteEnabled).toBe(false);
    expect(saved.maintenanceMode).toBe(true);
  });
});
