/**
 * privacy.test.ts — spec section 5 (Privacy Shielding).
 *
 * Covers the masking helpers and role gating used across directory views.
 */

import {
  maskPhone,
  maskEmail,
  canUnmaskContacts,
  defaultPublicDirectoryOptIn,
  resolvePublicDirectoryOptIn,
  PUBLIC_DIRECTORY_OPT_IN_FIELD,
} from '@/lib/privacy';

describe('PUBLIC_DIRECTORY_OPT_IN_FIELD', () => {
  it('uses exactly the field name the profile hub expects', () => {
    expect(PUBLIC_DIRECTORY_OPT_IN_FIELD).toBe('publicDirectoryOptIn');
  });
});

describe('maskPhone', () => {
  it('masks a full Pakistani number keeping prefix and last three digits', () => {
    expect(maskPhone('+92 331 0451655')).toBe('+92 331 ••••655');
  });

  it('masks a number without a plus sign the same way', () => {
    expect(maskPhone('0331 0451655')).toBe('03 310 •••655');
  });

  it('never reveals the last three digits verbatim requirement', () => {
    const masked = maskPhone('+92 331 0451655');
    expect(masked).toContain('655');
    expect(masked).not.toContain('0451655');
  });

  it('handles empty, null and undefined values', () => {
    expect(maskPhone('')).toBe('—');
    expect(maskPhone(null)).toBe('—');
    expect(maskPhone(undefined)).toBe('—');
  });

  it('fully masks very short numbers', () => {
    expect(maskPhone('1234')).not.toContain('1234');
  });
});

describe('maskEmail', () => {
  it('masks the local part keeping a prefix and the domain', () => {
    expect(maskEmail('ahmedalikamran44@gmail.com')).toBe('ahmed***@gmail.com');
  });

  it('keeps the domain intact', () => {
    expect(maskEmail('za@gmail.com')).toContain('@gmail.com');
  });

  it('does not expose the full local part', () => {
    const masked = maskEmail('ahmedalikamran44@gmail.com');
    expect(masked).not.toContain('ahmedalikamran44');
  });

  it('handles empty, null and malformed values', () => {
    expect(maskEmail('')).toBe('—');
    expect(maskEmail(null)).toBe('—');
    expect(maskEmail('not-an-email')).not.toContain('not-an-email');
  });
});

describe('canUnmaskContacts', () => {
  it('allows presidents', () => {
    expect(canUnmaskContacts('president_national')).toBe(true);
    expect(canUnmaskContacts('chapter_president')).toBe(true);
  });

  it('allows chairs (which normalize to VP / *_chair roles)', () => {
    expect(canUnmaskContacts('chair_events')).toBe(true); // -> national_vp_operations
    expect(canUnmaskContacts('chair_marketing')).toBe(true); // -> national_vp_marketing
    expect(canUnmaskContacts('chair_design')).toBe(true); // -> chapter_design_chair
  });

  it('allows superadmin and developer', () => {
    expect(canUnmaskContacts('superadmin')).toBe(true);
    expect(canUnmaskContacts('developer')).toBe(true);
  });

  it('denies members, applicants and guests', () => {
    expect(canUnmaskContacts('member')).toBe(false);
    expect(canUnmaskContacts('team_member')).toBe(false);
    expect(canUnmaskContacts('applicant')).toBe(false);
    expect(canUnmaskContacts('guest')).toBe(false);
    expect(canUnmaskContacts(null)).toBe(false);
  });
});

describe('defaultPublicDirectoryOptIn', () => {
  it('defaults executives in', () => {
    expect(defaultPublicDirectoryOptIn('president_national')).toBe(true);
    expect(defaultPublicDirectoryOptIn('chapter_president')).toBe(true);
    expect(defaultPublicDirectoryOptIn('vice_president')).toBe(true);
    expect(defaultPublicDirectoryOptIn('chair_design')).toBe(true);
  });

  it('defaults everyone else out', () => {
    expect(defaultPublicDirectoryOptIn('member')).toBe(false);
    expect(defaultPublicDirectoryOptIn('team_member')).toBe(false);
    expect(defaultPublicDirectoryOptIn(null)).toBe(false);
  });
});

describe('resolvePublicDirectoryOptIn', () => {
  it('an explicit stored boolean always wins over the role default', () => {
    expect(
      resolvePublicDirectoryOptIn({ publicDirectoryOptIn: true, role: 'member' })
    ).toBe(true);
    expect(
      resolvePublicDirectoryOptIn({ publicDirectoryOptIn: false, role: 'president_national' })
    ).toBe(false);
  });

  it('falls back to the role default when the field is unset', () => {
    expect(resolvePublicDirectoryOptIn({ role: 'chapter_president' })).toBe(true);
    expect(resolvePublicDirectoryOptIn({ role: 'member' })).toBe(false);
    expect(resolvePublicDirectoryOptIn(null)).toBe(false);
  });
});
