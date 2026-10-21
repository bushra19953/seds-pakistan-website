#!/usr/bin/env node
/**
 * Generate a small SYNTHETIC backup fixture in the exact format the
 * backup engine produces (Workstream F): one JSON payload per
 * collection named `<runId>__<collection>.json` plus manifest.json.
 * All data is invented test data. Used by scripts/restore-verify.mjs
 * drills. Never point this at real data.
 *
 * Usage: node scripts/make-backup-fixture.mjs [outDir]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] || join(process.cwd(), '.fixtures', 'backup-fixture');
const runId = 'run-fixture';
const exportedAt = '2026-10-21T00:00:00.000Z';

const collections = {
  users: [
    { id: 'u1', data: { displayName: 'Fixture One', role: 'member' } },
    { id: 'u2', data: { displayName: 'Fixture Two', role: 'member' } },
  ],
  audit_logs: [{ id: 'a1', data: { type: 'FIXTURE' } }],
  governance_records: [],
};

mkdirSync(outDir, { recursive: true });
const manifestCollections = [];
for (const [name, docs] of Object.entries(collections)) {
  const payload = { collection: name, exportedAt, count: docs.length, docs };
  const json = JSON.stringify(payload, null, 2);
  const buffer = Buffer.from(json, 'utf8');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const fileName = `${runId}__${name}.json`;
  writeFileSync(join(outDir, fileName), buffer);
  manifestCollections.push({
    name,
    backupClass: 'full',
    count: docs.length,
    sha256,
    driveFileId: `fixture-${name}`,
  });
}
const manifest = {
  runId,
  startedAt: exportedAt,
  finishedAt: exportedAt,
  collections: manifestCollections,
  totals: {
    collections: manifestCollections.length,
    documents: manifestCollections.reduce((s, c) => s + c.count, 0),
    bytes: 0,
  },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Fixture backup written to ${outDir} (${manifestCollections.length} collections)`);
