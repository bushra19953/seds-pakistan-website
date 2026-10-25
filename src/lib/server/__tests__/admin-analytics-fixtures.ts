/**
 * admin-analytics-fixtures.ts — in-memory fixtures for the admin
 * analytics Supa seam tests.
 *
 * Copied from the admin-6 parity harness fixtures
 * (~/workspace/fix-ab/wt-supa-admin-6/src/lib/supa/__tests__/
 * admin-parity-fixtures.ts): the ANALYTICS dataset (ANALYTICS_PAGE_VISITS,
 * analyticsEvents) and the DASH users/projects counts, verbatim in shape
 * and values, so these tests assert against the same dataset the parity
 * table was machine-verified with. Zero live reads.
 */

export const NOW_MS = Date.parse('2026-10-25T12:00:00.000Z');

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

export interface FDoc {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const doc = (id: string, data: Record<string, any>): FDoc => ({ id, data });

/**
 * The jsonb transform: what actually lands in fs_* tables.
 * FakeTimestamp -> ISO string (via toJSON during JSON.stringify).
 */
export function toJsonb(d: FDoc): FDoc {
  return { id: d.id, data: JSON.parse(JSON.stringify(d.data)) };
}
export const toJsonbAll = (docs: FDoc[]): FDoc[] => docs.map(toJsonb);

/* Counts dataset (admin-6 DASH_USERS / DASH_PROJECTS, values verbatim). */
export const ANALYTICS_USERS: FDoc[] = [
  doc('u1', { chapterId: 'ch-a' }),
  doc('u2', { chapterId: 'ch-a', memberStatus: 'active' }),
  doc('u3', { chapterId: 'ch-a' }),
  doc('u4', { chapterId: 'ch-b' }),
  doc('u5', { chapterId: 'ch-b', memberStatus: 'departed' }),
  doc('u6', {}),
];

export const ANALYTICS_PROJECTS: FDoc[] = [
  doc('p1', { chapterId: 'ch-a' }),
  doc('p2', { chapterId: 'ch-a' }),
  doc('p3', { chapterId: 'ch-b' }),
];

/* Analytics dataset (/api/admin/analytics seam; page: admin/analytics). */

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
