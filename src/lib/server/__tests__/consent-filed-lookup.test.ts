/**
 * @jest-environment node
 *
 * The delete dialog's decided-consent lookup + the filing persistence
 * fix (consent matcher fix, 2026-10-26). The picker used to fetch a
 * route that does not exist (/api/admin/governance/consents/decided),
 * so it always rendered the empty state. The lookup behind the new
 * route must find decided consents across every representation the
 * system produces - gate-shaped (subjectRef), user-filed (Reserved-
 * Matter key + act text, the FC-2026-0020 / FC-2026-0048 shapes), and
 * post-fix stamped filings (gateMatterKey + subjectRef) - and must
 * never surface pending, refused, consumed, or other-act records.
 */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: jest.fn(async () => undefined) },
}));

import { FOUNDER_UID } from '@/lib/roles';
import { createFakeDb, type FakeDb } from './fake-firestore';
import { listDecidedConsentsForAct } from '@/lib/server/consent-lookup';
import { createDraft } from '@/lib/server/consent-service';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const DELETE_SUBJECT: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'president_chapter',
  action: 'delete',
};

const D = (day: number) => new Date(2026, 9, day, 10, 0, 0);

function seedConsent(db: FakeDb, id: string, data: Record<string, unknown>) {
  db.seed('consent_requests', id, {
    status: 'consented',
    consumedAt: null,
    decidedAtSort: D(20),
    ...data,
  });
}

function seedAllShapes(db: FakeDb) {
  // FC-2026-0020 shape: filed, free-text act, no subjectRef.
  seedConsent(db, 'fc0020', {
    requestNumber: 'FC-2026-0020',
    matterKey: 'amend_layer1_documents',
    proposedAct:
      'Delete the president_chapter role definition (shown in the Role Registry as PRESIDENT / LOCAL OPERATIONS, 30/46) and its permission record.',
    decisionDate: D(20),
    decidedAtSort: D(20),
  });
  // FC-2026-0048 shape: filed, templated act, no subjectRef.
  seedConsent(db, 'fc0048', {
    requestNumber: 'FC-2026-0048',
    matterKey: 'amend_layer1_documents',
    proposedAct: 'Delete role definition president_chapter',
    decisionDate: D(21),
    decidedAtSort: D(21),
  });
  // Gate-shaped: founder-act record for a DIFFERENT slug.
  seedConsent(db, 'gate-hr', {
    requestNumber: 'FC-2026-0006',
    matterKey: 'role_catalog',
    proposedAct: 'Delete role definition hr_director',
    subjectRef: { type: 'role_definition', slug: 'hr_director', action: 'delete' },
    decidedAt: D(19),
  });
  // Post-fix stamped filing for this act.
  seedConsent(db, 'stamped', {
    requestNumber: 'FC-2026-0050',
    matterKey: 'amend_layer1_documents',
    gateMatterKey: 'role_catalog',
    subjectRef: { type: 'role_definition', slug: 'president_chapter', action: 'delete' },
    proposedAct: 'Delete role definition president_chapter',
    decisionDate: D(22),
    decidedAtSort: D(22),
  });
  // Decoys that must never surface for this act.
  seedConsent(db, 'pending-filed', {
    requestNumber: 'FC-2026-0051',
    matterKey: 'amend_layer1_documents',
    proposedAct: 'Delete role definition president_chapter',
    status: 'pending',
  });
  seedConsent(db, 'refused-filed', {
    requestNumber: 'FC-2026-0052',
    matterKey: 'amend_layer1_documents',
    proposedAct: 'Delete role definition president_chapter',
    status: 'refused',
  });
  seedConsent(db, 'consumed-filed', {
    requestNumber: 'FC-2026-0053',
    matterKey: 'amend_layer1_documents',
    proposedAct: 'Delete role definition president_chapter',
    consumedAt: D(23),
  });
  seedConsent(db, 'wrong-act-filed', {
    requestNumber: 'FC-2026-0054',
    matterKey: 'amend_layer1_documents',
    proposedAct: 'Create role definition president_chapter',
  });
  seedConsent(db, 'wrong-matter-filed', {
    requestNumber: 'FC-2026-0055',
    matterKey: 'related_party_contract',
    proposedAct: 'Delete role definition president_chapter',
  });
}

describe('listDecidedConsentsForAct', () => {
  it('finds the filed and stamped records for the act, newest first', async () => {
    const db = createFakeDb();
    seedAllShapes(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', DELETE_SUBJECT);
    expect(rows.map((r) => r.id)).toEqual(['stamped', 'fc0048', 'fc0020']);
  });

  it('finds the gate-shaped record when the subject names its slug', async () => {
    const db = createFakeDb();
    seedAllShapes(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'hr_director',
      action: 'delete',
    });
    expect(rows.map((r) => r.id)).toEqual(['gate-hr']);
  });

  it('returns an empty list when nothing decided matches', async () => {
    const db = createFakeDb();
    seedAllShapes(db);
    const rows = await listDecidedConsentsForAct(db as any, 'role_catalog', {
      type: 'role_definition',
      slug: 'chapter_president',
      action: 'delete',
    });
    expect(rows).toEqual([]);
  });
});

describe('createDraft filing persistence (dialog-link context)', () => {
  const ACTOR = 'officer-1';

  function seedActor(db: FakeDb) {
    db.seed('users', ACTOR, { displayName: 'Officer One', role: 'member' });
    db.seed('roles', ACTOR, { role: 'national_treasurer' });
  }

  it('persists subjectRef and gateMatterKey sent by the filing form', async () => {
    const db = createFakeDb();
    seedActor(db);
    const draft: any = await createDraft(db as any, ACTOR, {
      matterKey: 'amend_layer1_documents',
      proposedAct: 'Delete role definition president_chapter',
      materialFacts: 'Duplicate of chapter_president in the catalog.',
      subjectRef: { type: 'role_definition', slug: 'president_chapter', action: 'delete' },
      gateMatterKey: 'role_catalog',
    });
    expect(draft.subjectRef).toEqual({
      type: 'role_definition',
      slug: 'president_chapter',
      action: 'delete',
    });
    expect(draft.gateMatterKey).toBe('role_catalog');
    const stored: any = db._getDoc('consent_requests', draft.id);
    expect(stored.subjectRef).toEqual(draft.subjectRef);
    expect(stored.gateMatterKey).toBe('role_catalog');
  });

  it('rejects an unknown gateMatterKey', async () => {
    const db = createFakeDb();
    seedActor(db);
    await expect(
      createDraft(db as any, ACTOR, {
        matterKey: 'amend_layer1_documents',
        proposedAct: 'Delete role definition president_chapter',
        gateMatterKey: 'not_a_gate_matter',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_VALIDATION_FAILED' });
  });

  it('rejects a malformed subjectRef', async () => {
    const db = createFakeDb();
    seedActor(db);
    await expect(
      createDraft(db as any, ACTOR, {
        matterKey: 'amend_layer1_documents',
        proposedAct: 'Delete role definition president_chapter',
        subjectRef: { type: 'role_definition' },
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_VALIDATION_FAILED' });
  });

  it('a plain filing without link context still stores explicit nulls', async () => {
    const db = createFakeDb();
    seedActor(db);
    const draft: any = await createDraft(db as any, ACTOR, {
      matterKey: 'amend_layer1_documents',
      proposedAct: 'Delete role definition president_chapter',
    });
    expect(draft.subjectRef).toBeNull();
    expect(draft.gateMatterKey).toBeNull();
  });
});

// Keep the founder import referenced (the fixtures above model records
// the founder decided; decideRequest itself is covered elsewhere).
void FOUNDER_UID;
