// Regression tests for the /admin/consents/[id] crash (2026-10-26).
//
// The detail page was written against a record shape no writer produces:
//   - history entries were read as { action, at, actorName }, but the
//     consent service stores { event, actorUid, actorRoleKey, fromStatus,
//     toStatus, note, createdAt }. `h.action.replace(...)` therefore threw
//     during render and the page fell into the error boundary for EVERY
//     consent that has history (every filed or decided request).
//   - the decision was read as a nested object (record.decision.decision,
//     .decisionDate, .founderSignatureMarker, ...), but the record stores
//     it FLAT: `decision` is the string itself, with decisionDate /
//     conditions / consentedScope / refusedScope / decisionNote /
//     founderSignatureMarker at the top level.
//
// Fixtures below mirror the real records: FC-2026-0020 (pending, Reserved
// Matter 3.1(b), role-definition deletion) and a decided consent copied
// field-for-field from a real decided record in consent_requests
// (founder-act, flat decision block, history subcollection entries).

import {
  consentDecisionOf,
  consentHistoryOf,
  fmtDate,
} from '../consent-api';

const FOUNDER = 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';

// Pending consent, as GET /api/consents/[id] returns it: the stored doc
// (decision block all null) plus the history array the route attaches from
// the history subcollection, whose timestamps arrive as Firestore
// Timestamp JSON ({ _seconds, _nanoseconds }).
const PENDING_FC_2026_0020 = {
  id: 'eZRlEAbZ6tfTOLFlwgQl',
  requestNumber: 'FC-2026-0020',
  status: 'pending',
  requestedByUid: FOUNDER,
  requesterName: 'Muhammad Zubair Mongol',
  requesterRoleKey: 'founder_patron',
  requesterChapterId: 'seds-ist-chapter',
  matterKey: 'role_catalog',
  scheduleSection: 'Reserved Matter 3.1(b)',
  matterLabel: 'Amendment of the Role Catalog',
  gateModeAtFiling: 'consent_required',
  proposedAct: 'Delete a role definition from the Role Catalog',
  proposedActDate: '2026-10-27',
  amountPkr: null,
  relatedPartyName: null,
  relatedPartyInterest: null,
  materialFacts: 'Reserved Matter 3.1(b): role-definition deletion.',
  attachments: [],
  isUrgent: false,
  urgencyReason: null,
  decision: null,
  conditions: null,
  consentedScope: null,
  refusedScope: null,
  decisionDate: null,
  decidedAt: null,
  decidedByUid: null,
  founderSignatureMarker: null,
  furtherInformationRequest: null,
  furtherInformationResponse: null,
  submittedAt: { _seconds: 1793000000, _nanoseconds: 0 },
  decisionDeadlineAt: { _seconds: 1795592000, _nanoseconds: 0 },
  subjectRef: { type: 'role_definition', action: 'delete' },
  createdAt: { _seconds: 1793000000, _nanoseconds: 0 },
  updatedAt: { _seconds: 1793000000, _nanoseconds: 0 },
  history: [
    {
      id: 'h1',
      event: 'submitted',
      actorUid: FOUNDER,
      actorRoleKey: 'founder_patron',
      fromStatus: 'draft',
      toStatus: 'pending',
      note: null,
      createdAt: { _seconds: 1793000000, _nanoseconds: 0 },
    },
  ],
};

// Decided consent, field-for-field the shape of the real decided records
// in consent_requests (e.g. FC-2026-0001): decision stored FLAT.
const DECIDED_FC_2026_0021 = {
  id: 'decided-fixture-0021',
  requestNumber: 'FC-2026-0021',
  status: 'consented',
  requestedByUid: FOUNDER,
  requesterName: 'Muhammad Zubair Mongol',
  requesterRoleKey: 'founder_patron',
  requesterChapterId: 'seds-ist-chapter',
  matterKey: 'role_catalog',
  scheduleSection: '',
  matterLabel: '',
  gateModeAtFiling: 'record_only',
  proposedAct: 'Delete role definition vice_president',
  proposedActDate: '2026-10-24',
  amountPkr: null,
  relatedPartyName: null,
  relatedPartyInterest: null,
  materialFacts: 'Delete role definition vice_president',
  attachments: [],
  isUrgent: false,
  urgencyReason: null,
  decision: 'consent_given',
  conditions: null,
  consentedScope: null,
  refusedScope: null,
  decisionDate: '2026-10-24T12:20:26.490Z',
  decidedAt: '2026-10-24T12:20:26.490Z',
  decidedByUid: FOUNDER,
  decidedAtSort: '2026-10-24T12:20:26.490Z',
  founderSignatureMarker:
    'FOUNDER:pLW0PuQCTAQHCNK1SfllVhPZdMz1:2026-10-24T12:20:26.490Z',
  furtherInformationRequest: null,
  furtherInformationResponse: null,
  submittedAt: '2026-10-24T12:20:26.490Z',
  decisionDeadlineAt: '2026-11-23T12:20:26.490Z',
  decidedVia: 'founder-act',
  subjectRef: { type: 'role_definition', slug: 'vice_president', action: 'delete' },
  createdAt: '2026-10-24T12:20:28.033Z',
  updatedAt: '2026-10-24T12:20:28.033Z',
  history: [
    {
      id: 'h1',
      event: 'submitted',
      actorUid: FOUNDER,
      actorRoleKey: 'founder_patron',
      fromStatus: 'draft',
      toStatus: 'pending',
      note: null,
      createdAt: { _seconds: 1792844426, _nanoseconds: 490000000 },
    },
    {
      id: 'h2',
      event: 'consent_given',
      actorUid: FOUNDER,
      actorRoleKey: 'founder_patron',
      fromStatus: 'pending',
      toStatus: 'consented',
      note: 'decidedVia:founder-act',
      createdAt: { _seconds: 1792844426, _nanoseconds: 490000000 },
    },
  ],
};

describe('consent detail shape: the crash regression', () => {
  it('real history entries carry no `action` field (the old render expression threw on them)', () => {
    const entry: any = PENDING_FC_2026_0020.history[0];
    expect(entry.action).toBeUndefined();
    // The exact expression the page used to render each history row:
    expect(() => entry.action.replace(/_/g, ' ')).toThrow(TypeError);
  });

  it('pending FC-2026-0020: history normalizes without throwing', () => {
    const rows = consentHistoryOf(PENDING_FC_2026_0020);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('submitted');
    expect(rows[0].actor).toBe(FOUNDER);
    expect(rows[0].note).toBeNull();
    // The stored timestamp JSON still formats as a real date.
    expect(fmtDate(rows[0].at)).not.toBe('-');
  });

  it('pending FC-2026-0020: no decision block is produced', () => {
    expect(consentDecisionOf(PENDING_FC_2026_0020)).toBeNull();
  });

  it('decided FC-2026-0021: flat decision block is read in full', () => {
    const d = consentDecisionOf(DECIDED_FC_2026_0021);
    expect(d).not.toBeNull();
    expect(d!.decision).toBe('consent_given');
    expect(d!.decisionDate).toBe('2026-10-24T12:20:26.490Z');
    expect(d!.founderSignatureMarker).toBe(
      'FOUNDER:pLW0PuQCTAQHCNK1SfllVhPZdMz1:2026-10-24T12:20:26.490Z',
    );
    expect(fmtDate(d!.decisionDate)).not.toBe('-');
  });

  it('decided FC-2026-0021: history renders both events with labels', () => {
    const rows = consentHistoryOf(DECIDED_FC_2026_0021);
    expect(rows.map((r) => r.label)).toEqual(['submitted', 'consent given']);
    expect(rows[1].note).toBe('decidedVia:founder-act');
  });
});

describe('consent detail shape: robustness', () => {
  it('flat refusal surfaces its note and refused scope', () => {
    const refused = {
      ...DECIDED_FC_2026_0021,
      status: 'refused',
      decision: 'consent_refused',
      decisionNote: 'Reserved Matter: not approved.',
      refusedScope: 'The whole Act',
    };
    const d = consentDecisionOf(refused);
    expect(d!.decision).toBe('consent_refused');
    expect(d!.decisionNote).toBe('Reserved Matter: not approved.');
    expect(d!.refusedScope).toBe('The whole Act');
  });

  it('flat conditional consent surfaces conditions and scope', () => {
    const conditional = {
      ...DECIDED_FC_2026_0021,
      status: 'conditional',
      decision: 'conditional_consent',
      conditions: 'Only after the register is updated',
      consentedScope: 'Deletion of the one named definition',
    };
    const d = consentDecisionOf(conditional);
    expect(d!.decision).toBe('conditional_consent');
    expect(d!.conditions).toBe('Only after the register is updated');
    expect(d!.consentedScope).toBe('Deletion of the one named definition');
  });

  it('a nested decision object (if one ever appears) is still read', () => {
    const nested = {
      decision: {
        decision: 'consent_given',
        decisionDate: '2026-10-24T12:20:26.490Z',
        conditions: null,
        consentedScope: null,
        refusedScope: null,
        decisionNote: null,
        founderSignatureMarker: 'FOUNDER:x',
      },
    };
    const d = consentDecisionOf(nested);
    expect(d!.decision).toBe('consent_given');
    expect(d!.founderSignatureMarker).toBe('FOUNDER:x');
  });

  it('malformed history entries degrade to a generic row, never throw', () => {
    const messy: any = { history: [{}, null, { actorUid: 'u1' }, { event: 'waived' }] };
    const rows = consentHistoryOf(messy);
    expect(rows).toHaveLength(4);
    expect(rows[0].label).toBe('');
    expect(rows[2].actor).toBe('u1');
    expect(rows[3].label).toBe('waived');
  });

  it('a record without history yields no rows', () => {
    expect(consentHistoryOf({})).toEqual([]);
    expect(consentHistoryOf(null)).toEqual([]);
    expect(consentDecisionOf(null)).toBeNull();
    expect(consentDecisionOf({})).toBeNull();
  });
});
