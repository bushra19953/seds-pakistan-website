/**
 * Workstream F: backup engine behaviour with mocked db + Drive.
 * No test touches real Firestore, real Drive, or production data.
 */
import { createHash } from 'node:crypto';
import { runBackup, type BackupDeps } from '../engine';

function makeDeps(
  data: Record<string, Array<{ id: string; data: Record<string, unknown> }>>,
  failing: string[] = [],
) {
  const uploads: Array<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
    folderId?: string;
    makePublic: boolean;
  }> = [];
  const runRecords: Array<{ runId: string; record: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];

  const deps: BackupDeps = {
    db: {
      collection: (name: string) => ({
        get: async () => {
          if (failing.includes(name)) throw new Error(`boom: ${name}`);
          return {
            docs: (data[name] ?? []).map((d) => ({
              id: d.id,
              data: () => d.data,
            })),
          };
        },
      }),
    },
    uploadToDrive: async (args) => {
      uploads.push(args);
      return { fileId: `drive-${uploads.length}` };
    },
    writeRunRecord: async (runId, record) => {
      runRecords.push({ runId, record });
    },
    writeAudit: async (entry) => {
      audits.push(entry);
    },
    resolveFolderId: async () => 'backups-folder-1',
    now: () => new Date('2026-10-21T00:00:00.000Z'),
    runIdFactory: () => 'backup_test_run',
  };
  return { deps, uploads, runRecords, audits };
}

describe('runBackup', () => {
  it('produces a manifest whose counts and sha256 match the fixture data', async () => {
    const fixture = {
      users: [
        { id: 'u1', data: { name: 'A' } },
        { id: 'u2', data: { name: 'B' } },
      ],
      blogs: [{ id: 'b1', data: { title: 'Hello' } }],
      audit_logs: [{ id: 'a1', data: { action: 'X' } }],
    };
    const { deps, uploads, runRecords } = makeDeps(fixture);
    const result = await runBackup(deps, {
      collections: ['users', 'blogs', 'audit_logs'],
    });

    expect(result.status).toBe('success');
    expect(result.manifest).not.toBeNull();
    const manifest = result.manifest!;
    expect(manifest.totals).toEqual({
      collections: 3,
      documents: 4,
      bytes: expect.any(Number),
    });

    // Each collection's recorded sha256 equals the hash of its uploaded JSON.
    for (const entry of manifest.collections) {
      const upload = uploads.find((u) =>
        u.fileName.endsWith(`__${entry.name}.json`),
      );
      expect(upload).toBeDefined();
      const expected = createHash('sha256')
        .update(upload!.buffer)
        .digest('hex');
      expect(entry.sha256).toBe(expected);
      const payload = JSON.parse(upload!.buffer.toString('utf8'));
      expect(payload.collection).toBe(entry.name);
      expect(payload.count).toBe(entry.count);
      expect(payload.docs).toHaveLength(entry.count);
    }

    // The manifest itself was uploaded, and the run record written.
    expect(
      uploads.some((u) => u.fileName.endsWith('manifest.json')),
    ).toBe(true);
    expect(runRecords).toHaveLength(1);
    expect(result.manifestDriveFileId).not.toBeNull();
  });

  it('never uploads anything as public', async () => {
    const { deps, uploads } = makeDeps({ users: [{ id: 'u1', data: {} }] });
    await runBackup(deps, { collections: ['users'] });
    expect(uploads.length).toBeGreaterThan(0);
    for (const u of uploads) {
      expect(u.makePublic).toBe(false);
      expect(u.folderId).toBe('backups-folder-1');
    }
  });

  it('records a failing collection and finishes partial, not aborted', async () => {
    const { deps, runRecords, audits } = makeDeps(
      { users: [{ id: 'u1', data: {} }], blogs: [] },
      ['blogs'],
    );
    const result = await runBackup(deps, {
      collections: ['users', 'blogs'],
    });
    expect(result.status).toBe('partial');
    expect(result.errors).toEqual([
      { collection: 'blogs', message: expect.stringContaining('boom') },
    ]);
    expect(result.manifest!.collections.map((c) => c.name)).toEqual(['users']);
    expect(runRecords).toHaveLength(1);
    expect(audits.some((a) => a.action === 'BACKUP_RUN_PARTIAL')).toBe(true);
  });

  it('serialises Firestore-like values defensively', async () => {
    const ts = { toDate: () => new Date('2026-01-02T03:04:05.000Z') };
    const { deps, uploads } = makeDeps({
      users: [{ id: 'u1', data: { createdAt: ts, plain: 1 } }],
    });
    await runBackup(deps, { collections: ['users'] });
    const payload = JSON.parse(uploads[0].buffer.toString('utf8'));
    expect(payload.docs[0].data.plain).toBe(1);
    expect(typeof payload.docs[0].data.createdAt).toBe('string');
  });
});
