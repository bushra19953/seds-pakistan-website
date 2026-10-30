/**
 * check-read-ceilings.mjs — per-route Firestore read-ceiling gate
 * (structural quota prevention, founder's 2026-10-25 prevention plan).
 *
 * WHY THIS EXISTS: the app burned its full 50k/day Firestore Spark quota
 * on two consecutive nights (2026-10-28 and 2026-10-29; forensics in
 * ~/workspace/known_issues/QUOTA_BURN_FORENSICS_2026-10-30.md). Ceilings
 * existed only on paper. This gate makes them structural: every server
 * route under src/app/api/**\/route.ts declares a ceiling on its
 * statically-counted Firestore read call-sites in
 * config/read-ceilings.json, and this script FAILS the check when the
 * code drifts past the declaration.
 *
 * MODELLED ON: scripts/assert-baked-supa-surfaces.mjs (read-bleed
 * train 2) — dependency-free node, an intended set asserted loudly,
 * exit 1 with the exact offenders named.
 *
 * WHAT IT COUNTS (per route file, comments stripped first):
 *   - adminGet   `.get()` with no arguments — the Admin SDK terminator
 *                for Query.get(), DocumentReference.get() and
 *                .count().get() aggregations. (Every argument-taking
 *                `.get(x)` in this codebase is URLSearchParams /
 *                Headers / Cookies / Map access, never Firestore.)
 *   - txGet      `t.get(ref)` / `tx.get(ref)` / `trx.get(ref)` /
 *                `transaction.get(ref)` — transaction reads, which
 *                take the reference as an argument.
 *   - getAll     `.getAll(...)` — Firestore.getAll / Transaction.getAll.
 *   - clientSdk  `getDoc(`, `getDocs(`, `getCountFromServer(`,
 *                `onSnapshot(` — client-SDK read entry points when
 *                they appear in a server route file.
 * `.count()` call-sites are also reported (informational): their
 * terminating `.get()` is already counted under adminGet, never twice.
 *
 * WHAT IT CANNOT SEE (declared limitation, also in the manifest):
 * reads performed inside lib helpers (src/lib/**) that a route calls.
 * Only the route's own file is counted. A route whose own file is
 * seam-only scores 0 even if a helper it imports reads Firestore
 * behind the seam flag. Precision about what the gate can see beats
 * false coverage.
 *
 * FAILS (exit 1) when:
 *   1. a route file exists with no manifest entry;
 *   2. a manifest entry names a route file that no longer exists;
 *   3. a route's counted reads exceed its declared ceiling;
 *   4. the census allowlist GROWS past the pinned baseline
 *      (config/read-ceilings.baseline.json): either the number of
 *      non-zero-ceiling routes or the total ceiling sum exceeds the
 *      baseline. Shrinking is always allowed — lower the baseline in
 *      the same commit that lowers the manifest; that is the
 *      shrink-only mechanism.
 *
 * USAGE:
 *   node scripts/check-read-ceilings.mjs [--root DIR] [--json]
 *   node scripts/check-read-ceilings.mjs --emit-manifest   (print a
 *     manifest with ceilings set to today's counted reads; used to
 *     bootstrap and to re-count at rebase time)
 * Exit 0 = PASS, exit 1 = FAIL.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_REL = 'config/read-ceilings.json';
export const BASELINE_REL = 'config/read-ceilings.baseline.json';
export const API_REL = 'src/app/api';

/**
 * Replace // and /* *\/ comments with spaces (newlines preserved, so
 * line numbers stay true) while leaving string / template contents
 * untouched. A comment that merely MENTIONS a read shape (e.g.
 * src/app/api/cron/backup/route.ts documents an "unbounded
 * collection.get()") must never be counted as a call-site.
 */
export function stripComments(source) {
  const out = source.split('');
  let i = 0;
  let state = 'code'; // code | line | block | sq | dq | tpl
  const tplDepth = []; // brace depth at each ${ entry
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line'; continue; }
      if (c === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block'; continue; }
      if (c === "'") { state = 'sq'; i += 1; continue; }
      if (c === '"') { state = 'dq'; i += 1; continue; }
      if (c === '`') { state = 'tpl'; i += 1; continue; }
      if (c === '{') { depth += 1; i += 1; continue; }
      if (c === '}') {
        if (tplDepth.length && depth === tplDepth[tplDepth.length - 1]) {
          tplDepth.pop(); state = 'tpl';
        } else depth -= 1;
        i += 1; continue;
      }
      i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code'; else out[i] = ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'code'; continue; }
      if (c !== '\n') out[i] = ' ';
      i += 1; continue;
    }
    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (c === '\\') { i += 2; continue; }
      if (c === quote) state = 'code';
      i += 1; continue;
    }
    // tpl
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { state = 'code'; i += 1; continue; }
    if (c === '$' && next === '{') { tplDepth.push(depth); state = 'code'; i += 2; continue; }
    i += 1; continue;
  }
  return out.join('');
}

const PATTERNS = [
  // [kind, regex, offset of the canonical call position within the match]
  ['txGet', /\b(?:t|tx|trx|transaction)\.get\s*\(/g, (m) => m[0].indexOf('.get')],
  ['adminGet', /\.get\s*\(\s*\)/g, () => 0],
  ['getAll', /\.getAll\s*\(/g, () => 0],
  ['getDoc', /\bgetDoc\s*\(/g, () => 0],
  ['getDocs', /\bgetDocs\s*\(/g, () => 0],
  ['getCountFromServer', /\bgetCountFromServer\s*\(/g, () => 0],
  ['onSnapshot', /\bonSnapshot\s*\(/g, () => 0],
];

/**
 * Count Firestore read call-sites in one route file's source.
 * Call-sites are deduplicated by the position of the read call itself,
 * so a shape matched by two patterns (e.g. an empty-arg tx.get) counts
 * once. Returns { total, breakdown } where breakdown.countAggregations
 * is informational only (its .get() is already inside adminGet).
 */
export function countRouteReads(source) {
  const clean = stripComments(source);
  const sites = new Map(); // position -> kind
  const breakdown = {
    adminGet: 0, txGet: 0, getAll: 0, getDoc: 0, getDocs: 0,
    getCountFromServer: 0, onSnapshot: 0, countAggregations: 0,
  };
  for (const [kind, re, offsetOf] of PATTERNS) {
    for (const match of clean.matchAll(re)) {
      const pos = match.index + offsetOf(match);
      if (!sites.has(pos)) {
        sites.set(pos, kind);
        breakdown[kind] += 1;
      }
    }
  }
  for (const _m of clean.matchAll(/\.count\s*\(\s*\)/g)) {
    breakdown.countAggregations += 1;
  }
  return { total: sites.size, breakdown };
}

/** Recursively list route files under <root>/src/app/api as root-relative POSIX paths. */
export function listRouteFiles(root) {
  const apiDir = join(root, API_REL);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === 'route.ts') {
        found.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  if (existsSync(apiDir)) walk(apiDir);
  return found.sort();
}

export function manifestTotals(manifest) {
  const entries = Object.entries(manifest.routes ?? {});
  let allowlistedRoutes = 0;
  let ceilingSum = 0;
  for (const [, v] of entries) {
    const n = v?.firestoreReads;
    if (typeof n === 'number' && n > 0) allowlistedRoutes += 1;
    if (typeof n === 'number') ceilingSum += n;
  }
  return { routesCovered: entries.length, allowlistedRoutes, ceilingSum };
}

/**
 * Run the gate. Returns { ok, failures: string[], rows, totals }.
 * Pure with respect to its arguments (all file reads happen in main
 * and in listRouteFiles' directory walk) so tests can drive it
 * through the CLI on synthetic trees.
 */
export function checkReadCeilings({ root, manifest, baseline }) {
  const failures = [];
  const routeFiles = listRouteFiles(root);
  const entries = manifest.routes ?? {};

  for (const key of Object.keys(entries)) {
    const n = entries[key]?.firestoreReads;
    if (!Number.isInteger(n) || n < 0) {
      failures.push(`INVALID CEILING: ${key} has firestoreReads=${JSON.stringify(n)} (must be a non-negative integer)`);
    }
  }

  const rows = [];
  for (const route of routeFiles) {
    const counted = countRouteReads(readFileSync(join(root, route), 'utf8')).total;
    if (!(route in entries)) {
      failures.push(`MISSING MANIFEST ENTRY: ${route} exists on disk (counted ${counted} read call-site(s)) but has no entry in ${MANIFEST_REL}`);
      rows.push({ route, counted, ceiling: null, status: 'missing-entry' });
      continue;
    }
    const ceiling = entries[route].firestoreReads;
    const over = typeof ceiling === 'number' && counted > ceiling;
    if (over) {
      failures.push(`CEILING BREACH: ${route} counted ${counted} Firestore read call-site(s) > ceiling ${ceiling}`);
    }
    rows.push({ route, counted, ceiling, status: over ? 'breach' : 'ok' });
  }
  for (const key of Object.keys(entries)) {
    if (!routeFiles.includes(key)) {
      failures.push(`STALE MANIFEST ENTRY: ${key} is in ${MANIFEST_REL} but no such route file exists`);
    }
  }

  const totals = manifestTotals(manifest);
  if (baseline) {
    if (totals.allowlistedRoutes > baseline.allowlistedRoutes) {
      failures.push(`ALLOWLIST GROWTH: manifest has ${totals.allowlistedRoutes} non-zero-ceiling route(s) > baseline ${baseline.allowlistedRoutes} (shrink-only: a new Firestore-reading route needs a founder-visible baseline change, not silent growth)`);
    }
    if (totals.ceilingSum > baseline.ceilingSum) {
      failures.push(`CEILING-SUM GROWTH: manifest ceiling sum ${totals.ceilingSum} > baseline ${baseline.ceilingSum} (shrink-only: raising a ceiling needs a founder-visible baseline change in the same commit)`);
    }
  } else {
    failures.push(`MISSING BASELINE: ${BASELINE_REL} not found or unreadable`);
  }

  return { ok: failures.length === 0, failures, rows, totals };
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function emitManifest(root) {
  const routes = {};
  for (const route of listRouteFiles(root)) {
    const { total } = countRouteReads(readFileSync(join(root, route), 'utf8'));
    routes[route] = total;
  }
  return routes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const asJson = args.includes('--json');

  if (args.includes('--emit-manifest')) {
    const routes = emitManifest(root);
    const lines = Object.entries(routes).map(
      ([k, v]) => `    ${JSON.stringify(k)}: { "firestoreReads": ${v} }`,
    );
    console.log(`{\n  "routes": {\n${lines.join(',\n')}\n  }\n}`);
    process.exit(0);
  }

  const manifest = loadJson(join(root, MANIFEST_REL));
  if (!manifest) {
    console.error(`READ-CEILINGS FAIL: cannot read ${MANIFEST_REL} under ${root}`);
    process.exit(1);
  }
  const baseline = loadJson(join(root, BASELINE_REL));
  const result = checkReadCeilings({ root, manifest, baseline });

  if (asJson) {
    console.log(JSON.stringify({ ok: result.ok, totals: result.totals, failures: result.failures, rows: result.rows }, null, 2));
  } else if (result.ok) {
    console.log(
      `READ-CEILINGS OK: ${result.totals.routesCovered} route(s) covered, ` +
      `${result.totals.allowlistedRoutes} allowlisted (Firestore-reading), ` +
      `ceiling sum ${result.totals.ceilingSum} ` +
      `(baseline: ${baseline.allowlistedRoutes} routes / ${baseline.ceilingSum}).`,
    );
  } else {
    console.error(`READ-CEILINGS FAIL (${result.failures.length} problem(s)):`);
    for (const f of result.failures) console.error(`  - ${f}`);
  }
  process.exit(result.ok ? 0 : 1);
}
