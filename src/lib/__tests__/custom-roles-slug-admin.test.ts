/**
 * Durable pins for the founder-token / R6 stem rules in
 * validateCustomSlug (contracts 1.1d + ADDENDUM R6): the founder
 * token 'admin' and remainders starting with founder, president or
 * superadmin are invalid even though they resolve to nothing known.
 * Companion pin: resolution-ai's T1 deviation pin D1.
 */
import { validateCustomSlug } from '@/lib/custom-roles';

describe('validateCustomSlug - founder token + R6 stems', () => {
  it.each([
    'custom_admin', // contracts 1.1d: founder token remainder
    'custom_founder_assistant', // R6 stem: founder
    'custom_president_assistant', // R6 stem: president
    'custom_superadmin_ops', // R6 stem: superadmin
    'custom_president_national', // already rejected (catalog key)
    'custom_superadmin', // already rejected (legacy token)
    'custom_chapter_design_chair', // already rejected (catalog key)
  ])('rejects %s', (slug) => {
    expect(validateCustomSlug(slug).ok).toBe(false);
  });

  it('still accepts a lawful custom slug', () => {
    expect(validateCustomSlug('custom_poster_team_lead')).toEqual({ ok: true });
  });
});
