/**
 * Restore verification drill (Workstream F): builds a backup with the
 * REAL engine over an in-memory fake Firestore, captures the uploaded
 * bytes, then verifies and restores into a scratch store. No production
 * data, no Drive, no network.
 */
import {
  runBackup,
  type BackupDeps,
  type BackupManifest,
} from '../engine';
import { restoreToScratch, verifyBackupSet } from '../restore-verify';
import { collectionsForBackup } from '../registry';

function makeFakeDb() {
  const data: Record<string, Array<{ id: string; data: unknown }>> = {
    users: [
      { id: 'u1', data: { displayName: 'Test One' } },
      { id: 'u2', data: { displayName: 'Test Two' } },
    ],
    audit_logs: [{ id: 'a1', data: { type: 'TEST' } }],
  };
  return {
    collection(name: string) {
      return {
        async get() {
          const docs = (data[name] || []).map((d) => ({
            id: d.id,
            data: () => d.data,
          }));
          return { docs, size: docs.length, empty: docs.length === 0 };
        },
      };
    },
  };
}

async function buildBackup() {
  const files = new Map<string, Buffer>();
  let manifest: BackupManifest | null = null;
  const deps: BackupDeps = {
    db: makeFakeDb() as never,
    resolveFolderId: async () => 'fixture-folder',
    uploadToDrive: async ({ fileName, buffer }) => {
      if (fileName.endsWith('manifest.json')) {
        manifest = JSON.parse(buffer.toString('utf8'));
      } else {
        const name = fileName.split('__')[1].replace(/\.json$/, '');
        files.set(name, buffer);
      }
      return { id: `drive-${fileName}` };
    },
    writeRunRecord: async () => {},
    writeAudit: async () => {},
    now: () => new Date('2026-10-21T00:00:00.000Z'),
    runIdFactory: () => 'run-fixture',
  };
  const result = await runBackup(deps, { triggeredBy: 'test' });
  return { files, manifest: manifest as unknown as BackupManifest, result };
}

describe('restore-verify drill', () => {
  it('verifies a complete engine-produced backup and restores it to scratch', async () => {
    const { files, manifest, result } = await buildBackup();
    expect(result.status).toBe('success');
    expect(manifest.collections.length).toBe(collectionsForBackup(true).length);

    const verification = verifyBackupSet(manifest, files);
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    const store = restoreToScratch(manifest, files);
    expect(store.get('users')?.size).toBe(2);
    expect(store.get('audit_logs')?.get('a1')).toEqual({ type: 'TEST' });
    // auditLogs (legacy camelCase) is part of the set, exported empty.
    expect(store.has('auditLogs')).toBe(true);
  });

  it('detects tampering via sha256 mismatch', async () => {
    const { files, manifest } = await buildBackup();
    const tampered = new Map(files);
    tampered.set(
      'users',
      Buffer.from(tampered.get('users')!.toString('utf8').replace('Test One', 'Forged One'), 'utf8'),
    );
    const verification = verifyBackupSet(manifest, tampered);
    expect(verification.ok).toBe(false);
    expect(
      verification.problems.some(
        (p) => p.collection === 'users' && p.kind === 'hash-mismatch',
      ),
    ).toBe(true);
    expect(() => restoreToScratch(manifest, tampered)).toThrow(
      /verification failed/,
    );
  });

  it('reports a collection missing from the manifest as incomplete', async () => {
    const { files, manifest } = await buildBackup();
    const shortManifest: BackupManifest = {
      ...manifest,
      collections: manifest.collections.filter((c) => c.name !== 'users'),
    };
    const verification = verifyBackupSet(shortManifest, files);
    expect(verification.ok).toBe(false);
    expect(
      verification.problems.some(
        (p) => p.collection === 'users' && p.kind === 'missing-collection',
      ),
    ).toBe(true);
  });
});
