/**
 * Owner resolution (phase2_spec.md Section G.2).
 *
 * The obligation belongs to the OFFICE. The human is resolved fresh at
 * EVERY send from the authoritative role store - never from the instance's
 * ownerUidSnapshot (a stale snapshot routing a default notice to a
 * removed officer is the failure this design exists to prevent; the
 * snapshot exists for display only and the cron refreshes it).
 *
 * Vacancy rule: a vacant office's reminders/notices go to the Founder AND
 * the National General Secretary - or, when the vacant office IS the NGS,
 * to the Founder and the President. The payload is flagged officeVacant
 * and the obligation's clock never pauses.
 */

import { FOUNDER_UID } from '@/lib/roles';
import { resolveRoleHolders } from '@/lib/server/role-holders';

export const NGS_ROLE_KEY = 'national_general_secretary';
export const PRESIDENT_ROLE_KEY = 'president_national';

export interface ResolvedRecipients {
  /** Current office holder, or null when the office is vacant. */
  holderUid: string | null;
  vacant: boolean;
  /** Everyone a send for this obligation must reach, in order. */
  recipients: string[];
  officeVacant: boolean;
}

export async function resolveObligationRecipients(
  officeRole: string,
  chapterId?: string | null,
): Promise<ResolvedRecipients> {
  const holders = await resolveRoleHolders(officeRole, chapterId ?? null);
  if (holders.length > 0) {
    return { holderUid: holders[0], vacant: false, recipients: [holders[0]], officeVacant: false };
  }

  // Vacancy routing (G.2): Founder + NGS, or Founder + President when the
  // vacant office is the NGS itself.
  const recipients: string[] = [FOUNDER_UID];
  if (officeRole === NGS_ROLE_KEY) {
    const presidents = await resolveRoleHolders(PRESIDENT_ROLE_KEY);
    recipients.push(...presidents);
  } else {
    const ngs = await resolveRoleHolders(NGS_ROLE_KEY);
    recipients.push(...ngs);
  }
  return {
    holderUid: null,
    vacant: true,
    recipients: [...new Set(recipients)],
    officeVacant: true,
  };
}
