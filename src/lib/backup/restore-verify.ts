// Restore verification (Workstream F). Pure functions: given a backup
// manifest and the per-collection file bytes, verify that the set is
// complete against the collection registry, that every file parses in
// the engine's format, that counts agree, and that sha256 hashes match
// (tamper detection). The drill restores into an in-memory scratch store
// only; nothing here writes to any database.

import { createHash } from 'node:crypto';
import { collectionsForBackup } from './registry';
import type { BackupManifest } from './engine';

export interface VerifyProblem {
  collection: string | null;
  kind:
    | 'missing-collection'
    | 'missing-file'
    | 'hash-mismatch'
    | 'count-mismatch'
    | 'bad-format';
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: VerifyProblem[];
  verifiedCollections: Array<{ name: string; count: number }>;
  totalDocuments: number;
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a backup set. `files` maps collection name -> raw file bytes
 * (the `<runId>__<collection>.json` payloads). Completeness is judged
 * against the full registry (collectionsForBackup(true)).
 */
export function verifyBackupSet(
  manifest: BackupManifest,
  files: Map<string, Buffer>,
): VerifyResult {
  const problems: VerifyProblem[] = [];
  const verified: Array<{ name: string; count: number }> = [];
  let totalDocuments = 0;

  const expected = collectionsForBackup(true).map((e) => e.name);
  const inManifest = new Map(manifest.collections.map((c) => [c.name, c]));
  for (const name of expected) {
    if (!inManifest.has(name)) {
      problems.push({
        collection: name,
        kind: 'missing-collection',
        message: `Collection ${name} is in the registry but absent from the backup manifest`,
      });
    }
  }

  for (const entry of manifest.collections) {
    const buffer = files.get(entry.name);
    if (!buffer) {
      problems.push({
        collection: entry.name,
        kind: 'missing-file',
        message: `No file bytes supplied for ${entry.name}`,
      });
      continue;
    }
    if (sha256Of(buffer) !== entry.sha256) {
      problems.push({
        collection: entry.name,
        kind: 'hash-mismatch',
        message: `sha256 mismatch for ${entry.name} (tampered or corrupted)`,
      });
      continue;
    }
    let payload: {
      collection?: unknown;
      count?: unknown;
      docs?: unknown;
    };
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch {
      problems.push({
        collection: entry.name,
        kind: 'bad-format',
        message: `${entry.name} file is not valid JSON`,
      });
      continue;
    }
    if (
      payload.collection !== entry.name ||
      !Array.isArray(payload.docs) ||
      typeof payload.count !== 'number'
    ) {
      problems.push({
        collection: entry.name,
        kind: 'bad-format',
        message: `${entry.name} payload does not match the backup engine format`,
      });
      continue;
    }
    if (payload.count !== entry.count || payload.docs.length !== entry.count) {
      problems.push({
        collection: entry.name,
        kind: 'count-mismatch',
        message: `${entry.name}: manifest count ${entry.count}, payload count ${payload.count}, docs ${payload.docs.length}`,
      });
      continue;
    }
    verified.push({ name: entry.name, count: entry.count });
    totalDocuments += entry.count;
  }

  return {
    ok: problems.length === 0,
    problems,
    verifiedCollections: verified,
    totalDocuments,
  };
}

/**
 * The drill: load a verified backup set into an in-memory scratch store
 * (collection -> Map(id -> data)) and report what landed. Throws on a
 * failed verification - a backup that does not verify is never restored.
 */
export function restoreToScratch(
  manifest: BackupManifest,
  files: Map<string, Buffer>,
): Map<string, Map<string, unknown>> {
  const result = verifyBackupSet(manifest, files);
  if (!result.ok) {
    throw new Error(
      `Backup verification failed: ${result.problems
        .map((p) => `${p.collection ?? 'manifest'}: ${p.message}`)
        .join('; ')}`,
    );
  }
  const store = new Map<string, Map<string, unknown>>();
  for (const entry of manifest.collections) {
    const payload = JSON.parse(
      (files.get(entry.name) as Buffer).toString('utf8'),
    ) as { docs: Array<{ id: string; data: unknown }> };
    const coll = new Map<string, unknown>();
    for (const doc of payload.docs) coll.set(doc.id, doc.data);
    store.set(entry.name, coll);
  }
  return store;
}
