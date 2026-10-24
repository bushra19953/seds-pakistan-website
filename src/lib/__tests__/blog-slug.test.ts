/**
 * Unit tests for the shared blog slug resolution (src/lib/blog-slug.ts).
 *
 * The four contract cases come straight from the defect report:
 * (a) create via the form path with an empty slug yields the
 *     title-derived slug;
 * (b) edit-save of a slugless record fills the slug;
 * (c) edit-save of a slugged record leaves the slug untouched;
 * (d) create with an explicit slug keeps it.
 * The form pages and the REST routes all resolve through resolveBlogSlug,
 * so these cases pin the behavior of every write path at once.
 */

import { deriveBlogSlug, resolveBlogSlug } from '../blog-slug';

// The expression POST /api/blogs applied inline before the extraction.
// deriveBlogSlug must stay byte-identical to it for every title.
function historicalDerivation(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

describe('deriveBlogSlug', () => {
  it('matches the historical REST derivation on a battery of titles', () => {
    const titles = [
      'Guide Recheck Draft 2026-10-24',
      'Hello, World!',
      '  Multiple   Spaces  ',
      'C++ & Rockets: Part 2!',
      'Already-Slugged Title',
      'UpperCASE Title With Numbers 42',
      'Trailing punctuation!!!',
      '!!!',
      '',
      'a',
    ];
    for (const title of titles) {
      expect(deriveBlogSlug(title)).toBe(historicalDerivation(title));
    }
  });

  it('derives the expected slugs', () => {
    expect(deriveBlogSlug('Guide Recheck Draft 2026-10-24')).toBe(
      'guide-recheck-draft-2026-10-24',
    );
    expect(deriveBlogSlug('Hello, World!')).toBe('hello-world');
    expect(deriveBlogSlug('C++ & Rockets: Part 2!')).toBe('c-rockets-part-2');
  });
});

describe('resolveBlogSlug', () => {
  it('(a) create with an empty slug yields the title-derived slug', () => {
    expect(resolveBlogSlug('', 'Guide Recheck Draft 2026-10-24')).toBe(
      'guide-recheck-draft-2026-10-24',
    );
    expect(resolveBlogSlug(null, 'Hello World')).toBe('hello-world');
    expect(resolveBlogSlug(undefined, 'Hello World')).toBe('hello-world');
    expect(resolveBlogSlug('   ', 'Hello World')).toBe('hello-world');
  });

  it('(d) create with an explicit slug keeps it', () => {
    expect(resolveBlogSlug('my-custom-slug', 'Hello World')).toBe('my-custom-slug');
  });

  it('(b) edit-save of a slugless record fills the slug from the title', () => {
    // Stored records written by the old form create carry slug: null;
    // records from other paths may lack the field entirely.
    expect(resolveBlogSlug('', 'Stored Title', null)).toBe('stored-title');
    expect(resolveBlogSlug('', 'Stored Title', undefined)).toBe('stored-title');
    expect(resolveBlogSlug('', 'Stored Title', '')).toBe('stored-title');
  });

  it('(b) edit-save derives from the title being saved, not the old one', () => {
    expect(resolveBlogSlug('', 'Renamed Post', null)).toBe('renamed-post');
  });

  it('(c) edit-save of a slugged record leaves the slug untouched', () => {
    // The edit form round-trips the stored slug through the field.
    expect(resolveBlogSlug('existing-slug', 'Renamed Title', 'existing-slug')).toBe(
      'existing-slug',
    );
    // And if the field somehow arrives empty while the record has a slug,
    // the stored slug wins over deriving a new one from the title.
    expect(resolveBlogSlug('', 'Renamed Title', 'existing-slug')).toBe('existing-slug');
  });

  it('an explicit slug change on edit is honored', () => {
    expect(resolveBlogSlug('brand-new-slug', 'Title', 'old-slug')).toBe('brand-new-slug');
  });

  it('no slug, no stored slug, no title resolves to empty', () => {
    expect(resolveBlogSlug('', '')).toBe('');
    expect(resolveBlogSlug(null, null, null)).toBe('');
  });
});
