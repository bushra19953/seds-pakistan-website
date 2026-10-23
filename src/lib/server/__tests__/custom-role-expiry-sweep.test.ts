/**
 * EXPIRY-CORE (plan section 8B): runCustomRoleExpirySweep.
 *
 * FakeFirestore harness (same as src/lib/__tests__/role-writes.test.ts).
 * notificationService is mocked with a recorder (the real service
 * resolves its own db and would be invisible here). The governance
 * audit writer is mocked with a faithful stand-in that stores the
 * contracts 5.4 shape into the fake's audit_logs and can be forced to
 * throw per target uid (test 13); the real writer's own behaviour is
 * covered by governance-audit's suite.
 *
 * Parent ruling X11 pins the chain rule exercised by tests 6 and 6b:
 * an expiring grant chain restores the state before the chain's FIRST
 * expiring grant; a slug that was already held non-expiring before the
 * chain stays held (non-expiring) after it.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';

const mockNotifications: Array<{ userId: string; payload: any; priority: string }> = [];
const mockAuditEntries: Array<Record<string, unknown>> = [];
const mockAuditBlocklist = new Set<string>();

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (userId: string, payload: any, priority: string) => {
      mockNotifications.push({ userId, payload, priority });
    }),
  },
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(
    async (db: any, entry: Record<string, unknown>) => {
      if (entry && mockAuditBlocklist.has(entry.targetId as string)) {
        throw new Error('forced governance audit failure');
      }
      mockAuditEntries.push(entry);
      const ref = db.collection('audit_logs').doc();
      await ref.set({
        action: entry.action,
        actorUid: entry.actorUid,
        actorRole: entry.actorRole,
        targetType: entry.targetType,
        targetId: entry.targetId,
        details: entry.details ?? null,
        governance: true,
        createdAt: 'test-timestamp',
      });
      return ref.id;
    },
  ),
}));

import { runCustomRoleExpirySweep } from '../custom-role-expiry-sweep';
import { assignRole } from '../role-writes';
import { FOUNDER_UID } from '@/config/founder';

const CHAPTER = 'seds-ist-chapter';
const CUSTOM = 'custom_poster_team_lead';
const CUSTOM_OLD = 'custom_old_team';
const ADMIN = 'admin-actor-uid';
const REASON = 'Appointed by the National President, October 2026 intake';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const EXPIRED_AT = new Date('2026-10-20T00:00:00.000Z');
const EXPIRED_ISO = '2026-10-20T00:00:00.000Z';
const EXPIRY_FIELDS = [
  'expiresAt',
  'expiresRoleKey',
  'priorRole',
  'priorAdditionalRoles',
  'expiryAlertStage',
] as const;

type AssignInputShape = Parameters<typeof assignRole>[1];
function assignLoose(db: FakeFirestore, input: Record<string, unknown>) {
  return assignRole(db.asDb(), input as unknown as AssignInputShape);
}

function seedCustomDefinition(
  db: FakeFirestore,
  slug: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  db.seed('roleDefinitions', slug, {
    role: slug,
    slug,
    name,
    label: name,
    isCustom: true,
    parentRoleKey: 'chapter_design_chair',
    chapterId: CHAPTER,
    description: `Temporary ${name} (expiry sweep tests)`,
    permissions: ['canManageTasks'],
    scope: 'chapter',
    category: 'Custom',
    allowedChapters: [CHAPTER],
    isActive: true,
    ...overrides,
  });
}

interface GrantSeed {
  role?: string;
  additionalRoles?: string[];
  priorRole?: string | null;
  priorAdditionalRoles?: string[];
  expiresAt?: unknown;
  expiresRoleKey?: string | null;
  expiryAlertStage?: string;
  includeExpiresRoleKey?: boolean;
}

/**
 * Seeds a roles doc carrying a pending expiry (default: expired at
 * EXPIRED_AT, composition untouched since the grant) plus its users
 * mirror.
 */
function seedGrant(db: FakeFirestore, uid: string, seed: GrantSeed = {}) {
  const role = seed.role ?? 'chapter_secretary';
  const additionalRoles = seed.additionalRoles ?? ['chapter_events_chair', CUSTOM];
  const doc: Record<string, unknown> = {
    role,
    additionalRoles,
    chapterId: CHAPTER,
    grantedBy: ADMIN,
    lastChangedBy: ADMIN,
    source: 'admin_ui',
    schemaVersion: 2,
    expiresAt: seed.expiresAt ?? Timestamp.fromDate(EXPIRED_AT),
    priorRole: seed.priorRole === undefined ? 'chapter_secretary' : seed.priorRole,
    priorAdditionalRoles: seed.priorAdditionalRoles ?? ['chapter_events_chair'],
    expiryAlertStage: seed.expiryAlertStage ?? 'none',
  };
  if (seed.includeExpiresRoleKey !== false) {
    doc.expiresRoleKey = seed.expiresRoleKey === undefined ? CUSTOM : seed.expiresRoleKey;
  }
  db.seed('roles', uid, doc);
  db.seed('users', uid, {
    displayName: uid,
    chapterId: CHAPTER,
    role,
    displayRole: role,
    additionalRoles,
    roleSource: 'roles',
  });
  return doc;
}

function governanceAudits(db: FakeFirestore) {
  return db
    .all('audit_logs')
    .map((a) => a.data)
    .filter((a) => a.governance === true);
}

function alertsTo(uid: string) {
  return mockNotifications.filter((n) => n.userId === uid);
}

beforeEach(() => {
  mockNotifications.length = 0;
  mockAuditEntries.length = 0;
  mockAuditBlocklist.clear();
});

describe('custom role expiry sweep - materialisation (plan 8B)', () => {
  it('8B.1 restored_prior: an untouched expired grant restores the snapshot exactly, with the contracts 5.4 audit', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-1';
    seedGrant(db, uid);

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.failures).toEqual([]);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'restored_prior' },
    ]);
    expect(summary.reminded).toEqual([]);

    const doc = db.read('roles', uid);
    expect(doc?.role).toBe('chapter_secretary');
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair']);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
    const mirror = db.read('users', uid);
    expect(mirror?.additionalRoles).toEqual(['chapter_events_chair']);
    expect(mirror?.role).not.toBe(CUSTOM);

    // role-writes' own history: one entry, sweep source, deterministic key.
    const history = db.all('roleHistory').map((h) => h.data);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      uid,
      action: 'change',
      source: 'expiry_sweep',
      actorUid: 'system',
      idempotencyKey: `expiry:${uid}:${CUSTOM}:${EXPIRED_ISO}`,
    });

    // The governance audit entry matches contracts 5.4 exactly.
    const audits = governanceAudits(db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'custom_role_grant_expired',
      actorUid: 'system',
      actorRole: 'expiry_sweep',
      targetType: 'user_role',
      targetId: uid,
      details: {
        roleKey: CUSTOM,
        expiresAt: EXPIRED_ISO,
        branch: 'restored_prior',
        restoredRole: 'chapter_secretary',
        restoredAdditionalRoles: ['chapter_events_chair'],
        droppedPriorAdditionals: [],
      },
    });

    // Expiry alert went to the Founder AND the holder.
    const founderAlerts = alertsTo(FOUNDER_UID).filter(
      (n) => n.payload.type === 'custom_role_expiry_alert',
    );
    const holderAlerts = alertsTo(uid).filter(
      (n) => n.payload.type === 'custom_role_expiry_alert',
    );
    expect(founderAlerts).toHaveLength(1);
    expect(holderAlerts).toHaveLength(1);
    expect(founderAlerts[0].payload.title).toBe('Custom role expiry alert (expired)');
    expect(founderAlerts[0].payload.metadata).toMatchObject({
      uid,
      roleKey: CUSTOM,
      expiresAt: EXPIRED_ISO,
    });
    expect(founderAlerts[0].priority).toBe('P1');
  });

  it('8B.2 removed_only: a later primary promotion is kept, the slug is removed, the stale prior is never restored', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-2';
    seedGrant(db, uid, {
      role: 'chapter_president', // promoted after the grant
      additionalRoles: ['chapter_design_chair', CUSTOM], // composition also moved on
      priorRole: 'chapter_secretary',
      priorAdditionalRoles: ['chapter_events_chair'],
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'removed_only' },
    ]);
    const doc = db.read('roles', uid);
    expect(doc?.role).toBe('chapter_president');
    expect(doc?.additionalRoles).toEqual(['chapter_design_chair']);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
    const audits = governanceAudits(db);
    expect(audits[0]?.details).toMatchObject({
      branch: 'removed_only',
      restoredRole: 'chapter_president',
      restoredAdditionalRoles: ['chapter_design_chair'],
    });
  });

  it('8B.3 removed_only: a later additional grant is kept when the expired slug is removed (primary intact)', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-3';
    seedGrant(db, uid, {
      additionalRoles: ['chapter_events_chair', 'chapter_recruitment_chair', CUSTOM],
      priorAdditionalRoles: ['chapter_events_chair'],
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'removed_only' },
    ]);
    const doc = db.read('roles', uid);
    expect(doc?.role).toBe('chapter_secretary'); // primary untouched
    expect([...(doc?.additionalRoles as string[])].sort()).toEqual(
      ['chapter_events_chair', 'chapter_recruitment_chair'].sort(),
    );
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
  });

  it('8B.4 banned holder: escalated_banned_no_restore removes the slug, restores nothing, notifies the Founder', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-4';
    seedGrant(db, uid, {
      role: 'chapter_treasurer', // current primary differs from the snapshot
      priorRole: 'chapter_secretary',
    });
    const user = db.read('users', uid)!;
    db.seed('users', uid, { ...user, isBanned: true });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'escalated_banned_no_restore' },
    ]);
    const doc = db.read('roles', uid);
    expect(doc?.role).toBe('chapter_treasurer'); // NOT restored to chapter_secretary
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair']);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
    const audits = governanceAudits(db);
    expect(audits[0]?.details).toMatchObject({ branch: 'escalated_banned_no_restore' });
    expect(
      alertsTo(FOUNDER_UID).filter(
        (n) => n.payload.type === 'custom_role_expiry_alert',
      ),
    ).toHaveLength(1);
  });

  it('8B.5 a prior additional whose definition was deleted is dropped and named, and the restore still succeeds', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-5';
    seedCustomDefinition(db, CUSTOM, 'Poster Team Lead');
    // NO roleDefinitions doc for CUSTOM_OLD: it was deleted after the grant.
    seedGrant(db, uid, {
      additionalRoles: ['chapter_events_chair', CUSTOM_OLD, CUSTOM],
      priorAdditionalRoles: ['chapter_events_chair', CUSTOM_OLD],
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.failures).toEqual([]);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'restored_prior' },
    ]);
    const doc = db.read('roles', uid);
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair']);
    const audits = governanceAudits(db);
    expect(audits[0]?.details).toMatchObject({
      branch: 'restored_prior',
      restoredAdditionalRoles: ['chapter_events_chair'],
      droppedPriorAdditionals: [CUSTOM_OLD],
    });
  });

  it('8B.6 X11 chain: grant A then re-grant B (same slug, later date) - the sweep restores the PRE-CHAIN state and the slug is gone', async () => {
    const db = new FakeFirestore();
    const uid = 'u-chain';
    seedCustomDefinition(db, CUSTOM, 'Poster Team Lead');
    db.seed('users', uid, { displayName: uid, chapterId: CHAPTER });
    // Pre-chain state: chapter_secretary + [chapter_events_chair].
    await assignLoose(db, {
      uid,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    const expA = new Date(NOW.getTime() + 10 * DAY_MS);
    await assignLoose(db, {
      uid,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: expA,
      expiresRoleKey: CUSTOM,
    });
    const expB = new Date(NOW.getTime() + 40 * DAY_MS);
    await assignLoose(db, {
      uid,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: expB,
      expiresRoleKey: CUSTOM,
    });
    // Mid-chain sanity: B replaced the date; the snapshot is pre-chain.
    const mid = db.read('roles', uid);
    expect(mid?.expiresAt).toEqual(expB);
    expect(mid?.priorAdditionalRoles).toEqual(['chapter_events_chair']);

    const afterB = new Date(expB.getTime() + DAY_MS);
    const summary = await runCustomRoleExpirySweep(db.asDb(), afterB);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'restored_prior' },
    ]);
    const doc = db.read('roles', uid);
    expect(doc?.role).toBe('chapter_secretary');
    // The slug is NOT held afterwards (X11 overrides plan section 4.5).
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair']);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
    // A second sweep run selects nothing.
    const second = await runCustomRoleExpirySweep(db.asDb(), afterB);
    expect(second).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
  });

  it('8B.6b X11 chain: a slug held NON-expiring before the expiring grant is still held, non-expiring, after materialisation', async () => {
    const db = new FakeFirestore();
    const uid = 'u-preheld';
    seedCustomDefinition(db, CUSTOM, 'Poster Team Lead');
    db.seed('users', uid, { displayName: uid, chapterId: CHAPTER });
    await assignLoose(db, {
      uid,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair'],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    // The slug is granted WITHOUT expiry first.
    await assignLoose(db, {
      uid,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
    });
    expect(db.read('roles', uid)).not.toHaveProperty('expiresAt');
    // Then the same slug is re-granted WITH an expiry.
    const exp = new Date(NOW.getTime() + 10 * DAY_MS);
    await assignLoose(db, {
      uid,
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      actorUid: ADMIN,
      reason: REASON,
      source: 'admin_ui',
      expiresAt: exp,
      expiresRoleKey: CUSTOM,
    });
    const after = new Date(exp.getTime() + DAY_MS);
    const summary = await runCustomRoleExpirySweep(db.asDb(), after);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'restored_prior' },
    ]);
    const doc = db.read('roles', uid);
    // The pre-chain state INCLUDED the slug: it survives, non-expiring.
    expect(doc?.additionalRoles).toEqual(['chapter_events_chair', CUSTOM]);
    for (const field of EXPIRY_FIELDS) {
      expect(doc).not.toHaveProperty(field);
    }
    const second = await runCustomRoleExpirySweep(db.asDb(), after);
    expect(second).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
  });

  it('8B.7 priorRole null at grant (the grant created the roles doc): the primary is restored as member_basic', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-7';
    seedGrant(db, uid, {
      role: 'member_basic',
      additionalRoles: [CUSTOM],
      priorRole: null,
      priorAdditionalRoles: [],
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.expiredMaterialised).toEqual([
      { uid, roleKey: CUSTOM, branch: 'restored_prior' },
    ]);
    const doc = db.read('roles', uid);
    expect(doc?.role).toBe('member_basic');
    expect(doc?.additionalRoles).toEqual([]);
    const audits = governanceAudits(db);
    expect(audits[0]?.details).toMatchObject({ restoredRole: 'member_basic' });
  });

  it('8B.12 a double sweep back-to-back: the second summary is empty and nothing is duplicated', async () => {
    const db = new FakeFirestore();
    const uid = 'u-exp-12';
    seedGrant(db, uid);

    const first = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(first.expiredMaterialised).toHaveLength(1);
    const historyCount = db.all('roleHistory').length;
    const auditCount = db.all('audit_logs').length;
    const notifCount = mockNotifications.length;
    expect(notifCount).toBeGreaterThan(0);

    const second = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(second).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
    expect(db.all('roleHistory')).toHaveLength(historyCount);
    expect(db.all('audit_logs')).toHaveLength(auditCount);
    expect(mockNotifications).toHaveLength(notifCount);
  });

  it('8B.13 failure isolation: a grant whose governance audit throws is left byte-identical, the other grant still materialises', async () => {
    const db = new FakeFirestore();
    const badUid = 'u-bad';
    const goodUid = 'u-good';
    const badSeed = seedGrant(db, badUid);
    seedGrant(db, goodUid);
    mockAuditBlocklist.add(badUid);

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].uid).toBe(badUid);
    expect(summary.failures[0].roleKey).toBe(CUSTOM);
    expect(summary.failures[0].error).toContain('forced governance audit failure');
    // Audit-or-fail: NO state change for the bad grant.
    expect(db.read('roles', badUid)).toEqual(badSeed);
    // The other grant in the same run still materialised.
    expect(summary.expiredMaterialised).toEqual([
      { uid: goodUid, roleKey: CUSTOM, branch: 'restored_prior' },
    ]);
    // The failure surfaced as a Founder alert, not a silent drop (SEC-08).
    const failureAlerts = alertsTo(FOUNDER_UID).filter(
      (n) => n.payload.title === 'Custom role expiry alert (failed)',
    );
    expect(failureAlerts).toHaveLength(1);
    expect(failureAlerts[0].payload.type).toBe('custom_role_expiry_alert');
  });

  it('8B.14 a roles collection read that throws returns the empty summary and never throws to the host', async () => {
    const brokenDb = {
      collection: () => ({
        get: async () => {
          throw new Error('read failed');
        },
      }),
    };
    await expect(
      runCustomRoleExpirySweep(brokenDb as never, NOW),
    ).resolves.toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
  });
});

describe('custom role expiry sweep - warnings and selection (plan 8B)', () => {
  it('8B.8a T-20 with stage none: T-30 alert to Founder AND holder, stage stamped, composition byte-identical, re-run silent', async () => {
    const db = new FakeFirestore();
    const uid = 'u-warn-30';
    const expiresAt = new Date(NOW.getTime() + 20 * DAY_MS);
    const seed = seedGrant(db, uid, {
      expiresAt: Timestamp.fromDate(expiresAt),
      expiryAlertStage: 'none',
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.reminded).toEqual([{ uid, roleKey: CUSTOM, stage: 't30_sent' }]);
    expect(summary.expiredMaterialised).toEqual([]);

    for (const recipient of [FOUNDER_UID, uid]) {
      const alerts = alertsTo(recipient).filter(
        (n) => n.payload.type === 'custom_role_expiry_alert',
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].payload.title).toBe('Custom role expiry alert (t30_sent)');
      expect(alerts[0].payload.metadata).toMatchObject({
        uid,
        roleKey: CUSTOM,
        expiresAt: expiresAt.toISOString(),
      });
      expect(alerts[0].priority).toBe('P1');
    }

    // Only the bookkeeping stamp moved; the grant itself is untouched.
    const doc = db.read('roles', uid);
    expect(doc?.expiryAlertStage).toBe('t30_sent');
    expect(doc?.role).toBe(seed.role);
    expect(doc?.additionalRoles).toEqual(seed.additionalRoles);
    expect(doc?.expiresAt).toEqual(seed.expiresAt);
    expect(doc?.expiresRoleKey).toBe(seed.expiresRoleKey);
    expect(doc?.priorRole).toBe(seed.priorRole);
    expect(doc?.priorAdditionalRoles).toEqual(seed.priorAdditionalRoles);
    // Reminders write no governance audit and no role history.
    expect(governanceAudits(db)).toHaveLength(0);
    expect(db.all('roleHistory')).toHaveLength(0);

    // Immediate re-run: no duplicate alert, no re-stamp.
    const notifCount = mockNotifications.length;
    const second = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(second.reminded).toEqual([]);
    expect(mockNotifications).toHaveLength(notifCount);
    expect(db.read('roles', uid)?.expiryAlertStage).toBe('t30_sent');
  });

  it('8B.8b T-5 with stage t30_sent: T-7 alert fires and the stage advances', async () => {
    const db = new FakeFirestore();
    const uid = 'u-warn-7';
    seedGrant(db, uid, {
      expiresAt: Timestamp.fromDate(new Date(NOW.getTime() + 5 * DAY_MS)),
      expiryAlertStage: 't30_sent',
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.reminded).toEqual([{ uid, roleKey: CUSTOM, stage: 't7_sent' }]);
    expect(db.read('roles', uid)?.expiryAlertStage).toBe('t7_sent');
    const titles = mockNotifications.map((n) => n.payload.title);
    expect(titles).toContain('Custom role expiry alert (t7_sent)');
    expect(titles).not.toContain('Custom role expiry alert (t30_sent)');
  });

  it('8B.8c first seen inside 7 days (stage none): T-7 only, never a late T-30', async () => {
    const db = new FakeFirestore();
    const uid = 'u-warn-first7';
    seedGrant(db, uid, {
      expiresAt: Timestamp.fromDate(new Date(NOW.getTime() + 5 * DAY_MS)),
      expiryAlertStage: 'none',
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary.reminded).toEqual([{ uid, roleKey: CUSTOM, stage: 't7_sent' }]);
    expect(db.read('roles', uid)?.expiryAlertStage).toBe('t7_sent');
    const titles = mockNotifications.map((n) => n.payload.title);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t === 'Custom role expiry alert (t7_sent)')).toBe(true);
  });

  it('8B.9 beyond T-30 and unexpired: no alerts, no writes', async () => {
    const db = new FakeFirestore();
    const uid = 'u-far';
    const seed = seedGrant(db, uid, {
      expiresAt: Timestamp.fromDate(new Date(NOW.getTime() + 45 * DAY_MS)),
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
    expect(mockNotifications).toHaveLength(0);
    expect(db.read('roles', uid)).toEqual(seed);
    expect(db.all('roleHistory')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
  });

  it('8B.10 an expired CATALOG fixture (hand-written, expiresRoleKey is a catalog key) is left byte-identical (SEC-08)', async () => {
    const db = new FakeFirestore();
    const uid = 'u-catalog';
    const seed = seedGrant(db, uid, {
      expiresRoleKey: 'chapter_secretary', // not a custom_ slug: never selected
    });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
    expect(db.read('roles', uid)).toEqual(seed);
    expect(mockNotifications).toHaveLength(0);
    expect(db.all('roleHistory')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
  });

  it('8B.11 a malformed pending expiry (expiresAt set, expiresRoleKey missing) is ignored: no failure entry, no writes', async () => {
    const db = new FakeFirestore();
    const uid = 'u-malformed';
    const seed = seedGrant(db, uid, { includeExpiresRoleKey: false });

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
    expect(db.read('roles', uid)).toEqual(seed);
    expect(mockNotifications).toHaveLength(0);
    expect(db.all('roleHistory')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
  });

  it('the sweep never touches a grant without expiry (no expiresAt at all)', async () => {
    const db = new FakeFirestore();
    const uid = 'u-plain';
    db.seed('roles', uid, {
      role: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      chapterId: CHAPTER,
      lastChangedBy: ADMIN,
      source: 'admin_ui',
      schemaVersion: 2,
    });
    db.seed('users', uid, {
      displayName: uid,
      chapterId: CHAPTER,
      role: 'chapter_secretary',
      displayRole: 'chapter_secretary',
      additionalRoles: ['chapter_events_chair', CUSTOM],
      roleSource: 'roles',
    });
    const before = db.read('roles', uid);

    const summary = await runCustomRoleExpirySweep(db.asDb(), NOW);
    expect(summary).toEqual({ reminded: [], expiredMaterialised: [], failures: [] });
    expect(db.read('roles', uid)).toEqual(before);
    expect(mockNotifications).toHaveLength(0);
    expect(db.all('roleHistory')).toHaveLength(0);
    expect(db.all('audit_logs')).toHaveLength(0);
  });
});
