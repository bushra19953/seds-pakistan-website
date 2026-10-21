/**
 * Board register authorization (Phase 2, spec C.3/C.7).
 *
 * READERS of the full register: the Founder (by UID), the National General
 * Secretary, the Founder Patron, and seated Governors (governor_* roles).
 * Deliberately NOT readers: everyone else with admin access - canAccessAdmin
 * does NOT grant register read (spec C.7 case 23: the CTO alone gets 403).
 * The public sees only the allow-listed /api/board projection.
 *
 * EDITORS (assign/vacate/remove/notes/seed): the Founder and the NGS only.
 * Per-category rules still apply inside the register (FA seats are the
 * Founder's alone; removal is the Founder's alone).
 */

import { FOUNDER_UID } from '@/lib/roles';

export function isRegisterReader(uid: string, role: string | null | undefined): boolean {
  if (uid === FOUNDER_UID) return true;
  if (!role) return false;
  return (
    role === 'national_general_secretary' ||
    // founder_patron enters the catalog with Phase 1; the literal key is
    // accepted here so the reader set is correct the day the role exists.
    role === 'founder_patron' ||
    role.startsWith('governor_')
  );
}

export function canEditRegister(uid: string, role: string | null | undefined): boolean {
  return uid === FOUNDER_UID || role === 'national_general_secretary';
}
