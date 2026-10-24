/**
 * Sign-in role backfill decision (pure).
 *
 * The Google sign-in form writes role: 'member_basic' only when it CREATES
 * the users doc. Accounts whose users doc was created earlier by another
 * writer (application-status mirror, profile route, hierarchy
 * shell-create) carry neither `role` nor `displayRole`, and the sign-in
 * merge write never filled the gap, leaving ~95 of ~200 accounts with no
 * recorded role (they only work because every check treats a missing
 * role as member).
 *
 * memberRoleBackfill(existingData) returns { role: 'member_basic' } when
 * the existing doc has NEITHER field set, and {} otherwise. It never
 * overwrites or downgrades an existing role/displayRole value, and it
 * returns {} for a missing doc (undefined/null) because the create
 * payload already carries role: 'member_basic'. The default is
 * member_basic (Basic Member), never 'member': in the role catalog
 * 'member' is Full Member (general_body_powers), which is promotion-only
 * and must never be stamped on an unadmitted account.
 */
export function memberRoleBackfill(
  existingData: Record<string, unknown> | null | undefined,
): { role: 'member_basic' } | Record<string, never> {
  if (!existingData) return {};
  if (isRoleValueSet(existingData.role) || isRoleValueSet(existingData.displayRole)) {
    return {};
  }
  return { role: 'member_basic' };
}

function isRoleValueSet(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null;
}
