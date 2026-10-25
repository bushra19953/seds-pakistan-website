/**
 * admin-parity-fixtures.ts — shared in-memory fixtures for the ADMIN
 * AGGREGATES + SETTINGS + AUDIT cluster parity harness (admin-6).
 *
 * NOTE (admin-6): the sibling test-author branch feat/supa-admin-5 had NOT
 * landed when this file was written (no feat/supa-admin-1..5 refs exist in
 * the repo), so this is admin-6's own equivalent dataset at the shared path
 * named in the brief. Whichever lands first should win on merge; the datasets
 * are intentionally deterministic so a rebase is mechanical.
 *
 * Identical fixtures feed BOTH sides of the harness:
 *  - the Firestore-oracle side, where timestamps are FakeTimestamp objects
 *    (toDate()/toMillis()/seconds, like firebase-admin Timestamps), and
 *  - the Supa side, where every doc first passes through `toJsonb()` — the
 *    exact transform the migration dump applies (migrate_db.js rowFor() +
 *    JSON.stringify: a Firestore Timestamp serializes via toJSON() to an
 *    ISO string, so jsonb rows carry ISO-string timestamps).
 *
 * Zero live reads: everything here is in-memory.
 */

export const NOW_MS = Date.parse('2026-10-25T12:00:00.000Z');
export const DAY_MS = 86_400_000;

/** Minimal Firestore-Timestamp stand-in (admin SDK shape). */
export class FakeTimestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(readonly ms: number) {
    this.seconds = Math.floor(ms / 1000);
    this.nanoseconds = (ms % 1000) * 1_000_000;
  }
  toDate(): Date {
    return new Date(this.ms);
  }
  toMillis(): number {
    return this.ms;
  }
  toJSON(): string {
    return new Date(this.ms).toISOString();
  }
}

export const ts = (ms: number) => new FakeTimestamp(ms);
/** A {seconds, nanoseconds} plain-object timestamp (no toDate/toMillis). */
export const tsSecondsForm = (ms: number) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds: (ms % 1000) * 1_000_000,
});

export interface FDoc {
  id: string;
  data: Record<string, any>;
}
export const doc = (id: string, data: Record<string, any>): FDoc => ({ id, data });

/**
 * The jsonb transform: what actually lands in fs_* tables.
 * FakeTimestamp -> ISO string (via toJSON during JSON.stringify).
 */
export function toJsonb(d: FDoc): FDoc {
  return { id: d.id, data: JSON.parse(JSON.stringify(d.data)) };
}
export const toJsonbAll = (docs: FDoc[]): FDoc[] => docs.map(toJsonb);

/* ------------------------------------------------------------------ */
/* Dashboard cluster dataset (route: /api/admin/dashboard/init)        */
/* ------------------------------------------------------------------ */

export const DASH_USERS: FDoc[] = [
  doc('u1', { chapterId: 'ch-a' }),
  doc('u2', { chapterId: 'ch-a', memberStatus: 'active' }),
  doc('u3', { chapterId: 'ch-a' }),
  doc('u4', { chapterId: 'ch-b' }),
  doc('u5', { chapterId: 'ch-b', memberStatus: 'departed', departedAt: ts(NOW_MS - 3 * DAY_MS) }),
  doc('u6', {}), // no chapterId: excluded by any chapter filter, counted globally
];

export const DASH_PROJECTS: FDoc[] = [
  doc('p1', { chapterId: 'ch-a' }),
  doc('p2', { chapterId: 'ch-a' }),
  doc('p3', { chapterId: 'ch-b' }),
];

export const DASH_BLOGS: FDoc[] = [doc('b1', { chapterId: 'ch-a' }), doc('b2', {})];

export const DASH_EVENTS: FDoc[] = [
  doc('e1', { chapterId: 'ch-a' }),
  doc('e2', { chapterId: 'ch-b' }),
  doc('e3', { chapterId: 'ch-b' }),
];

export const DASH_ANNOUNCEMENTS: FDoc[] = [
  doc('a1', { chapterId: 'ch-a' }),
  doc('a2', { chapterId: 'ch-a' }),
];

export const DASH_APPLICATIONS: FDoc[] = [
  // pending pool (global): ages 10d, 40d, 30d, none, 1d
  doc('ap1', { status: 'pending', chapterId: 'ch-a', created_at: ts(NOW_MS - 10 * DAY_MS) }),
  doc('ap2', { status: 'pending', chapterId: 'ch-a', createdAt: new Date(NOW_MS - 40 * DAY_MS).toISOString() }),
  doc('ap3', { status: 'pending', chapterId: 'ch-b', created_at: tsSecondsForm(NOW_MS - 30 * DAY_MS) }),
  doc('ap4', { status: 'pending', chapterId: 'ch-a' }), // no timestamp: counts, not in median
  doc('ap5', { status: 'pending', chapterId: 'ch-b', created_at: ts(NOW_MS - 1 * DAY_MS) }),
  doc('ap6', { status: 'shortlisted', chapterId: 'ch-a' }),
  doc('ap7', { status: 'shortlisted', chapterId: 'ch-b' }),
  doc('ap8', { status: 'rejected', chapterId: 'ch-a' }),
  doc('ap9', { status: 'approved', chapterId: 'ch-a' }), // excluded from all three app counts
];

export const DASH_TASKS: FDoc[] = [
  doc('t01', { status: 'completed', chapterId: 'ch-a' }),
  doc('t02', { status: 'completed', chapterId: 'ch-a' }),
  doc('t03', { status: 'completed', chapterId: 'ch-b' }),
  doc('t04', { status: 'pending', chapterId: 'ch-a' }),
  doc('t05', { status: 'pending', chapterId: 'ch-b' }),
  doc('t06', { status: 'in-progress', chapterId: 'ch-a' }),
  doc('t07', { status: 'submitted-for-review', chapterId: 'ch-b' }),
  doc('t08', { status: 'overdue', chapterId: 'ch-a' }),
  doc('t09', { status: 'overdue', chapterId: 'ch-b' }),
  // legacy statuses: excluded from numerator AND denominator on both sides
  doc('t10', { status: 'approved', chapterId: 'ch-a' }),
  doc('t11', { status: 'approved', chapterId: 'ch-a' }),
  doc('t12', { status: 'approved', chapterId: 'ch-b' }),
  doc('t13', { status: 'approved', chapterId: 'ch-b' }),
  doc('t14', { status: 'changes-requested', chapterId: 'ch-a' }),
  doc('t15', { status: 'changes-requested', chapterId: 'ch-b' }),
  doc('t16', { status: 'cancelled', chapterId: 'ch-a' }),
];

/** 25 audit docs, timestamps 1..25 hours before NOW (ad01 newest). */
export const DASH_AUDIT: FDoc[] = Array.from({ length: 25 }, (_, i) =>
  doc(`ad${String(i + 1).padStart(2, '0')}`, {
    action: 'role_assigned',
    targetUidOrResource: 'u1',
    chapterId: 'ch-a',
    timestamp: ts(NOW_MS - (i + 1) * 3_600_000),
  }),
);
// One legacy-shaped doc whose timestamp is already an ISO string in
// Firestore: the dashboard route maps it to new Date().toISOString()
// (it does NOT pass the stored string through) — documented quirk.
export const DASH_AUDIT_STRING_TS: FDoc = doc('ad-string', {
  action: 'role_assigned',
  targetUidOrResource: 'u2',
  timestamp: new Date(NOW_MS - 30 * 3_600_000).toISOString(),
});

/* Median edge fixtures (pending applications only) */
export const pendingApps = (agesDays: (number | null)[]): FDoc[] =>
  agesDays.map((age, i) =>
    age === null
      ? doc(`mp${String(i).padStart(3, '0')}`, { status: 'pending' })
      : doc(`mp${String(i).padStart(3, '0')}`, {
          status: 'pending',
          created_at: ts(NOW_MS - age * DAY_MS),
        }),
  );

/** 105 pending docs; id-order sample (first 100) has ages 0..99 days,
 *  the 5 beyond the cap have age 10000d and must not move the median. */
export const PENDING_CAP_105: FDoc[] = Array.from({ length: 105 }, (_, i) =>
  doc(`cap${String(i).padStart(3, '0')}`, {
    status: 'pending',
    created_at: ts(NOW_MS - (i < 100 ? i : 10_000) * DAY_MS),
  }),
);

/* ------------------------------------------------------------------ */
/* Audit cluster dataset (superadmin totals + dedicated audit page)    */
/* ------------------------------------------------------------------ */

/** Unified audit_logs: 30 docs, au01 newest (1h steps). */
export const AUDIT_UNIFIED: FDoc[] = Array.from({ length: 30 }, (_, i) =>
  doc(`au${String(i + 1).padStart(2, '0')}`, {
    actorUid: i % 2 === 0 ? 'actor-1' : 'actor-2',
    action: i % 3 === 0 ? 'role_assigned' : 'login',
    targetUidOrResource: `u${(i % 5) + 1}`,
    timestamp: ts(NOW_MS - (i + 1) * 3_600_000),
  }),
);

/** Legacy auditLogs: 5 docs all OLDER than au20 (the unified page-1 cursor
 *  doc in the Firestore page) — the setup that makes the Firestore page's
 *  shared-cursor pagination re-emit them on page 2. */
export const AUDIT_LEGACY: FDoc[] = Array.from({ length: 5 }, (_, i) =>
  doc(`lg${i + 1}`, {
    changedBy: 'actor-1',
    userId: `u${i + 1}`,
    action: 'role_changed',
    oldRole: 'member',
    newRole: 'admin',
    timestamp: ts(NOW_MS - (40 + i) * 3_600_000),
  }),
);

/** Tie cluster: 5 unified + 3 legacy docs at the IDENTICAL timestamp,
 *  straddling the 20-row page boundary of the merged contract order. */
export const TIE_MS = NOW_MS - 18 * 3_600_000;
export const AUDIT_TIE_UNIFIED: FDoc[] = [
  ...Array.from({ length: 17 }, (_, i) =>
    doc(`tu${String(i + 1).padStart(2, '0')}`, {
      actorUid: 'actor-1',
      action: 'login',
      timestamp: ts(NOW_MS - (i + 1) * 3_600_000), // 1h..17h ago (newer than tie)
    }),
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    doc(`tie-u${i + 1}`, { actorUid: 'actor-1', action: 'tie_action', timestamp: ts(TIE_MS) }),
  ),
  doc('tu-old', { actorUid: 'actor-1', action: 'login', timestamp: ts(NOW_MS - 30 * 3_600_000) }),
];
export const AUDIT_TIE_LEGACY: FDoc[] = Array.from({ length: 3 }, (_, i) =>
  doc(`tie-l${i + 1}`, {
    changedBy: 'actor-2',
    userId: 'u9',
    action: 'tie_action',
    oldRole: 'member',
    newRole: 'admin',
    timestamp: ts(TIE_MS),
  }),
);

/* ------------------------------------------------------------------ */
/* Analytics dataset (/api/admin/analytics seam; page: admin/analytics)*/
/* ------------------------------------------------------------------ */

export const ANALYTICS_PAGE_VISITS: FDoc[] = [
  doc('_about', { visits: 9 }),
  doc('_events', { visits: 100 }),
  doc('_blog', { visits: 85 }),
  doc('site_total_visits', { visits: 9999 }),
  doc('home', { visits: 50 }),
];

/** 210 events; the newest 200 are the working set (cap). Event i is i
 *  minutes old. Composition of the newest 200 is fixed by index ranges
 *  in the harness comments. */
export function analyticsEvents(form: 'timestamp' | 'iso'): FDoc[] {
  const mk = (i: number, data: Record<string, any>): FDoc => {
    const ms = NOW_MS - i * 60_000;
    return doc(`ev${String(i).padStart(3, '0')}`, {
      ...data,
      timestamp: form === 'timestamp' ? ts(ms) : new Date(ms).toISOString(),
    });
  };
  const out: FDoc[] = [];
  // i=0..29 clicks 'Join' (30), i=30..59 clicks 'Donate' (30) — tie at 30.
  for (let i = 0; i < 30; i++) out.push(mk(i, { type: 'click', label: 'Join', path: '/join' }));
  for (let i = 30; i < 60; i++) out.push(mk(i, { type: 'click', label: 'Donate', path: '/donate' }));
  // i=60..69 clicks with targetId only (10) -> key = targetId
  for (let i = 60; i < 70; i++) out.push(mk(i, { type: 'click', targetId: 'cta-1', path: '/x' }));
  // i=70..74 clicks with neither label nor targetId (5) -> 'unknown'
  for (let i = 70; i < 75; i++) out.push(mk(i, { type: 'click', path: '/y' }));
  // i=75..78 time_on_page: 1000, 2000, 3000, and durationMs-only 4000
  out.push(mk(75, { type: 'time_on_page', timeOnPageMs: 1000 }));
  out.push(mk(76, { type: 'time_on_page', timeOnPageMs: 2000 }));
  out.push(mk(77, { type: 'time_on_page', timeOnPageMs: 3000 }));
  out.push(mk(78, { type: 'time_on_page', durationMs: 4000 }));
  // i=79..80 scroll_depth 40, 60
  out.push(mk(79, { type: 'scroll_depth', scrollDepth: 40 }));
  out.push(mk(80, { type: 'scroll_depth', scrollDepth: 60 }));
  // i=81..199 pageviews (fill; no derivation effect) — all "today" in UTC
  for (let i = 81; i < 200; i++) out.push(mk(i, { type: 'pageview', path: '/p' }));
  // i=200..209 beyond the 200 cap: 'Join' clicks that must NOT be counted
  for (let i = 200; i < 210; i++) out.push(mk(i, { type: 'click', label: 'Join', path: '/join' }));
  return out;
}

/* ------------------------------------------------------------------ */
/* Settings fixtures                                                   */
/* ------------------------------------------------------------------ */

export const DISCIPLINE_PARTIAL: Record<string, any> = { referralWindowDays: 7 };
export const DISCIPLINE_MALFORMED: Record<string, any> = {
  shadowMode: 'yes', // !== false -> true
  cronReferralLive: 1, // !== true -> false
  referralWindowDays: -5, // not > 0 -> default 28
  referralMissThreshold: '3', // not a number -> default 3
  warningRegistryVariant: 'bogus', // -> 'retired'
  unrelatedField: 'dropped',
};
export const DISCIPLINE_FRACTIONAL: Record<string, any> = {
  referralWindowDays: 3.5, // read path accepts any positive number
  referralMissThreshold: 0, // not > 0 -> default 3
};

export const GOVERNANCE_PARTIAL: Record<string, any> = {
  consentGateMode: { sponsor_partner: 'hard', chapter_lifecycle: 'bogus', custom_matter: 'record' },
  probationRestoreMode: 'bogus',
  warningRegistryVariant: 'retired',
  flags: { consentLive: true, boardLive: 'yes', unknownFlag: true },
  updatedBy: 123,
  changeReason: 'founder request 2026-10-25',
};
export const GOVERNANCE_MALFORMED: Record<string, any> = {
  consentGateMode: 'hard',
  flags: [true, false],
  probationRestoreMode: 42,
};

/** siteWide save: component state + the dynamic students count. */
export const SITEWIDE_STATE: Record<string, any> = {
  studentsEngaged: 9999, // ignored on save: dynamic users count wins
  activeProjects: 12,
  partners: 4,
  globalChapters: 0, // falsy -> saved as 25
  contactFormDestinationEmail: 'hello@example.com',
  bugReportEmail: 'bugs@example.com',
  enableDonations: true,
  enableChapterRegistration: undefined,
  registrationStatus: 'registered',
  registrationNumber: 'ICT-123',
  registrationDate: '2026-01-15',
  registrarJurisdiction: 'Islamabad',
  siteEnabled: undefined, // !== false -> true
  maintenanceMode: undefined, // === true -> false
  evilExtraField: 'must not persist',
};
export const SITEWIDE_STUDENTS_COUNT = 42;
