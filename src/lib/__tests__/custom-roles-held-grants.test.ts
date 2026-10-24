/**
 * heldCustomRoleSlugs: the client mirror of the server's
 * resolveHolderRoles — which custom_ slugs a roles/{uid} doc actually
 * grants its holder right now. This is the provider logic that feeds
 * the authorization hook and the admin sidebar: a slug returned here
 * gets its definition's permissions injected under its own slug; a
 * slug NOT returned here contributes nothing.
 */

import { heldCustomRoleSlugs } from '@/lib/custom-roles';

const NOW = new Date('2026-10-24T00:00:00.000Z');

describe('heldCustomRoleSlugs', () => {
  it('returns a held custom slug from additionalRoles', () => {
    expect(
      heldCustomRoleSlugs(
        { additionalRoles: ['custom_blog_editor'] },
        'member_basic',
        NOW,
      ),
    ).toEqual(['custom_blog_editor']);
  });

  it('ignores catalog entries, non-strings, and duplicates', () => {
    expect(
      heldCustomRoleSlugs(
        {
          additionalRoles: [
            'president_national',
            'custom_blog_editor',
            'custom_blog_editor',
            42,
            null,
          ],
        },
        'member_basic',
        NOW,
      ),
    ).toEqual(['custom_blog_editor']);
  });

  it('never returns the primary role itself', () => {
    expect(
      heldCustomRoleSlugs(
        { additionalRoles: ['custom_blog_editor'] },
        'custom_blog_editor',
        NOW,
      ),
    ).toEqual([]);
  });

  it('drops the pending-expiry grant once it has expired', () => {
    expect(
      heldCustomRoleSlugs(
        {
          additionalRoles: ['custom_blog_editor'],
          expiresRoleKey: 'custom_blog_editor',
          expiresAt: '2026-10-01T00:00:00.000Z',
        },
        'member_basic',
        NOW,
      ),
    ).toEqual([]);
  });

  it('keeps a grant that is expiring but not yet expired', () => {
    expect(
      heldCustomRoleSlugs(
        {
          additionalRoles: ['custom_blog_editor'],
          expiresRoleKey: 'custom_blog_editor',
          expiresAt: '2026-10-25T00:00:00.000Z',
        },
        'member_basic',
        NOW,
      ),
    ).toEqual(['custom_blog_editor']);
  });

  it('fails closed on an unparseable expiresAt naming this slug', () => {
    expect(
      heldCustomRoleSlugs(
        {
          additionalRoles: ['custom_blog_editor'],
          expiresRoleKey: 'custom_blog_editor',
          expiresAt: 'not-a-date',
        },
        'member_basic',
        NOW,
      ),
    ).toEqual([]);
  });

  it("an expiry recorded for a different slug does not drop this grant", () => {
    expect(
      heldCustomRoleSlugs(
        {
          additionalRoles: ['custom_blog_editor', 'custom_event_helper'],
          expiresRoleKey: 'custom_event_helper',
          expiresAt: '2026-10-01T00:00:00.000Z',
        },
        'member_basic',
        NOW,
      ),
    ).toEqual(['custom_blog_editor']);
  });

  it('returns [] when additionalRoles is missing or not a list', () => {
    expect(heldCustomRoleSlugs({}, 'member_basic', NOW)).toEqual([]);
    expect(
      heldCustomRoleSlugs(
        { additionalRoles: 'custom_blog_editor' },
        'member_basic',
        NOW,
      ),
    ).toEqual([]);
  });
});
