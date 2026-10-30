/**
 * Cluster F client-seam contracts: toPartnerRecordShape re-applies the
 * partners converter's defaults to raw seam rows (related-party
 * defaults, forced PKR, legacy interactionHistory -> timeline mapping,
 * lastActivityAt derivation, nextActions default), and the client flag
 * follows NEXT_PUBLIC_SUPA_SURFACES semantics (unset = OFF).
 */
import {
  crmSupaClientEnabled,
  crmEventsSupaClientEnabled,
  CRM_EVENTS_FALLBACK_LIMIT,
  toPartnerRecordShape,
} from '../crm-supa-client';

describe('toPartnerRecordShape', () => {
  it('applies converter defaults to a minimal raw row', () => {
    const out = toPartnerRecordShape({
      id: 'p1',
      organizationName: 'Co',
      updatedAt: '2026-03-01T10:00:00.000Z',
      interactionHistory: [{ note: 'hi', author: 'A', timestamp: '2026-01-01T00:00:00.000Z' }],
    });
    expect(out.isRelatedParty).toBe(false);
    expect(out.isFounderCommercialEntity).toBe(false);
    expect(out.relatedParty).toBeNull();
    expect(out.carriesConditions).toBe(false);
    expect(out.nextActions).toEqual([]);
    expect(out.lastActivityAt).toBe('2026-03-01T10:00:00.000Z');
    expect(out.lastActivityType).toBe('System Update');
    expect(out.timeline).toEqual([
      {
        id: 'legacy-0',
        type: 'note',
        direction: 'sent',
        content: 'hi',
        timestamp: '2026-01-01T00:00:00.000Z',
        author: 'A',
      },
    ]);
  });

  it('forces PKR and preserves an existing timeline + flags', () => {
    const timeline = [{ id: 't', type: 'call', direction: 'sent', content: 'c', timestamp: null, author: 'B' }];
    const out = toPartnerRecordShape({
      id: 'p2',
      organizationName: 'Co2',
      isRelatedParty: true,
      carriesConditions: true,
      financials: { pledgedAmount: 5, currency: 'USD' as never },
      timeline,
      lastActivityAt: '2026-04-01T00:00:00.000Z',
    });
    expect(out.isRelatedParty).toBe(true);
    expect(out.carriesConditions).toBe(true);
    expect(out.financials?.currency).toBe('PKR');
    expect(out.timeline).toBe(timeline);
    expect(out.lastActivityAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('string interactionHistory becomes a one-entry history and empty timeline (converter parity)', () => {
    const out = toPartnerRecordShape({ id: 'p3', organizationName: 'Co3', interactionHistory: 'legacy note' });
    expect(out.interactionHistory).toEqual([{ note: 'legacy note', author: 'system', timestamp: null }]);
    expect(out.timeline).toEqual([]);
  });
});

describe('crmSupaClientEnabled', () => {
  const KEY = 'NEXT_PUBLIC_SUPA_SURFACES';
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it('unset = OFF; listed (any case/space) = ON; other surfaces = OFF', () => {
    delete process.env[KEY];
    expect(crmSupaClientEnabled()).toBe(false);
    process.env[KEY] = 'blog, CRM ';
    expect(crmSupaClientEnabled()).toBe(true);
    process.env[KEY] = 'blog';
    expect(crmSupaClientEnabled()).toBe(false);
  });
});

describe('crmEventsSupaClientEnabled (CRM page events read)', () => {
  const KEY = 'NEXT_PUBLIC_SUPA_SURFACES';
  const prev = process.env[KEY];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  });

  it("gates on the 'events-admin' surface only, independent of 'crm'", () => {
    delete process.env[KEY];
    expect(crmEventsSupaClientEnabled()).toBe(false);
    process.env[KEY] = 'crm';
    expect(crmEventsSupaClientEnabled()).toBe(false);
    process.env[KEY] = ' Events-Admin , crm';
    expect(crmEventsSupaClientEnabled()).toBe(true);
  });

  it('the Firestore fallback bound is a positive finite cap', () => {
    expect(Number.isFinite(CRM_EVENTS_FALLBACK_LIMIT)).toBe(true);
    expect(CRM_EVENTS_FALLBACK_LIMIT).toBeGreaterThan(0);
  });
});
