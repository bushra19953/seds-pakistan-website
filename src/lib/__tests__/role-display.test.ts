/**
 * Phase 1 Workstream A - the single display function (spec A.6) and the
 * reserved-title guard for customTitle.
 */
import { getRoleDisplayName, canonicalRoleTitle } from '../roles';
import {
  FOUNDER_DISPLAY_TITLE,
  isReservedTitle,
  CUSTOM_TITLE_MAX_LENGTH,
} from '../role-catalog';
import { FOUNDER_UID } from '@/config/founder';

const OTHER_UID = 'not-the-founder-uid';

describe('display-name (single function, A.6)', () => {
  it('the Founder UID renders the founder display title regardless of stored role', () => {
    expect(getRoleDisplayName('admin', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(getRoleDisplayName('superadmin', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(getRoleDisplayName('member', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
    expect(getRoleDisplayName('', FOUNDER_UID)).toBe(FOUNDER_DISPLAY_TITLE);
  });

  it('the founder display title is the one catalog constant', () => {
    expect(FOUNDER_DISPLAY_TITLE).toBe('Founder and Patron-in-Chief');
  });

  it('catalog keys render their catalog titles', () => {
    expect(getRoleDisplayName('president_national', OTHER_UID)).toBe('National President');
    expect(getRoleDisplayName('chapter_treasurer', OTHER_UID)).toBe('Chapter Treasurer');
    expect(getRoleDisplayName('member_basic', OTHER_UID)).toBe('Basic Member');
  });

  it('president_national on a non-founder renders National President, never Pakistan President or Chapter Advisor', () => {
    const title = getRoleDisplayName('president_national', OTHER_UID);
    expect(title).toBe('National President');
    expect(title).not.toBe('Pakistan President');
    expect(title).not.toBe('Chapter Advisor');
  });

  it('legacy tokens render their catalog target titles', () => {
    expect(getRoleDisplayName('superadmin', OTHER_UID)).toBe('Chief Technology Officer');
    expect(getRoleDisplayName('vice_president', OTHER_UID)).toBe('National Vice President');
    expect(getRoleDisplayName('treasurer', OTHER_UID)).toBe('Chapter Treasurer');
    expect(getRoleDisplayName('chair_marketing', OTHER_UID)).toBe('National Marketing Director');
  });

  it('admin on a non-founder renders Guest (founder handling is UID-scoped)', () => {
    expect(getRoleDisplayName('admin', OTHER_UID)).toBe('Guest');
  });

  it('unknown tokens, statuses-as-roles, empty and null input render Guest', () => {
    expect(getRoleDisplayName('national_vp_operations', OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName('team_member', OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName('', OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName(undefined as unknown as string, OTHER_UID)).toBe('Guest');
  });

  it('non-string role input renders Guest and never throws (junk-data guard)', () => {
    expect(() => getRoleDisplayName(42 as unknown as string, OTHER_UID)).not.toThrow();
    expect(getRoleDisplayName(42 as unknown as string, OTHER_UID)).toBe('Guest');
    expect(getRoleDisplayName({} as unknown as string, OTHER_UID)).toBe('Guest');
  });

  it('canonicalRoleTitle falls back to the raw token for unrecognized input', () => {
    expect(canonicalRoleTitle('president_national')).toBe('National President');
    expect(canonicalRoleTitle('')).toBe('Guest');
    expect(canonicalRoleTitle(null)).toBe('Guest');
  });
});

describe('reserved-titles (customTitle guard, A.6)', () => {
  it('catalog titles are reserved, compared case- and whitespace-insensitively', () => {
    expect(isReservedTitle('National President')).toBe(true);
    expect(isReservedTitle('national  president')).toBe(true);
    expect(isReservedTitle('Chapter Treasurer')).toBe(true);
    expect(isReservedTitle('Founder and Patron-in-Chief')).toBe(true);
  });

  it('office words are reserved', () => {
    expect(isReservedTitle('Founder')).toBe(true);
    expect(isReservedTitle('Governor')).toBe(true);
    expect(isReservedTitle('President')).toBe(true);
    expect(isReservedTitle('Pakistan President')).toBe(true);
    expect(isReservedTitle('Super Admin')).toBe(true);
  });

  it('a trailing parenthetical is stripped before comparison', () => {
    expect(isReservedTitle('National President (Acting)')).toBe(true);
  });

  it('patron / governor substrings are reserved', () => {
    expect(isReservedTitle('Honorary Patron')).toBe(true);
    expect(isReservedTitle('Deputy Governor Liaison')).toBe(true);
  });

  it('ordinary custom titles are not reserved', () => {
    expect(isReservedTitle('IST Chapter Lead, Outreach')).toBe(false);
    expect(isReservedTitle('CanSat Avionics Lead')).toBe(false);
    expect(isReservedTitle('')).toBe(false);
  });

  it('the unified customTitle max length is 80', () => {
    expect(CUSTOM_TITLE_MAX_LENGTH).toBe(80);
  });
});
