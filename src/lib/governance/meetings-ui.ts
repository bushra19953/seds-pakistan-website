// Pure UI logic for Phase 3 meetings and decisions surfaces. No Firebase imports.
// Spec: bylaws_incorporation/implementation/drafts/ws-a.md sections 3.5 to 3.13, 5.
export type VoteChoice = 'for' | 'against' | 'abstain';
export interface ThresholdView { majorityType: string; numerator: number | null; denominatorKind: string; requiredCount: number | null; consentRequired: boolean; isReservedMatter: boolean; filingFlag: boolean }
export interface MotionView { id: string; meetingId: string | null; bodyId: string; text: string; proposerUid: string; decisionClassId: string; threshold: ThresholdView; method: 'show_of_hands' | 'electronic_poll' | 'secret_ballot'; secretDemandedBy: string[]; status: string; result: { votesFor: number; votesAgainst: number; abstentions: number; denominatorUsed: number; thresholdMet: boolean; castingVoteUsed: boolean } | null }
export interface MinutesView { id: string; meetingId: string; bodyId: string; status: string; fieldAttendees: unknown; fieldQuorum: unknown; fieldDisclosures: unknown[]; fieldMotions: unknown[]; fieldVoting: unknown[]; fieldConsents: unknown[]; circulationOverdue?: boolean; circulatedAt?: unknown; signedAt?: unknown; retentionUntil?: unknown; pdf?: { driveLink: string; sha256: string } | null }
export interface CircularView { id: string; bodyId: string; title?: string; text: string; decisionClassId: string; consentId: string | null; status: string; closesAt: number | null; governorUidsSnapshot: string[]; signatures: { uid: string; atMs: number }[]; signedCount: number }

export function thresholdLabel(t: ThresholdView): string {
  if (t.majorityType === 'ordinary_present_and_voting') return 'Ordinary, present and voting';
  if (t.majorityType === 'plurality') return 'Plurality';
  if (t.majorityType === 'single_person') return 'Single person decision';
  const frac = t.numerator != null ? `${t.numerator}` : 'Fraction';
  const denom = t.denominatorKind === 'all_governors' ? 'of all Governors' : t.denominatorKind === 'all_full_members' ? 'of all Full Members' : t.denominatorKind === 'all_representatives' ? 'of all representatives' : 'of those present';
  return t.requiredCount != null ? `${frac} ${denom}, at least ${t.requiredCount} required` : `${frac} ${denom}`;
}
export function secretDemandState(motion: Pick<MotionView, 'secretDemandedBy' | 'method'>): { demands: number; locked: boolean; needed: number } {
  const demands = new Set(motion.secretDemandedBy ?? []).size;
  return { demands, locked: motion.method === 'secret_ballot' || demands >= 2, needed: Math.max(0, 2 - demands) };
}
// Secret ballot cast payload: choice and token ONLY. No uid, email, name, or device fields ever.
export function buildSecretBallotCastPayload(token: string, choice: VoteChoice): { kind: 'secret_cast'; token: string; choice: VoteChoice } {
  return { kind: 'secret_cast', token, choice };
}
export function buildOpenBallotPayload(choice: VoteChoice, opts?: { hasInterest?: boolean; description?: string; relatedPartyName?: string | null; proxyForUid?: string; proxyAuthorizationId?: string }) {
  return { kind: 'traceable' as const, choice, ...(opts?.hasInterest !== undefined ? { interestDisclosure: { hasInterest: !!opts.hasInterest, description: opts.description ?? '', relatedPartyName: opts.relatedPartyName ?? null } } : {}), ...(opts?.proxyForUid ? { proxyForUid: opts.proxyForUid, proxyAuthorizationId: opts.proxyAuthorizationId ?? null } : {}) };
}
export function minutesCompleteness(m: Partial<MinutesView>): { complete: number; total: 6; missing: string[]; percent: number } {
  const checks: [string, unknown][] = [['attendees', m.fieldAttendees], ['quorum', m.fieldQuorum], ['disclosures', m.fieldDisclosures], ['motions', m.fieldMotions], ['voting', m.fieldVoting], ['consents', m.fieldConsents]];
  const missing = checks.filter(([, v]) => v == null || (Array.isArray(v) && v.length === 0 && false)).map(([k]) => k);
  // Generated array fields may legitimately be empty (no disclosures). Presence of the field counts.
  const present = checks.filter(([, v]) => v !== undefined && v !== null).length;
  return { complete: present, total: 6, missing: checks.filter(([, v]) => v === undefined || v === null).map(([k]) => k), percent: Math.round((present / 6) * 100) };
}
export function circularProgress(c: Pick<CircularView, 'signedCount' | 'governorUidsSnapshot' | 'closesAt' | 'status'>, now = new Date()): { signed: number; total: number; majorityNeeded: number; passed: boolean; closed: boolean; msRemaining: number | null; countdownLabel: string } {
  const total = c.governorUidsSnapshot?.length ?? 0;
  const majorityNeeded = Math.floor(total / 2) + 1;
  const closed = c.status !== 'open' && c.status !== 'draft';
  const msRemaining = c.closesAt ? new Date(c.closesAt).getTime() - now.getTime() : null;
  const countdownLabel = c.status === 'draft' ? 'Not circulated' : closed ? `Closed: ${c.status}` : msRemaining != null && msRemaining <= 0 ? 'Window closed' : msRemaining != null ? `${Math.floor(msRemaining / 86400000)}d ${Math.floor((msRemaining % 86400000) / 3600000)}h remaining` : 'No closing time set';
  return { signed: c.signedCount ?? 0, total, majorityNeeded, passed: (c.signedCount ?? 0) >= majorityNeeded && total > 0, closed, msRemaining, countdownLabel };
}
export function motionResultSummary(m: MotionView): string {
  if (m.status.startsWith('closed') && m.result) {
    if (m.method === 'secret_ballot') return `For ${m.result.votesFor}, Against ${m.result.votesAgainst}, Abstain ${m.result.abstentions}. Totals only, secret ballot.`;
    return `For ${m.result.votesFor}, Against ${m.result.votesAgainst}, Abstain ${m.result.abstentions}.`;
  }
  return m.status === 'closed_tied_pending_casting' ? 'Tied. Awaiting Founder casting ballot.' : `Status: ${m.status}`;
}
