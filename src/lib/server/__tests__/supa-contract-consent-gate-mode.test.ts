/**
 * @jest-environment node
 *
 * SUPABASE MIGRATION CONTRACT — COMPLIANCE/DISCIPLINE, cluster 7.
 *
 * Invariant 7 (CONSENT GATE MODE READER): the reader the gate
 * actually uses is getConsentMatterSettings in
 * src/lib/server/governance-settings.ts (:178-207), called by
 * assertConsentFor on EVERY call (consent-gate.ts:518, no cache).
 * Its CURRENT behaviour, pinned exactly:
 *  - settings doc missing -> { mode:'record', validityDays:90,
 *    source:'missing' };
 *  - settings read throws -> same record/missing result (the reader
 *    never throws);
 *  - per-matter key absent from an existing doc -> record/missing;
 *  - per-matter value present but not 'hard'|'record' ->
 *    { mode:'record', source:'malformed' };
 *  - per-matter value 'hard'/'record' -> that mode, source:'doc';
 *  - matterValidityDays[matter] > 0 overrides the 90-day default.
 * In record mode assertConsentFor NEVER blocks a non-founder: it
 * returns { mode:'record', outcome:'recorded' }, writes a
 * 'consent_gate_settings_missing' (or '_malformed') warning audit
 * plus a 'consent_gate_record' audit, creates the Founder's
 * retroactive-consent task, and stamps the subject record with
 * consentMode:'record'.
 *
 * DIVERGENCE PINNED, NOT FIXED: the OTHER reader of the same doc,
 * getGovernanceSettings/getConsentGateMode (governance-settings.ts
 * :40-51, :106-114) — whose merged result is what
 * GET /api/governance/settings reports — defaults the same missing
 * doc to 'hard' for most matters (category_b_appointment,
 * chapter_lifecycle, catalog_amendment) and getConsentGateMode
 * answers 'hard' for any absent key ("fail closed"). So with no
 * settings doc at all, the settings API reports hard mode while the
 * gate itself runs in record mode. Both sides are pinned below so
 * the migration cannot silently change either.
 *
 * Also pinned: src/lib/consents/consent-config.ts (the SEPARATE
 * settings/consent_config reader): missing/unreadable doc ->
 * DEFAULT_CONSENT_CONFIG { filingsEnabled:true,
 * founderRootMode:'founder_only' }; isConsentDecider is founder-UID
 * only in BOTH modes today (the 'founder_or_cto_under_consent'
 * semantics are deferred, consent-config.ts:44-59).
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => null,
  admin: { firestore: { FieldValue: { serverTimestamp: () => new Date() } } },
}));
jest.mock('@/lib/server/founder-gate', () => {
  const { FOUNDER_UID: FOUNDER } = require('@/lib/roles');
  return {
    isFounderUid: (uid: string | null | undefined) =>
      typeof uid === 'string' && uid.length > 0 && uid === FOUNDER,
  };
});

import { FOUNDER_UID } from '@/lib/roles';
import { createFakeDb, type FakeDb } from './fake-firestore';
import {
  DEFAULT_VALIDITY_DAYS,
  getConsentGateMode,
  getConsentMatterSettings,
  getGovernanceSettings,
} from '@/lib/server/governance-settings';
import { assertConsentFor, type ConsentSubjectRef } from '@/lib/server/consent-gate';
import { getConsentConfig, isConsentDecider } from '@/lib/consents/consent-config';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const SUBJECT: ConsentSubjectRef = { type: 'user_role', targetUid: 'user-1', roleKey: 'president_national', action: 'appoint' };

function throwingDb() {
  return {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ get: jest.fn(async () => { throw new Error('firestore down'); }) })),
    })),
  } as any;
}

describe('CONTRACT 7a: getConsentMatterSettings falls back to RECORD when the source is missing/unreadable', () => {
  it('missing doc -> record / missing / 90 days', async () => {
    const db = createFakeDb();
    await expect(getConsentMatterSettings(db as any, 'catb_officer')).resolves.toEqual({
      mode: 'record', validityDays: DEFAULT_VALIDITY_DAYS, source: 'missing',
    });
  });
  it('read throws -> record / missing / 90 days (never throws)', async () => {
    await expect(getConsentMatterSettings(throwingDb(), 'catb_officer')).resolves.toEqual({
      mode: 'record', validityDays: 90, source: 'missing',
    });
  });
  it('doc exists but the matter key is absent -> record / missing', async () => {
    const db = createFakeDb();
    db.seed('governance_settings', 'phase2', { consentGateMode: { other_matter: 'hard' } });
    await expect(getConsentMatterSettings(db as any, 'catb_officer')).resolves.toEqual({
      mode: 'record', validityDays: 90, source: 'missing',
    });
  });
  it('malformed matter value -> record / malformed', async () => {
    const db = createFakeDb();
    db.seed('governance_settings', 'phase2', { consentGateMode: { catb_officer: 'bogus' } });
    await expect(getConsentMatterSettings(db as any, 'catb_officer')).resolves.toEqual({
      mode: 'record', validityDays: 90, source: 'malformed',
    });
  });
  it('stored modes are honoured with source doc, and matterValidityDays overrides 90', async () => {
    const db = createFakeDb();
    db.seed('governance_settings', 'phase2', {
      consentGateMode: { catb_officer: 'hard', sponsor_partner: 'record' },
      matterValidityDays: { catb_officer: 30 },
    });
    await expect(getConsentMatterSettings(db as any, 'catb_officer')).resolves.toEqual({
      mode: 'hard', validityDays: 30, source: 'doc',
    });
    await expect(getConsentMatterSettings(db as any, 'sponsor_partner')).resolves.toEqual({
      mode: 'record', validityDays: 90, source: 'doc',
    });
  });
});

/**
 * The shared server FakeDb has no collection().add (the real Admin
 * SDK does); recordMode creates the retroactive task via .add, so
 * gate-level tests patch it in over the fake's doc/set primitives.
 */
function makeGateDb(): FakeDb {
  const db = createFakeDb();
  const realCollection = db.collection.bind(db);
  (db as any).collection = (name: string) => {
    const col: any = realCollection(name);
    if (typeof col.add !== 'function') {
      col.add = async (data: Record<string, unknown>) => {
        const ref = col.doc();
        await ref.set(data);
        return ref;
      };
    }
    return col;
  };
  return db;
}

describe('CONTRACT 7b: in record mode the gate records and never blocks', () => {
  it('missing settings doc: non-founder act passes as recorded, with missing-settings + record audits and a Founder task', async () => {
    const db = makeGateDb();
    db.seed('users', 'officer-1', { displayName: 'Officer One' });
    db.seed('roles', 'user-1', { role: 'member' });
    const result = await assertConsentFor({
      db: db as never, actorUid: 'officer-1', matterKey: 'catb_officer',
      subjectRef: SUBJECT, actSummary: 'Appoint user-1', now: NOW,
    });
    expect(result).toEqual({ mode: 'record', outcome: 'recorded', consentRequestId: null });
    const actions = db.all('audit_logs').map((a) => a.data.action);
    expect(actions).toContain('consent_gate_settings_missing');
    expect(actions).toContain('consent_gate_record');
    const tasks = db.all('tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].data.assigneeIds).toEqual([FOUNDER_UID]);
    expect(tasks[0].data.consentGateRecord).toBe(true);
    // The subject record is stamped, not blocked.
    expect(db.read('roles', 'user-1')?.consentMode).toBe('record');
    // Nothing was consumed or minted in consent_requests.
    expect(db.all('consent_requests')).toHaveLength(0);
  });

  it('record mode is best-effort: even if the retroactive task cannot be created, the act still passes as recorded', async () => {
    // Unpatched shared FakeDb: collection().add does not exist, the
    // task write throws inside recordMode, and the code swallows it
    // (consent-gate.ts:349-353) — record mode must never become an
    // accidental hard gate through a side-effect failure.
    const db = createFakeDb();
    const result = await assertConsentFor({
      db: db as never, actorUid: 'officer-1', matterKey: 'catb_officer',
      subjectRef: SUBJECT, actSummary: 'Appoint user-1', now: NOW,
    });
    expect(result).toEqual({ mode: 'record', outcome: 'recorded', consentRequestId: null });
    expect(db.all('audit_logs').map((a) => a.data.action)).toContain('consent_gate_record');
  });

  it('malformed settings doc: gate still records, and the warning audit names the malformed source', async () => {
    const db = makeGateDb();
    db.seed('governance_settings', 'phase2', { consentGateMode: { catb_officer: 'bogus' } });
    const result = await assertConsentFor({
      db: db as never, actorUid: 'officer-1', matterKey: 'catb_officer',
      subjectRef: SUBJECT, actSummary: 'Appoint user-1', now: NOW,
    });
    expect(result).toEqual({ mode: 'record', outcome: 'recorded', consentRequestId: null });
    expect(db.all('audit_logs').map((a) => a.data.action)).toContain('consent_gate_settings_malformed');
  });
});

describe('CONTRACT 7c: DIVERGENCE — the settings-API reader reports HARD for the same missing doc', () => {
  it('with NO settings doc: gate reader says record while getGovernanceSettings defaults say hard', async () => {
    const db = createFakeDb();
    const gateReader = await getConsentMatterSettings(db as any, 'category_b_appointment');
    expect(gateReader.mode).toBe('record');
    const reported = await getGovernanceSettings(db as any);
    expect(reported.consentGateMode.category_b_appointment).toBe('hard');
    expect(reported.consentGateMode.chapter_lifecycle).toBe('hard');
    expect(reported.consentGateMode.catalog_amendment).toBe('hard');
    // The two record-default matters in the API reader's own map:
    expect(reported.consentGateMode.sponsor_partner).toBe('record');
    expect(reported.consentGateMode.other_reserved).toBe('record');
  });
  it('getConsentGateMode answers hard for any absent key, record only where the default map says so', async () => {
    const db = createFakeDb();
    await expect(getConsentGateMode(db as any, 'category_b_appointment')).resolves.toBe('hard');
    await expect(getConsentGateMode(db as any, 'some_unknown_matter')).resolves.toBe('hard');
    await expect(getConsentGateMode(db as any, 'sponsor_partner')).resolves.toBe('record');
  });
});

describe('CONTRACT 7d: consent-config reader (settings/consent_config) defaults and decider', () => {
  function configDb(stored: Record<string, unknown> | null, throws = false) {
    return {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => {
            if (throws) throw new Error('firestore down');
            if (stored === null) return { exists: false, data: () => undefined };
            return { exists: true, data: () => stored };
          }),
        })),
      })),
    } as any;
  }
  it('missing or unreadable doc -> defaults { filingsEnabled:true, founderRootMode:founder_only }', async () => {
    await expect(getConsentConfig(configDb(null))).resolves.toEqual({ filingsEnabled: true, founderRootMode: 'founder_only' });
    await expect(getConsentConfig(configDb(null, true))).resolves.toEqual({ filingsEnabled: true, founderRootMode: 'founder_only' });
  });
  it('stored values are honoured; invalid values fall back per-field', async () => {
    await expect(getConsentConfig(configDb({ filingsEnabled: false, founderRootMode: 'founder_or_cto_under_consent' })))
      .resolves.toEqual({ filingsEnabled: false, founderRootMode: 'founder_or_cto_under_consent' });
    await expect(getConsentConfig(configDb({ filingsEnabled: 'yes', founderRootMode: 'anyone' })))
      .resolves.toEqual({ filingsEnabled: true, founderRootMode: 'founder_only' });
  });
  it('isConsentDecider is founder-UID only in BOTH modes today (CTO semantics deferred)', async () => {
    await expect(isConsentDecider(configDb({ founderRootMode: 'founder_or_cto_under_consent' }), FOUNDER_UID)).resolves.toBe(true);
    await expect(isConsentDecider(configDb({ founderRootMode: 'founder_or_cto_under_consent' }), 'cto-uid')).resolves.toBe(false);
    await expect(isConsentDecider(configDb({ founderRootMode: 'founder_only' }), 'cto-uid')).resolves.toBe(false);
    await expect(isConsentDecider(configDb(null), null)).resolves.toBe(false);
    await expect(isConsentDecider(configDb(null), undefined)).resolves.toBe(false);
  });
});
