import { buildSecretBallotCastPayload, buildOpenBallotPayload, minutesCompleteness, circularProgress, thresholdLabel, secretDemandState } from '../meetings-ui';
describe('secret ballot payload shape', () => {
  it('contains choice and token only, with no identity fields', () => {
    const p: any = buildSecretBallotCastPayload('tok123', 'for');
    expect(Object.keys(p).sort()).toEqual(['choice', 'kind', 'token']);
    expect(p).toEqual({ kind: 'secret_cast', token: 'tok123', choice: 'for' });
    for (const k of ['uid', 'voterUid', 'email', 'displayName', 'userId', 'ip', 'userAgent']) expect(p).not.toHaveProperty(k);
  });
  it('open ballot carries disclosure without identity beyond server auth', () => {
    const p: any = buildOpenBallotPayload('against', { hasInterest: true, description: 'Supplier owner' });
    expect(p.choice).toBe('against'); expect(p.interestDisclosure.hasInterest).toBe(true);
  });
});
describe('minutes completeness mapping', () => {
  it('counts present generated fields out of six', () => {
    const r = minutesCompleteness({ fieldAttendees: {}, fieldQuorum: {}, fieldDisclosures: [], fieldMotions: [] } as any);
    expect(r.total).toBe(6); expect(r.complete).toBe(4); expect(r.percent).toBe(67); expect(r.missing).toEqual(expect.arrayContaining(['voting', 'consents']));
  });
  it('full minutes are 100 percent', () => { expect(minutesCompleteness({ fieldAttendees: {}, fieldQuorum: {}, fieldDisclosures: [], fieldMotions: [], fieldVoting: [], fieldConsents: [] } as any).percent).toBe(100); });
});
describe('circular progress and labels', () => {
  it('majority of 9 governors is 5', () => { const r = circularProgress({ signedCount: 5, governorUidsSnapshot: Array(9).fill('x'), closesAt: null, status: 'circulating' }); expect(r.majorityNeeded).toBe(5); expect(r.passed).toBe(true); });
  it('closed lapsed state is reported', () => { expect(circularProgress({ signedCount: 2, governorUidsSnapshot: ['a', 'b', 'c'], closesAt: null, status: 'lapsed' }).countdownLabel).toContain('Closed'); });
  it('threshold label renders required count and secret demand locks at 2', () => {
    expect(thresholdLabel({ majorityType: 'fraction_of_all_governors', numerator: 2, denominatorKind: 'all_governors', requiredCount: 6, consentRequired: false, isReservedMatter: false, filingFlag: false })).toContain('at least 6');
    expect(secretDemandState({ secretDemandedBy: ['a', 'b'], method: 'electronic_poll' }).locked).toBe(true);
  });
});
