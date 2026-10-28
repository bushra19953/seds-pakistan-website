/**
 * APPS-2 client seam tests (Supabase migration).
 *
 * Pins three things, all with mocks/source only (zero live reads):
 *  1. The client flag hint defaults OFF and only turns on when the
 *     NEXT_PUBLIC surface list names 'applications' or '*'.
 *  2. The inventory covers every assigned APPS-2 file, marks both
 *     listener reads as listener-class, flags the audit_logs read as
 *     cross-cluster, and approves NO new server path (every ruling is
 *     a leave-as-is ruling).
 *  3. The listener and write paths are still in the source, unripped:
 *     ApplicationList still listens on the applications collection,
 *     the chapter page still uses onSnapshot, the admin page still
 *     PATCHes universal-review for approve, and the induction submit
 *     still goes through its atomic batch (run server-side by
 *     POST /api/induction/submit since WS10).
 *
 * Quirk preservation is pinned at source level for the two named
 * quirks: the date-filter bound construction in ApplicationList
 * (local-parse + setHours end-of-day) is unchanged.
 * No em dashes are used in test names in this file.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  APPLICATIONS_CLIENT_INVENTORY,
  APPLICATIONS_SUPA_SURFACE,
  applicationsSupaClientEnabled,
} from '../applications-client-supa';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function readSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('applications client flag hint', () => {
  test('defaults OFF when the surface list is unset or empty', () => {
    expect(applicationsSupaClientEnabled(undefined)).toBe(false);
    expect(applicationsSupaClientEnabled('')).toBe(false);
    expect(applicationsSupaClientEnabled(' , ')).toBe(false);
  });

  test('turns on only for the applications surface or a wildcard', () => {
    expect(APPLICATIONS_SUPA_SURFACE).toBe('applications');
    expect(applicationsSupaClientEnabled('applications')).toBe(true);
    expect(applicationsSupaClientEnabled('announcements, Applications ')).toBe(true);
    expect(applicationsSupaClientEnabled('*')).toBe(true);
    expect(applicationsSupaClientEnabled('announcements,directory')).toBe(false);
  });
});

describe('applications client inventory', () => {
  test('covers every assigned APPS-2 file', () => {
    const files = new Set(APPLICATIONS_CLIENT_INVENTORY.map((e) => e.file));
    expect(files).toEqual(
      new Set([
        'src/components/admin/applications/application-list.tsx',
        'src/components/admin/applications/intake-pace-line.tsx',
        'src/app/admin/applications/page.tsx',
        'src/app/admin/chapter-applications/page.tsx',
        'src/app/induction/page.tsx',
      ]),
    );
    for (const entry of APPLICATIONS_CLIENT_INVENTORY) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry.file))).toBe(true);
      expect(entry.shape.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  test('marks both live reads as listener class and never approves a new route', () => {
    const listeners = APPLICATIONS_CLIENT_INVENTORY.filter(
      (e) => e.ruling === 'listener',
    );
    expect(listeners.map((e) => e.id).sort()).toEqual([
      'apps2-chapter-listener',
      'apps2-list-applications',
    ]);
    // Every ruling in this group is a leave-as-is ruling: nothing here
    // claims a migrated or newly invented server path.
    const allowed = new Set([
      'server-routed',
      'listener',
      'client-direct',
      'shared-lib-flag-only',
      'presentational',
    ]);
    for (const entry of APPLICATIONS_CLIENT_INVENTORY) {
      expect(allowed.has(entry.ruling)).toBe(true);
    }
  });

  test('flags the audit_logs read and the shared submit libs as cross-cluster', () => {
    const audit = APPLICATIONS_CLIENT_INVENTORY.find(
      (e) => e.id === 'apps2-admin-audit-logs',
    );
    expect(audit?.collection).toBe('audit_logs');
    expect(audit?.note).toContain('NOT this cluster');
    const shared = APPLICATIONS_CLIENT_INVENTORY.find(
      (e) => e.id === 'apps2-induction-shared-helpers',
    );
    expect(shared?.ruling).toBe('shared-lib-flag-only');
  });
});

describe('listener and decision paths stay in place (source pins)', () => {
  test('ApplicationList still listens on the applications collection', () => {
    const src = readSource('src/components/admin/applications/application-list.tsx');
    expect(src).toContain('collection(firestore, "applications")');
    expect(src).toContain('useCollection<DocumentData>(applicationsQuery, { listen: true })');
    expect(src).toContain('where("status", "==", statusFilter)');
  });

  test('chapter applications page still uses its onSnapshot listener and server decisions', () => {
    const src = readSource('src/app/admin/chapter-applications/page.tsx');
    expect(src).toContain("collection(firestore, 'chapter_applications')");
    expect(src).toContain('onSnapshot(q, snap =>');
    expect(src).toContain("orderBy('createdAt', 'desc')");
    expect(src).toContain('limit(100)');
    expect(src).toContain("fetch('/api/chapter-applications'");
    expect(src).toContain("method: 'PATCH'");
    expect(src).toContain("method: 'DELETE'");
  });

  test('admin applications approve still PATCHes universal-review with the same body', () => {
    const src = readSource('src/app/admin/applications/page.tsx');
    expect(src).toContain("fetch('/api/admin/universal-review'");
    expect(src).toContain("collection: 'applications'");
    expect(src).toContain("action: 'approve'");
  });

  test('induction submit still writes applications and users atomically — one transaction since SEC-RACE', () => {
    // WS10 relocation: the page posts its payload to
    // POST /api/induction/submit, which ran the same atomic batch
    // server-side (Admin SDK shape). SEC-RACE (2026-10-28 security
    // wave, audit item 11) replaced the batch with one runTransaction
    // so the hasApplied gate reads and both writes commit atomically
    // (a batch cannot read, so it could not gate). The pins follow
    // the write's new shape; the page keeps no batch of its own.
    const src = readSource('src/app/induction/page.tsx');
    expect(src).toContain("serverWrite('/api/induction/submit', 'POST'");
    expect(src).not.toContain('writeBatch(db)');
    const route = readSource('src/app/api/induction/submit/route.ts');
    expect(route).toContain('db.runTransaction(');
    expect(route).toContain('t.set(appRef, applicationData)');
    expect(route).toContain('t.set(userRef, flagUpdate, { merge: true })');
  });
});

describe('preserved UI quirks (source pins)', () => {
  test('date filter bounds keep the local-parse plus end-of-day construction', () => {
    const src = readSource('src/components/admin/applications/application-list.tsx');
    // Quirk 2: filter bounds are built from local Date parsing while
    // rows render toLocaleDateString; the mismatch is preserved.
    expect(src).toContain('const from = new Date(fromDate).getTime();');
    expect(src).toContain('to.setHours(23, 59, 59, 999);');
    expect(src).toContain('app.created_at.toDate().toLocaleDateString');
  });

  test('list rows still render status through StatusBadge with no local status rewrite', () => {
    const src = readSource('src/components/admin/applications/application-list.tsx');
    // Quirk 1 guard: the list never rewrites a row status locally; the
    // badge shows the snapshot status, and the detail pane plus filter
    // counts remain authoritative.
    expect(src).toContain('<StatusBadge status={app.status as StatusType}');
    expect(src).not.toContain("status: 'approved'");
  });
});
