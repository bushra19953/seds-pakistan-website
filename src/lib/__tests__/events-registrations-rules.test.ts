/**
 * Events registrations subcollection — rules-text + consumer-source
 * contract tests (attendees-panel blindness fix).
 *
 * Proven live defect (Oct 24, 2026, build 30f9f95): POST
 * /registerForEvent wrote the registration record server-side
 * (events/{eventId}/registrations/{uid}, Admin SDK — rules do not
 * apply), the counters on the event document moved, and every surface
 * reading the EVENT document agreed (registry 1/2, Overview
 * REGISTERED 1). But the admin Attendees panel reads the
 * REGISTRATIONS SUBCOLLECTION through the client SDK, and neither the
 * repo firestore.rules nor the live-published candidate (v4) carried
 * ANY rule for that subcollection — a parent-document match does not
 * cascade — so the panel's list query was permission-denied,
 * useCollection swallowed the denial silently, and the panel rendered
 * "Total: 0 of 2 / No registrations yet." The panel's client writes
 * (confirm / verify / cancel) were denied by the same gap.
 *
 * No rules emulator exists in this repo: the rules cases parse the
 * rules text (the established method, see announcements-rules.test.ts)
 * and the consumer cases pin the three source paths to one another —
 * writer (route), reader (panel), and ticket issuer must all name
 * the same subcollection or the mismatch returns.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const RULES_PATH =
  process.env.FIRESTORE_RULES_PATH || path.join(REPO_ROOT, 'firestore.rules');

const rules = fs.readFileSync(RULES_PATH, 'utf8');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function eventsBlock(): string {
  const start = rules.indexOf('match /events/{eventId} {');
  if (start === -1) throw new Error('events block not found');
  const end = rules.indexOf('match /workshops/', start);
  return rules.slice(start, end === -1 ? undefined : end);
}

function registrationsBlock(): string {
  const block = eventsBlock();
  const start = block.indexOf('match /registrations/{registrationId} {');
  if (start === -1) throw new Error('registrations subcollection match not found inside the events block');
  return block.slice(start);
}

describe('events registrations rules (text)', () => {
  it('1. a registrations match exists, nested inside the events block', () => {
    expect(eventsBlock()).toContain('match /registrations/{registrationId} {');
  });

  it('2. managers can list the subcollection (the panel query)', () => {
    expect(registrationsBlock()).toMatch(
      /allow list: if isSuperAdmin\(\) \|\| hasPermission\('canManageEvents'\)/,
    );
  });

  it('3. managers and the registrant can get a record; the registrant match is on the doc id (the uid)', () => {
    const block = registrationsBlock();
    expect(block).toMatch(/allow get: if isSuperAdmin\(\) \|\| hasPermission\('canManageEvents'\)/);
    expect(block).toContain('request.auth.uid == registrationId');
  });

  it('4. managers can create and update (panel confirm / verify / cancel)', () => {
    const block = registrationsBlock();
    expect(block).toMatch(/allow create: if isSuperAdmin\(\) \|\| hasPermission\('canManageEvents'\)/);
    expect(block).toMatch(/allow update: if isSuperAdmin\(\) \|\| hasPermission\('canManageEvents'\)/);
  });

  it('5. the registrant update branch is field-restricted to the payment-proof fields', () => {
    const block = registrationsBlock();
    expect(block).toContain('affectedKeys()');
    expect(block).toContain(
      "hasOnly(['paymentRef', 'paymentMethod', 'whatsappE164', 'paymentStatus', 'updatedAt'])",
    );
  });

  it("6. the registrant branch can never set paymentStatus to 'verified' (no self-verified payments)", () => {
    const block = registrationsBlock();
    expect(block).toContain("request.resource.data.paymentStatus in ['pending', 'unpaid']");
    // No blanket write grant on the subcollection (a blanket grant
    // would let a registrant write status/paymentStatus wholesale).
    expect(block).not.toMatch(/allow write/);
    // No unconditional grant anywhere in the subcollection block.
    expect(block).not.toMatch(/allow (get|list|create|update|delete)[^;]*if true/);
    // No delete grant: cancellation is a status update, not a delete.
    expect(block).not.toMatch(/allow delete/);
  });

  it('7. the parent event rule is unchanged by the nested block', () => {
    const block = eventsBlock();
    expect(block).toContain('allow read, list: if true;');
    expect(block).toContain(
      "allow write: if isSuperAdmin() || hasPermission('canManageEvents');",
    );
  });
});

describe('writer / reader / issuer path contract (source)', () => {
  it('8. the free route writes events/{id}/registrations/{uid}', () => {
    const route = readSrc('src/app/registerForEvent/route.ts');
    expect(route).toContain("eventRef.collection('registrations').doc(uid)");
  });

  it('9. the paid route writes the same path and doc id', () => {
    const route = readSrc('src/app/api/event-registrations/route.ts');
    expect(route).toContain(".collection('registrations').doc(uid)");
  });

  it('10. the attendees panel queries that subcollection, ordered by createdAt', () => {
    const panel = readSrc('src/components/admin/events/event-attendees-panel.tsx');
    expect(panel).toContain("collection(firestore, 'events', eventId, 'registrations')");
    expect(panel).toContain("orderBy('createdAt', 'desc')");
  });

  it('11. the ticket-issue route reads the registration from the same subcollection', () => {
    const route = readSrc('src/app/api/v1/tickets/issue/route.ts');
    expect(route).toContain(".collection('registrations').doc(registrationDocId)");
  });
});
