/** @jest-environment node */
/**
 * Public API tests (Workstream D spec T-13/T-15/T-17): sanitised
 * projection only, current version per family, runtime redaction
 * re-check, and the publication flag holding everything back.
 */
jest.mock('@/lib/server/firebase-admin', () => {
  const { FakeFirestore } = jest.requireActual(
    '@/lib/governance/__tests__/fake-firestore',
  );
  const db = new FakeFirestore();
  return { __db: db, getDb: () => db };
});

import { GET } from '../route';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __db } = require('@/lib/server/firebase-admin');

function seedRecord(id: string, overrides: Record<string, unknown>) {
  __db.seed('governance_records', id, {
    recordId: id,
    familyId: id.split('--')[0],
    series: 'constitution_suite',
    layer: 0,
    title: 'Constitution',
    parties: ['SEDS Pakistan'],
    recordDate: '2026-01-15',
    version: 1,
    status: 'approved',
    adoptionStatus: 'adopted_executed',
    accessLevel: 'public',
    redactionStatus: 'redacted',
    driveFileId: 'drive-secret-id',
    driveUrl: 'https://drive/secret',
    sha256: 'deadbeef',
    uploadedBy: 'admin-uid',
    consentId: 'consent-secret',
    notes: 'internal note',
    links: { decisionRecordId: 'x' },
    ...overrides,
  });
}

const FAM = 'govfam-cs-constitution';

describe('public governance documents API', () => {
  beforeEach(() => {
    __db.collections.clear();
    delete process.env.GOVERNANCE_PUBLICATION_ENABLED;
    seedRecord(`${FAM}--v001`, { version: 1 });
    seedRecord(`${FAM}--v002`, { version: 2, recordDate: '2026-06-01' });
    seedRecord(`${FAM}--v003`, { version: 3, status: 'draft' });
    seedRecord('govfam-mou-seds-earth-mou--v001', {
      series: 'mou',
      layer: null,
      redactionStatus: 'UNREDACTED_DO_NOT_PUBLISH',
    });
    seedRecord('govfam-pol-finance-policy--v001', {
      series: 'policy',
      layer: null,
      accessLevel: 'officer_only',
    });
  });

  it('T-17: with the flag off, returns the registration line and no documents', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registration.status).toBe('in_process');
    expect(body.layers['0']).toHaveLength(0);
    expect(body.unlayered).toHaveLength(0);
  });

  it('with the flag on, lists only the current public version per family with fixed labels', async () => {
    process.env.GOVERNANCE_PUBLICATION_ENABLED = 'true';
    const body = await (await GET()).json();
    expect(body.layers['0']).toHaveLength(1);
    const rec = body.layers['0'][0];
    expect(rec.recordId).toBe(`${FAM}--v002`);
    expect(rec.adoptionLabel).toBe('Adopted');
    // Executed but society unregistered -> not in force yet.
    expect(rec.effectiveLabel).toBe(
      'Not in force - takes effect on registration',
    );
    expect(rec.fileUrl).toBe(`/api/governance-records/${FAM}--v002/file`);
    // The unredacted MOU and the officer_only policy are excluded.
    expect(body.unlayered).toHaveLength(0);
  });

  it('T-15: the payload contains no private fields anywhere (deep scan)', async () => {
    process.env.GOVERNANCE_PUBLICATION_ENABLED = 'true';
    const raw = JSON.stringify(await (await GET()).json());
    for (const forbidden of [
      'driveFileId',
      'driveUrl',
      'drive-secret-id',
      'sha256',
      'deadbeef',
      'uploadedBy',
      'admin-uid',
      'consentId',
      'consent-secret',
      'internal note',
      'links',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
