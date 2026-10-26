/**
 * @jest-environment node
 *
 * REGRESSION PIN — live defect #2 (role grants do not persist, and the
 * wider tasks/submissions/applications/chapters flips were silent
 * no-ops): seams loaded the Supabase adapter through
 *   await import(/* webpackIgnore: true *\/ specifier)
 * with specifier = '@/lib/supa' (or '@/lib/supa/adapter'). webpackIgnore
 * preserves the raw tsconfig alias in the emitted bundle; the standalone
 * Node server has no alias resolution, so the import rejected on EVERY
 * call in production, the loaders' catches cached null permanently, and
 * every mirror through those seams silently never ran — while the
 * statically-imported seams (blog, crm, admin-audit) worked. Mocked
 * contract suites could not see it: they inject adapters.
 *
 * This source-level pin fails if any production file under src/
 * contains a webpackIgnore dynamic import whose specifier is an '@/…'
 * alias — literal in the call, or via a same-file variable assigned an
 * '@/…' literal (the exact shape all ten defective loaders used).
 *
 * Extended for live-defect follow-up F-1 (workflow-members seam): a
 * BARE variable-specifier dynamic import — `import(specifier)` with no
 * webpackIgnore comment at all, where the variable is assigned an
 * '@/…' literal in the same file — is the same defect family. Webpack
 * cannot statically resolve a variable specifier to the alias target
 * whether or not webpackIgnore is present, so the original pin (which
 * only matched the webpackIgnore form) sailed past
 * src/lib/server/workflow-members-supa.ts while its loader was
 * suspect-dead in the standalone bundle. The extension below matches
 * that shape; literal alias imports without webpackIgnore stay clean
 * (the bundler resolves a literal specifier), as do variable
 * specifiers assigned relative ('./…') literals.
 * Test files are out of scope (they are not in the shipped bundle, and
 * this file itself must quote the pattern); the bundle-level companion
 * check is ~/workspace/supabase-migration/diagnosis/
 * check-bundle-no-alias-import.sh.
 *
 * Written under the resource freeze; NOT run by its author — the
 * coordinator runs it post-RELEASE (see live-fixes.md, gates
 * PENDING-FREEZE).
 */

import * as fs from 'fs';
import * as path from 'path';

const srcRoot = path.join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(file: string): boolean {
  return (
    file.includes(`${path.sep}__tests__${path.sep}`) ||
    /\.test\.(ts|tsx)$/.test(file) ||
    /\.spec\.(ts|tsx)$/.test(file)
  );
}

/** Offending alias dynamic imports in one file's source. */
function offenses(source: string): string[] {
  const found: string[] = [];
  const importRe = /import\s*\(\s*\/\*\s*webpackIgnore:\s*true\s*\*\/([^)]*)\)/g;
  for (const m of source.matchAll(importRe)) {
    const arg = (m[1] ?? '').trim();
    if (/['"]@\//.test(arg)) {
      found.push(`literal alias specifier: import(/* webpackIgnore: true */ ${arg})`);
      continue;
    }
    // Variable specifier: resolve a same-file assignment of an '@/…'
    // literal to that identifier (incl. `process.env.X || '@/…'`).
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(arg)?.[0];
    if (ident) {
      const assignRe = new RegExp(
        `(?:const|let|var)\\s+${ident}\\b[^;=]*=[^;]*['"]@/`,
      );
      if (assignRe.test(source)) {
        found.push(`variable alias specifier '${ident}' assigned an '@/…' literal`);
      }
    }
  }
  // Bare variable specifier WITHOUT webpackIgnore (F-1 shape): the
  // argument is a lone identifier, and webpack has nothing static to
  // resolve it against. Flag it when that identifier is assigned an
  // '@/…' literal in the same file (same resolution as above).
  const bareVarImportRe = /import\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g;
  for (const m of source.matchAll(bareVarImportRe)) {
    const ident = m[1] ?? '';
    const assignRe = new RegExp(
      `(?:const|let|var)\\s+${ident}\\b[^;=]*=[^;]*['"]@/`,
    );
    if (assignRe.test(source)) {
      found.push(
        `bare variable alias specifier '${ident}' assigned an '@/…' literal (no webpackIgnore)`,
      );
    }
  }
  return found;
}

describe('no webpackIgnore dynamic import with an @/ alias specifier (live defect #2 pin)', () => {
  it('scans every production source file under src/', () => {
    const files = walk(srcRoot).filter((f) => !isTestFile(f));
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const file of files) {
      const hits = offenses(fs.readFileSync(file, 'utf8'));
      for (const hit of hits) {
        bad.push(`${path.relative(srcRoot, file)}: ${hit}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the detector itself catches the defective shapes (pin is not vacuous)', () => {
    const literal = `const m = await import(/* webpackIgnore: true */ '@/lib/supa');`;
    const variable = [
      `const specifier = '@/lib/supa';`,
      `const m = await import(/* webpackIgnore: true */ specifier);`,
    ].join('\n');
    const envFallback = [
      `const specifier: string = process.env.SUPA_ADAPTER_SPECIFIER || '@/lib/supa/adapter';`,
      `const m = await import(/* webpackIgnore: true */ specifier);`,
    ].join('\n');
    expect(offenses(literal)).toHaveLength(1);
    expect(offenses(variable)).toHaveLength(1);
    expect(offenses(envFallback)).toHaveLength(1);
    // F-1 shape: bare variable specifier, no webpackIgnore anywhere —
    // the exact workflow-members-supa.ts loader that this pin missed.
    const bareVariable = [
      `const specifier: string = '@/lib/supa';`,
      `const m = (await import(specifier)) as SupaModuleLike;`,
    ].join('\n');
    expect(offenses(bareVariable)).toHaveLength(1);
    // Non-defective shapes stay clean: bundled alias import (no
    // webpackIgnore) and relative dynamic imports.
    expect(offenses(`const m = await import('@/lib/supa');`)).toEqual([]);
    expect(offenses(`const m = await import('./supa');`)).toEqual([]);
    // A variable specifier assigned a RELATIVE literal stays clean:
    // the seam-tasks-delegate loader iterates ['./adapter', './index']
    // through a loop variable, which is not an alias specifier.
    const relativeVariable = [
      `const specifier: string = './supa';`,
      `const m = await import(specifier);`,
    ].join('\n');
    expect(offenses(relativeVariable)).toEqual([]);
  });
});
