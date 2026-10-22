/**
 * Consents hub tab logic (the /admin/consents combine): ?tab= deep
 * links from the retired inbox/register routes must resolve to the
 * right tab, unknown values must fall back to My Requests, and tab
 * triggers must be visible only to the roles the underlying APIs
 * serve (Founder for the decision queue; Founder / National General
 * Secretary for the Register).
 */

import {
  resolveConsentHubTab,
  toCatalogRoleKey,
  visibleConsentHubTabs,
} from '../hub-tabs';

describe('resolveConsentHubTab', () => {
  it.each([
    ['my', 'my'],
    ['awaiting', 'awaiting'],
    ['register', 'register'],
  ])('maps ?tab=%s to the %s tab', (raw, expected) => {
    expect(resolveConsentHubTab(raw)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['inbox'], ['MY'], ['decided']])(
    'falls back to My Requests for %p',
    (raw) => {
      expect(resolveConsentHubTab(raw as string | null)).toBe('my');
    },
  );
});

describe('toCatalogRoleKey', () => {
  it('maps the legacy general_secretary token to the catalog key', () => {
    expect(toCatalogRoleKey('general_secretary')).toBe('national_general_secretary');
  });

  it('passes a catalog key through unchanged', () => {
    expect(toCatalogRoleKey('national_general_secretary')).toBe('national_general_secretary');
  });

  it('passes unknown values through and keeps null null', () => {
    expect(toCatalogRoleKey('member')).toBe('member');
    expect(toCatalogRoleKey(null)).toBeNull();
    expect(toCatalogRoleKey(undefined)).toBeNull();
  });
});

describe('visibleConsentHubTabs', () => {
  it('shows the Founder every tab', () => {
    expect(visibleConsentHubTabs({ isFounder: true, catalogRoleKey: 'chief_technology_officer' })).toEqual([
      'my',
      'awaiting',
      'register',
    ]);
  });

  it('shows the National General Secretary My Requests and the Register, not the decision queue', () => {
    expect(
      visibleConsentHubTabs({ isFounder: false, catalogRoleKey: 'national_general_secretary' }),
    ).toEqual(['my', 'register']);
  });

  it('shows other admins My Requests only', () => {
    expect(visibleConsentHubTabs({ isFounder: false, catalogRoleKey: 'chapter_president' })).toEqual([
      'my',
    ]);
    expect(visibleConsentHubTabs({ isFounder: false, catalogRoleKey: null })).toEqual(['my']);
  });
});
