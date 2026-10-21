#!/usr/bin/env node
/**
 * Restore-into-scratch verification drill (Workstream F).
 *
 * Reads a backup directory produced by the backup engine (or by
 * scripts/make-backup-fixture.mjs), verifies manifest completeness
 * against the files present, per-file sha256 and counts, then loads
 * everything into an in-memory scratch store and reports. It NEVER
 * writes to Firestore or any database, and it refuses any target other
 * than fixture/emulator: a production restore is a separate, human-run
 * procedure that does not exist in this codebase on purpose.
 *
 * Usage:
 *   node scripts/restore-verify.mjs --dir <backupDir> --target fixture
 *
 * The authoritative completeness check against the full collection
 * registry lives in src/lib/backup/__tests__/restore-verify.test.ts
 * (this script cannot import the TypeScript registry).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const dir = argValue('--dir');
const target = argValue('--target');

if (!target || !['fixture', 'emulator'].includes(target)) {
  console.error(
    `Refused: --target must be "fixture" or "emulator" (got ${JSON.stringify(target)}). Production restores are not supported by this script.`,
  );
  process.exit(2);
}
if (!dir) {
  console.error('Refused: --dir <backupDir> is required.');
  process.exit(2);
}
const absDir = resolve(dir);
const workspace = resolve(process.cwd());
if (!absDir.startsWith(workspace)) {
  console.error(`Refused: backup dir ${absDir} is outside the workspace.`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(absDir, 'manifest.json'), 'utf8'));
const filesOnDisk = new Set(readdirSync(absDir));
const problems = [];
const scratch = new Map();

for (const entry of manifest.collections) {
  const fileName = `${manifest.runId}__${entry.name}.json`;
  if (!filesOnDisk.has(fileName)) {
    problems.push(`${entry.name}: file ${fileName} missing`);
    continue;
  }
  const buffer = readFileSync(join(absDir, fileName));
  const sha = createHash('sha256').update(buffer).digest('hex');
  if (sha !== entry.sha256) {
    problems.push(`${entry.name}: sha256 mismatch (tampered or corrupted)`);
    continue;
  }
  const payload = JSON.parse(buffer.toString('utf8'));
  if (payload.collection !== entry.name || payload.count !== entry.count || payload.docs.length !== entry.count) {
    problems.push(`${entry.name}: count mismatch (manifest ${entry.count}, payload ${payload.count}, docs ${payload.docs.length})`);
    continue;
  }
  const coll = new Map();
  for (const doc of payload.docs) coll.set(doc.id, doc.data);
  scratch.set(entry.name, coll);
  console.log(`OK ${entry.name}: ${entry.count} docs verified and loaded to scratch`);
}

if (problems.length > 0) {
  console.error(`\nFAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
const total = [...scratch.values()].reduce((s, c) => s + c.size, 0);
console.log(`\nRestore drill passed: ${scratch.size} collections, ${total} documents in scratch store. Nothing was written anywhere.`);
