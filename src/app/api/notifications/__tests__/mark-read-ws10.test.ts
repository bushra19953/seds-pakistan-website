/**
 * @jest-environment node
 *
 * WS10 — notification-center mark-read pins (static only; the
 * PATCH /api/notifications route's behavior is contract-tested by
 * the notifications workstream's own suites).
 * The component's Firestore branch no longer writes client-side:
 * both mark-read and mark-all go through PATCH /api/notifications
 * (identity design S-20), while the Supa branch keeps its seam call.
 *
 * NOTE: written during the 2026-10-26 resource freeze; first run on
 * RELEASE.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('WS10 notification-center static pins', () => {
  it('performs no client Firestore write; both arms use the PATCH route', () => {
    const src = readFileSync(
      join(__dirname, '../../../../components/notifications/notification-center.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/from '@\/lib\/client\/firestore-wrapper'/);
    expect(src).toContain("serverWrite('/api/notifications', 'PATCH', { id })");
    expect(src).toContain("serverWrite('/api/notifications', 'PATCH', { all: true })");
    expect(src).toContain('supaMarkRead');
  });
});
