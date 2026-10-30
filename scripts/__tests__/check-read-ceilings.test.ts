/**
 * Tests for scripts/check-read-ceilings.mjs — the per-route Firestore
 * read-ceiling gate.
 *
 * The gate is a dependency-free .mjs CLI (same shape as
 * scripts/assert-baked-supa-surfaces.mjs), so these tests drive it
 * through its real CLI on synthetic route trees in a temp dir: the
 * exact binary, manifest format and exit codes the build uses.
 * No full-repo scan happens here.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'check-read-ceilings.mjs');
const createdRoots: string[] = [];

function makeTree(opts: {
  routes: Record<string, string>;
  manifest: Record<string, number>;
  baseline: { allowlistedRoutes: number; ceilingSum: number };
}): string {
  const root = mkdtempSync(join(tmpdir(), 'read-ceilings-'));
  createdRoots.push(root);
  for (const [rel, source] of Object.entries(opts.routes)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  mkdirSync(join(root, 'config'), { recursive: true });
  const manifestRoutes = Object.fromEntries(
    Object.entries(opts.manifest).map(([k, v]) => [k, { firestoreReads: v }]),
  );
  writeFileSync(
    join(root, 'config/read-ceilings.json'),
    JSON.stringify({ version: 1, routes: manifestRoutes }),
  );
  writeFileSync(
    join(root, 'config/read-ceilings.baseline.json'),
    JSON.stringify(opts.baseline),
  );
  return root;
}

function runGate(root: string, extraArgs: string[] = []) {
  const res = spawnSync('node', [SCRIPT, '--root', root, ...extraArgs], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

afterAll(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const READING_ROUTE = `
import { getDb } from '@/lib/server/firebase-admin';
export async function GET(request: Request) {
  const db = getDb();
  const a = await db.collection('users').doc('u1').get();
  const b = await db
    .collection('tasks')
    .where('status', '==', 'open')
    .limit(10)
    .get();
  const n = (await db.collection('tasks').count().get()).data().count;
  const all = await db.getAll(db.collection('users').doc('u2'));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.collection('users').doc('u3'));
    return snap;
  });
  const mode = request.nextUrl.searchParams.get('mode');
  const auth = request.headers.get('authorization');
  const cached = new Map([['k', 1]]).get('k');
  // db.collection('ghosts').get() — mentioned in a comment, not a call-site
  return Response.json({ a, b, n, all, mode, auth, cached });
}
`;
// READING_ROUTE call-sites: doc.get 1 + query.get 1 + count().get() 1
// (counted once, not twice) + getAll 1 + tx.get 1 = 5.
// searchParams/headers/Map .get(...) take arguments and are not reads.

const QUIET_ROUTE = `
export async function GET() {
  return Response.json({ ok: true });
}
`;

const CLIENT_SDK_ROUTE = `
import { getDoc, getDocs } from 'firebase/firestore';
export async function GET() {
  const one = await getDoc(refA);
  const many = await getDocs(queryB);
  return Response.json({ one, many });
}
`;

describe('check-read-ceilings gate', () => {
  it('counts Firestore read call-sites and ignores non-Firestore .get() and comments', () => {
    const root = makeTree({
      routes: { 'src/app/api/probe/route.ts': READING_ROUTE },
      manifest: { 'src/app/api/probe/route.ts': 5 },
      baseline: { allowlistedRoutes: 1, ceilingSum: 5 },
    });
    const { status, stdout } = runGate(root, ['--json']);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.rows).toEqual([
      { route: 'src/app/api/probe/route.ts', counted: 5, ceiling: 5, status: 'ok' },
    ]);
    expect(report.totals).toEqual({ routesCovered: 1, allowlistedRoutes: 1, ceilingSum: 5 });
  });

  it('counts client-SDK getDoc/getDocs in a server route file', () => {
    const root = makeTree({
      routes: { 'src/app/api/sdk/route.ts': CLIENT_SDK_ROUTE },
      manifest: { 'src/app/api/sdk/route.ts': 2 },
      baseline: { allowlistedRoutes: 1, ceilingSum: 2 },
    });
    const { status, stdout } = runGate(root, ['--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).rows[0].counted).toBe(2);
  });

  it('passes when every route is at or under its ceiling', () => {
    const root = makeTree({
      routes: {
        'src/app/api/probe/route.ts': READING_ROUTE,
        'src/app/api/quiet/route.ts': QUIET_ROUTE,
      },
      manifest: {
        'src/app/api/probe/route.ts': 5,
        'src/app/api/quiet/route.ts': 0,
      },
      baseline: { allowlistedRoutes: 1, ceilingSum: 5 },
    });
    const { status, stdout } = runGate(root);
    expect(status).toBe(0);
    expect(stdout).toContain('READ-CEILINGS OK');
  });

  it('fails and names the route when counted reads exceed the ceiling', () => {
    const root = makeTree({
      routes: { 'src/app/api/probe/route.ts': READING_ROUTE },
      manifest: { 'src/app/api/probe/route.ts': 4 },
      baseline: { allowlistedRoutes: 1, ceilingSum: 5 },
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain('CEILING BREACH');
    expect(stderr).toContain('src/app/api/probe/route.ts');
    expect(stderr).toContain('counted 5');
    expect(stderr).toContain('ceiling 4');
  });

  it('fails when a zero-ceiling (seam-only) route gains a Firestore read', () => {
    const root = makeTree({
      routes: { 'src/app/api/quiet/route.ts': READING_ROUTE },
      manifest: { 'src/app/api/quiet/route.ts': 0 },
      baseline: { allowlistedRoutes: 1, ceilingSum: 5 },
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain('CEILING BREACH');
    expect(stderr).toContain('src/app/api/quiet/route.ts');
  });

  it('fails and names a route file that has no manifest entry', () => {
    const root = makeTree({
      routes: {
        'src/app/api/probe/route.ts': READING_ROUTE,
        'src/app/api/brand-new/route.ts': READING_ROUTE,
      },
      manifest: { 'src/app/api/probe/route.ts': 5 },
      baseline: { allowlistedRoutes: 1, ceilingSum: 5 },
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain('MISSING MANIFEST ENTRY');
    expect(stderr).toContain('src/app/api/brand-new/route.ts');
  });

  it('fails on a stale manifest entry for a deleted route', () => {
    const root = makeTree({
      routes: { 'src/app/api/probe/route.ts': READING_ROUTE },
      manifest: {
        'src/app/api/probe/route.ts': 5,
        'src/app/api/gone/route.ts': 1,
      },
      baseline: { allowlistedRoutes: 2, ceilingSum: 6 },
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain('STALE MANIFEST ENTRY');
    expect(stderr).toContain('src/app/api/gone/route.ts');
  });

  it('fails when the allowlist grows past the pinned baseline (route count)', () => {
    const root = makeTree({
      routes: {
        'src/app/api/probe/route.ts': READING_ROUTE,
        'src/app/api/sdk/route.ts': CLIENT_SDK_ROUTE,
      },
      manifest: {
        'src/app/api/probe/route.ts': 5,
        'src/app/api/sdk/route.ts': 2,
      },
      baseline: { allowlistedRoutes: 1, ceilingSum: 99 },
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain('ALLOWLIST GROWTH');
  });

  it('fails when the ceiling sum grows past the pinned baseline', () => {
    const root = makeTree({
      routes: { 'src/app/api/probe/route.ts': READING_ROUTE },
      manifest: { 'src/app/api/probe/route.ts': 5 },
      baseline: { allowlistedRoutes: 1, ceilingSum: 4 },
    });
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain('CEILING-SUM GROWTH');
  });

  it('always allows shrinking below the baseline', () => {
    const root = makeTree({
      routes: {
        'src/app/api/probe/route.ts': QUIET_ROUTE,
        'src/app/api/quiet/route.ts': QUIET_ROUTE,
      },
      manifest: {
        'src/app/api/probe/route.ts': 0,
        'src/app/api/quiet/route.ts': 0,
      },
      baseline: { allowlistedRoutes: 2, ceilingSum: 9 },
    });
    const { status } = runGate(root);
    expect(status).toBe(0);
  });
});
