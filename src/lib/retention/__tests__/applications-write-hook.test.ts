/**
 * @jest-environment node
 *
 * A8 hook law (applications-write-hook.ts): the retention engine's
 * applications writes follow the applications primacy/mirror law.
 *  - non-applications collection: always passthrough / no-op.
 *  - primacy active + update: updateApplicationPrimaryFirst
 *    performs the write, verdict 'handled'; its failure THROWS.
 *  - primacy active + delete: adapter deleteDoc, 'handled'.
 *  - primacy inactive: passthrough, and afterDocWrite mirrors
 *    (mirrorApplicationUpdate / mirrorDeleteDoc).
 *  - afterDocWrite under primacy: no mirror (primary was the
 *    only write).
 * The applications seam is mocked; the real seam's own contracts
 * live in src/lib/__tests__/applications-supa-primacy.test.ts.
 */

const seam = {
  primaryActive: false,
  primaryUpdate: jest.fn(async (_id: string, _data: Record<string, unknown>) => true),
  mirrorUpdate: jest.fn(async (_id: string, _data: Record<string, unknown>) => true),
  mirrorDelete: jest.fn(async (_collection: string, _id: string) => true),
  adapterDelete: jest.fn(async (_collection: string, _id: string) => undefined),
};

jest.mock('@/lib/applications-supa', () => ({
  APPLICATIONS_COLLECTION: 'applications',
  applicationsPrimaryActive: async () => seam.primaryActive,
  updateApplicationPrimaryFirst: (id: string, data: Record<string, unknown>) =>
    seam.primaryUpdate(id, data),
  mirrorApplicationUpdate: (id: string, data: Record<string, unknown>) =>
    seam.mirrorUpdate(id, data),
  mirrorDeleteDoc: (collection: string, id: string) =>
    seam.mirrorDelete(collection, id),
  resolveApplicationsSupaAdapter: async () =>
    seam.primaryActive
      ? { deleteDoc: (c: string, id: string) => seam.adapterDelete(c, id) }
      : null,
}));

import {
  retentionApplicationsAfterDocWrite,
  retentionApplicationsDocWrite,
} from '../applications-write-hook';

beforeEach(() => {
  seam.primaryActive = false;
  jest.clearAllMocks();
});

describe('retentionApplicationsDocWrite (A8)', () => {
  it('non-applications collection passes through even under primacy', async () => {
    seam.primaryActive = true;
    await expect(
      retentionApplicationsDocWrite({
        collection: 'audit_logs',
        id: 'a1',
        kind: 'update',
        data: { retentionArchivedAt: 'x' },
      }),
    ).resolves.toBe('passthrough');
    expect(seam.primaryUpdate).not.toHaveBeenCalled();
  });

  it('primacy inactive: passthrough, no primary write', async () => {
    await expect(
      retentionApplicationsDocWrite({
        collection: 'applications',
        id: 'app-1',
        kind: 'update',
        data: { retentionArchivedAt: 'x' },
      }),
    ).resolves.toBe('passthrough');
    expect(seam.primaryUpdate).not.toHaveBeenCalled();
  });

  it('primacy active + update: primary-first write, handled', async () => {
    seam.primaryActive = true;
    await expect(
      retentionApplicationsDocWrite({
        collection: 'applications',
        id: 'app-1',
        kind: 'update',
        data: { retentionScrubbedAt: 'x', email: null },
      }),
    ).resolves.toBe('handled');
    expect(seam.primaryUpdate).toHaveBeenCalledWith('app-1', {
      retentionScrubbedAt: 'x',
      email: null,
    });
  });

  it('primacy active + primary failure: throws (loud, no fallback)', async () => {
    seam.primaryActive = true;
    seam.primaryUpdate.mockRejectedValueOnce(new Error('unreconciled row'));
    await expect(
      retentionApplicationsDocWrite({
        collection: 'applications',
        id: 'app-1',
        kind: 'update',
        data: { retentionArchivedAt: 'x' },
      }),
    ).rejects.toThrow('unreconciled row');
  });

  it('primacy active + delete: adapter deleteDoc, handled', async () => {
    seam.primaryActive = true;
    await expect(
      retentionApplicationsDocWrite({
        collection: 'applications',
        id: 'app-1',
        kind: 'delete',
      }),
    ).resolves.toBe('handled');
    expect(seam.adapterDelete).toHaveBeenCalledWith('applications', 'app-1');
  });
});

describe('retentionApplicationsAfterDocWrite (A8 mirror leg)', () => {
  it('primacy inactive + update: mirrors the committed payload', async () => {
    await retentionApplicationsAfterDocWrite({
      collection: 'applications',
      id: 'app-1',
      kind: 'update',
      data: { retentionArchivedAt: 'x' },
    });
    expect(seam.mirrorUpdate).toHaveBeenCalledWith('app-1', {
      retentionArchivedAt: 'x',
    });
  });

  it('primacy inactive + delete: mirrors the delete', async () => {
    await retentionApplicationsAfterDocWrite({
      collection: 'applications',
      id: 'app-1',
      kind: 'delete',
    });
    expect(seam.mirrorDelete).toHaveBeenCalledWith('applications', 'app-1');
  });

  it('primacy active: no mirror (the primary leg was the only write)', async () => {
    seam.primaryActive = true;
    await retentionApplicationsAfterDocWrite({
      collection: 'applications',
      id: 'app-1',
      kind: 'update',
      data: { retentionArchivedAt: 'x' },
    });
    expect(seam.mirrorUpdate).not.toHaveBeenCalled();
  });

  it('other collections: no-op', async () => {
    await retentionApplicationsAfterDocWrite({
      collection: 'warnings',
      id: 'w1',
      kind: 'delete',
    });
    expect(seam.mirrorDelete).not.toHaveBeenCalled();
    expect(seam.mirrorUpdate).not.toHaveBeenCalled();
  });
});
