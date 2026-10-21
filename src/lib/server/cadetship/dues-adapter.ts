// ADAPTER: binding point between Workstream F (Cadetship) and the Phase 1
// membership/dues machinery (phase2_spec.md Section F.7). Phase 1 ships
// getDuesStatusForConfirmation and setMembershipClass; until it lands, this
// adapter fails CLOSED in both directions:
//   - dues reads return 'no_record', which the confirmation route treats as
//     BLOCKED under the Z-15 recorded-payment rule (absence of a record is
//     not evidence of payment);
//   - class writes throw MembershipClassUnavailableError, which the
//     confirmation route converts into membershipClassWritePending on the
//     cadetship (retried by the governance cron stanza) - never a silent
//     success, never a reverse-order write.
// When Phase 1 exports the real functions, only this file changes.

export interface DuesStatusForConfirmation {
  duesStatus: string;
  paidThrough: Date | null;
}

export class MembershipClassUnavailableError extends Error {
  constructor(message = 'Phase 1 setMembershipClass is not available yet') {
    super(message);
    this.name = 'MembershipClassUnavailableError';
  }
}

export async function getDuesStatusForConfirmation(
  _personUid: string,
  _chapterId: string,
): Promise<DuesStatusForConfirmation> {
  return { duesStatus: 'no_record', paidThrough: null };
}

export async function setMembershipClass(
  _personUid: string,
  _membershipClass: string,
  _opts: { via: string; cadetshipId: string },
): Promise<void> {
  throw new MembershipClassUnavailableError();
}
