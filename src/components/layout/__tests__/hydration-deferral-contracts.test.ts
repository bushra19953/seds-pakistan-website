/**
 * Hydration-deferral contracts (wave-2 perf, agent 3 — selective hydration).
 *
 * These tests pin the deferral decisions that keep non-critical modules off
 * the eager hydration path of every public page:
 *
 * 1. html2canvas (~4.4 MB package, only needed when a user clicks
 *    "capture screenshot" in the bug-report popover) must be loaded with a
 *    dynamic import() inside the capture handler — never a static import.
 * 2. BugReportButton itself is an always-mounted shell passenger that no
 *    public page needs for first paint; the app client shell must mount it
 *    via next/dynamic (ssr:false), not a static import.
 * 3. NotificationCenter (848 lines; drags firebase/messaging via
 *    lib/push-notifications plus the announcements + supa-notifications
 *    clients) renders null while signed out (header F7 note). The header
 *    must therefore load it via next/dynamic and only mount it when a user
 *    is signed in — so signed-out visitors never download or parse it.
 * 4. The shell graph (header, mandatory profile gate, the site-settings /
 *    authorization hooks, and the two analytics trackers) must import
 *    Firebase hooks from their deep modules, never from the '@/firebase'
 *    barrel — the barrel's module body imports firebase/analytics and
 *    firebase/performance, which no shell passenger uses.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');

function readSrc(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

describe('hydration deferral contracts', () => {
  it('bug-report-button loads html2canvas lazily inside the capture handler', () => {
    const src = readSrc('components/admin/bug-report-button.tsx');
    expect(src).not.toMatch(/import\s+html2canvas\s+from\s+['"]html2canvas['"]/);
    expect(src).toMatch(/await\s+import\(['"]html2canvas['"]\)/);
  });

  it('app client shell mounts BugReportButton via next/dynamic, not a static import', () => {
    const src = readSrc('components/layout/app-client-shell.tsx');
    expect(src).not.toMatch(
      /import\s+BugReportButton\s+from\s+['"]@\/components\/admin\/bug-report-button['"]/
    );
    expect(src).toMatch(
      /dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/admin\/bug-report-button['"]\)/
    );
  });

  it('header loads NotificationCenter via next/dynamic and mounts it only for signed-in users', () => {
    const src = readSrc('components/layout/header.tsx');
    expect(src).not.toMatch(
      /import\s+NotificationCenter\s+from\s+['"]@\/components\/notifications\/notification-center['"]/
    );
    expect(src).toMatch(
      /dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/notifications\/notification-center['"]\)/
    );
    // Signed-out visitors must not even mount it: it renders null for them.
    expect(src).toMatch(/\{\s*user\s*\?\s*<NotificationCenter\s*\/>\s*:\s*null\s*\}/);
  });

  it.each([
    'components/layout/header.tsx',
    'components/auth/mandatory-profile-check.tsx',
    'components/AnalyticsEventTracker.tsx',
    'components/PageVisitTracker.tsx',
    'hooks/use-site-settings.ts',
    'hooks/use-authorization.ts',
  ])('shell-graph file %s does not import the @/firebase barrel', (rel) => {
    const src = readSrc(rel);
    expect(src).not.toMatch(/from\s+['"]@\/firebase['"]/);
  });
});
