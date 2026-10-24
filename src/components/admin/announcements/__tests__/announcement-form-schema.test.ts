/**
 * Behavioural tests for the announcement form schema (known-issues
 * content Issues 3 and 10):
 * - ctaLink: "" and an omitted link save fine, site-relative paths like
 *   /apply are accepted, absolute URLs are accepted, and malformed
 *   non-empty values still fail with the historical field message.
 * - audience: the schema default is "public", the retired stored value
 *   "all" is not a legal form value, and the form's default seed maps
 *   out-of-enum initials to "public" (seed asserted on source, matching
 *   this repo's convention of source-text assertions for this form).
 */
import * as fs from 'fs';
import * as path from 'path';
import { announcementSchema } from '../announcement-form';

const baseValues = {
  title: 'Applications are now closed',
  content: 'Thank you for the overwhelming response.',
  ctaText: '',
  ctaLink: '',
};

describe('announcement form schema - ctaLink (Issue 3)', () => {
  it('accepts an empty CTA link (no CTA wanted)', () => {
    const parsed = announcementSchema.parse({ ...baseValues, ctaLink: '' });
    expect(parsed.ctaLink).toBe('');
  });

  it('accepts an omitted CTA link', () => {
    const { ctaLink: _omit, ...rest } = baseValues;
    const parsed = announcementSchema.parse(rest);
    expect(parsed.ctaLink).toBeUndefined();
  });

  it('accepts a site-relative CTA link', () => {
    const parsed = announcementSchema.parse({
      ...baseValues,
      ctaText: 'Apply Now',
      ctaLink: '/apply',
    });
    expect(parsed.ctaLink).toBe('/apply');
  });

  it('accepts an absolute CTA link', () => {
    const parsed = announcementSchema.parse({
      ...baseValues,
      ctaText: 'Apply Now',
      ctaLink: 'https://example.com',
    });
    expect(parsed.ctaLink).toBe('https://example.com');
  });

  it('rejects a malformed non-empty CTA link with the field message', () => {
    const result = announcementSchema.safeParse({
      ...baseValues,
      ctaText: 'Apply Now',
      ctaLink: 'not a url',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join('.') === 'ctaLink',
      );
      expect(issue?.message).toBe('Provide a valid URL');
    }
  });
});

describe('announcement form schema - audience (Issue 10)', () => {
  it('defaults audience to "public" when omitted', () => {
    const parsed = announcementSchema.parse(baseValues);
    expect(parsed.audience).toBe('public');
  });

  it('accepts every enum audience', () => {
    for (const audience of ['public', 'members', 'officers'] as const) {
      expect(announcementSchema.parse({ ...baseValues, audience }).audience).toBe(
        audience,
      );
    }
  });

  it('rejects the retired stored value "all"', () => {
    const result = announcementSchema.safeParse({
      ...baseValues,
      audience: 'all',
    });
    expect(result.success).toBe(false);
  });

  it('the form seeds out-of-enum initial audiences as "public", never "all"', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'announcement-form.tsx'),
      'utf8',
    );
    expect(src).not.toContain('|| "all"');
  });
});
