/** F.8 permission matrix for the cadetship gates in src/lib/permissions.ts. */

import { canManageCadetships, canViewCadetships } from '../permissions';

describe('canManageCadetships', () => {
  it('NMD manages everywhere', () => {
    expect(canManageCadetships('national_membership_director')).toBe(true);
    expect(
      canManageCadetships('national_membership_director', { cadetshipChapterId: 'any' }),
    ).toBe(true);
  });

  it('chapter president manages ONLY their own chapter', () => {
    expect(
      canManageCadetships('chapter_president', { callerChapterId: 'ist', cadetshipChapterId: 'ist' }),
    ).toBe(true);
    expect(
      canManageCadetships('chapter_president', { callerChapterId: 'ist', cadetshipChapterId: 'khi' }),
    ).toBe(false);
  });

  it('founder manages via the founder flag', () => {
    expect(canManageCadetships(null, { isFounder: true })).toBe(true);
    expect(canManageCadetships(null)).toBe(false);
  });

  it('oversight roles cannot manage', () => {
    expect(canManageCadetships('national_general_secretary')).toBe(false);
    expect(canManageCadetships('national_audit_compliance_chair')).toBe(false);
    expect(canManageCadetships('member')).toBe(false);
  });
});

describe('canViewCadetships', () => {
  it('NGS and Audit Chair are read-only viewers', () => {
    expect(canViewCadetships('national_general_secretary')).toBe(true);
    expect(canViewCadetships('national_audit_compliance_chair')).toBe(true);
    expect(canManageCadetships('national_general_secretary')).toBe(false);
  });

  it('a plain member cannot view the roster', () => {
    expect(canViewCadetships('member', { cadetshipChapterId: 'ist' })).toBe(false);
  });
});
