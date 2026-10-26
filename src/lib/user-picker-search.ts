/**
 * Shared search matching for the people pickers (Zubair requirement,
 * 2026-10-26; audit TS-P30).
 *
 * Every people picker in the task flows (assignee, reviewer, workflow
 * step primary + co-assignees) answers the same question — "does this
 * person match what the admin typed?" — and they must all answer it
 * the same way: by display name, by EMAIL, and by ROLE, so a person
 * can be found by the address or the role the admin actually knows,
 * and two people who share a name stop being indistinguishable.
 *
 * Matching semantics mirror the components' long-standing name rule:
 * case-insensitive substring. Role matching accepts the query in any
 * of the forms an admin would type it — slug ("chapter_president"),
 * spaced slug ("chapter president"), or display title ("Chapter
 * President") — against the primary role and every additionalRoles
 * entry.
 */

import { getRoleDisplayName } from '@/lib/roles';

/** Same normalization the comboboxes already apply to role strings. */
export function normalizePickerRoleSlug(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function pickerRoleMatchesQuery(
  role: string | null | undefined,
  rawQuery: string,
): boolean {
  const q = (rawQuery || '').trim().toLowerCase();
  if (!role || !q) return false;
  const slug = normalizePickerRoleSlug(role);
  if (!slug) return false;
  // Slug form: "president" in "president_chapter"; the query is
  // slugified too, so "events chair" -> "events_chair" also matches
  // inside "chapter_events_chair".
  const qSlug = normalizePickerRoleSlug(q);
  if (qSlug && slug.includes(qSlug)) return true;
  // Spaced-slug form: "chapter president" in "chapter president".
  if (slug.replace(/_/g, ' ').includes(q)) return true;
  // Raw stored string (covers spellings the normalizer rewrites).
  if (String(role).toLowerCase().includes(q)) return true;
  // Display title: "Chapter President". The 'Guest' fallback (unknown
  // or custom slugs without a definition at hand) is NOT a title and
  // must never make every custom role match a search for "guest".
  const display = getRoleDisplayName(role as never);
  if (display && display !== 'Guest' && display.toLowerCase().includes(q)) return true;
  return false;
}

export type PickerSearchableUser = {
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  additionalRoles?: string[] | null;
};

export function pickerUserMatchesQuery(
  user: PickerSearchableUser,
  rawQuery: string,
): boolean {
  const q = (rawQuery || '').trim().toLowerCase();
  if (!q) return false;
  if ((user.displayName || '').toLowerCase().includes(q)) return true;
  if ((user.email || '').toLowerCase().includes(q)) return true;
  if (pickerRoleMatchesQuery(user.role, q)) return true;
  return (user.additionalRoles || []).some((r) => pickerRoleMatchesQuery(r, q));
}
