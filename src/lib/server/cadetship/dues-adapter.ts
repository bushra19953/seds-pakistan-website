// ADAPTER: binding point between Workstream F (Cadetship) and the Phase 1
// dues machinery (phase2_spec.md Section F.7). Until the real dues read
// lands, dues reads fail CLOSED: they return 'no_record', which the
// confirmation route treats as BLOCKED under the Z-15 recorded-payment
// rule (absence of a record is not evidence of payment).
//
// RETIRED (2026-10-24, GOV-03 / decision pack item 31): the Phase 1
// setMembershipClass writer that used to live here is gone. It only ever
// fed the old stored-class test (users/{uid}.membershipClass), and it
// always threw MembershipClassUnavailableError. Full Member status is
// now derived from holding the `member` role (see
// createDefaultFullMemberPort in src/lib/server/election-ports.ts and
// membershipClassOf in src/lib/server/lifecycle-adapters.ts), so there
// is no class string to write: cadetship confirmation no longer writes
// one, and promotion to `member` happens only through the role write
// path / admin UI. The cadetship doc's membershipClassWritePending
// field is inert legacy state - nothing sets it and nothing retries it.

export interface DuesStatusForConfirmation {
  duesStatus: string;
  paidThrough: Date | null;
}

export async function getDuesStatusForConfirmation(
  _personUid: string,
  _chapterId: string,
): Promise<DuesStatusForConfirmation> {
  return { duesStatus: 'no_record', paidThrough: null };
}
