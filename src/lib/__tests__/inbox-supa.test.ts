/**
 * Universal Inbox Supabase seam tests (notifications cluster G3).
 *
 * These encode CURRENT Firestore behaviour as contracts, including the
 * three known defects of the Universal Inbox, which the migration must
 * reproduce exactly and never silently fix:
 *  (a) SUBMISSION tab vocabulary mismatch (lowercase writer types vs
 *      the 'SUBMISSION' tab id, page filter s.type === activeTab).
 *  (b) The submissions listener orders by `created_at`, which writers
 *      never set; Firestore orderBy excludes docs missing the field.
 *  (c) The FORM_RESPONSE tab has no data feed at all.
 *
 * No live Supabase reads: the seam selectors run over in-memory rows
 * (the mocked adapter surface), and the flag helpers run over env.
 * No em dashes are used in test names in this file.
 */

import {
  APPLICATION_INBOX_STATUSES,
  INBOX_FEEDS,
  inboxSupaClientEnabled,
  inboxSupaServerEnabled,
  matchesInboxTab,
  restoreInboxTimestamps,
  selectApplicationsFeed,
  selectInboxFeeds,
  selectLeaveFeed,
  selectSubmissionsFeed,
  selectTasksProofFeed,
  selectTasksSubmittedFeed,
  selectUniversalReviewGet,
  serializeInboxForSupa,
  supaTimestampToIso,
  supaTimestampToMillis,
  type SupaRow,
} from '../inbox-supa';

const row = (id: string, data: any): SupaRow => ({ id, data });

describe('defect (b): submissions feed orderBy created_at exclusion', () => {
  test('rows whose data lacks created_at are excluded, exactly as Firestore orderBy excludes them', () => {
    const rows = [
      row('with-date', { type: 'competition', created_at: '2026-10-20T00:00:00.000Z' }),
      row('no-date', { type: 'competition', submittedAt: '2026-10-21T00:00:00.000Z' }),
      row('also-no-date', { type: 'resource' }),
    ];
    const feed = selectSubmissionsFeed(rows);
    expect(feed.map((r) => r.id)).toEqual(['with-date']);
  });

  test('kept rows sort by created_at descending and cap at 100', () => {
    const rows = Array.from({ length: 105 }, (_, i) =>
      row(`doc-${String(i).padStart(3, '0')}`, {
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      }),
    );
    const feed = selectSubmissionsFeed(rows);
    expect(feed).toHaveLength(100);
    expect(feed[0].id).toBe('doc-104');
    expect(feed[99].id).toBe('doc-005');
  });

  test('a present but null created_at is a stored value and is kept, sorting last', () => {
    const rows = [
      row('null-date', { created_at: null }),
      row('real-date', { created_at: '2026-10-20T00:00:00.000Z' }),
    ];
    const feed = selectSubmissionsFeed(rows);
    expect(feed.map((r) => r.id)).toEqual(['real-date', 'null-date']);
  });

  test('Admin SDK dump shapes (_seconds) participate in the ordering', () => {
    const rows = [
      row('iso', { created_at: '2026-10-20T00:00:00.000Z' }),
      row('dump', { created_at: { _seconds: 1792700000, _nanoseconds: 0 } }),
    ];
    const feed = selectSubmissionsFeed(rows);
    expect(feed[0].id).toBe('dump');
  });
});

describe('defect (a): SUBMISSION tab vocabulary filter', () => {
  test('a lowercase writer type never matches the SUBMISSION tab id', () => {
    expect(matchesInboxTab('competition', 'SUBMISSION')).toBe(false);
    expect(matchesInboxTab('resource', 'SUBMISSION')).toBe(false);
    expect(matchesInboxTab('submission', 'SUBMISSION')).toBe(false);
  });

  test('only a literal SUBMISSION type matches the SUBMISSION tab', () => {
    expect(matchesInboxTab('SUBMISSION', 'SUBMISSION')).toBe(true);
  });

  test('synthesized inbox types match their own tabs exactly', () => {
    expect(matchesInboxTab('TASK_REVIEW', 'TASK_REVIEW')).toBe(true);
    expect(matchesInboxTab('LEAVE_REQUEST', 'LEAVE_REQUEST')).toBe(true);
    expect(matchesInboxTab('APPLICATION', 'APPLICATION')).toBe(true);
    expect(matchesInboxTab('APPLICATION', 'SUBMISSION')).toBe(false);
  });

  test('the combined submissions feed keeps writer types untouched for the filter to misfire on', () => {
    const feeds = selectInboxFeeds({
      submissions: [
        row('s1', { type: 'competition', created_at: '2026-10-20T00:00:00.000Z' }),
        row('s2', { type: 'SUBMISSION', created_at: '2026-10-19T00:00:00.000Z' }),
      ],
    });
    const tabRows = feeds.submissions.filter((r) => matchesInboxTab(r.data.type, 'SUBMISSION'));
    expect(tabRows.map((r) => r.id)).toEqual(['s2']);
  });
});

describe('defect (c): FORM_RESPONSE has no feed', () => {
  test('the feed inventory has exactly five feeds and none is form_responses', () => {
    expect(INBOX_FEEDS).toHaveLength(5);
    expect(INBOX_FEEDS.map((f) => f.collection)).toEqual([
      'submissions',
      'tasks',
      'tasks',
      'leave_requests',
      'applications',
    ]);
    expect(INBOX_FEEDS.some((f) => f.collection === 'form_responses')).toBe(false);
  });

  test('selectInboxFeeds never synthesizes FORM_RESPONSE rows', () => {
    const feeds = selectInboxFeeds({
      submissions: [row('s1', { type: 'FORM_RESPONSE', created_at: '2026-10-20T00:00:00.000Z' })],
      tasks: [],
      leave_requests: [],
      applications: [],
    });
    // The raw submissions row keeps its stored type; no feed relabels
    // or routes it to the FORM_RESPONSE tab.
    expect(Object.keys(feeds)).toEqual([
      'submissions',
      'tasksSubmitted',
      'tasksProof',
      'leaveRequests',
      'applications',
    ]);
  });
});

describe('feed selectors replicate the Firestore listeners', () => {
  test('tasks submitted feed filters status and caps at 100 in id order', () => {
    const rows = [
      row('t2', { status: 'submitted-for-review' }),
      row('t1', { status: 'submitted-for-review' }),
      row('t3', { status: 'pending' }),
    ];
    expect(selectTasksSubmittedFeed(rows).map((r) => r.id)).toEqual(['t1', 't2']);
  });

  test('tasks proof feed includes pending and in-progress only, before the page hasProof filter', () => {
    const rows = [
      row('t1', { status: 'pending', deliverableFiles: [] }),
      row('t2', { status: 'in-progress', deliverableFiles: ['a.pdf'] }),
      row('t3', { status: 'completed', deliverableFiles: ['a.pdf'] }),
    ];
    expect(selectTasksProofFeed(rows).map((r) => r.id)).toEqual(['t1', 't2']);
  });

  test('leave feed is pending only', () => {
    const rows = [
      row('l1', { status: 'pending' }),
      row('l2', { status: 'approved' }),
    ];
    expect(selectLeaveFeed(rows).map((r) => r.id)).toEqual(['l1']);
  });

  test('applications feed is the in-pipeline status set only', () => {
    const rows = APPLICATION_INBOX_STATUSES.map((s, i) => row(`a${i}`, { status: s }));
    rows.push(row('ax', { status: 'approved' }), row('ay', { status: 'rejected' }));
    expect(selectApplicationsFeed(rows).map((r) => r.id)).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  test('universal-review GET selector filters status, excludes missing submittedAt, sorts desc, caps 100', () => {
    const rows = [
      row('g1', { status: 'pending', submittedAt: '2026-10-20T00:00:00.000Z' }),
      row('g2', { status: 'pending' }),
      row('g3', { status: 'pending', submittedAt: '2026-10-21T00:00:00.000Z' }),
      row('g4', { status: 'approved', submittedAt: '2026-10-22T00:00:00.000Z' }),
    ];
    expect(selectUniversalReviewGet(rows, 'pending').map((r) => r.id)).toEqual(['g3', 'g1']);
    expect(selectUniversalReviewGet(rows, 'all').map((r) => r.id)).toEqual(['g4', 'g3', 'g1']);
  });
});

describe('timestamp shape identity between Firestore and jsonb rows', () => {
  const makeTimestamp = (d: Date) => ({
    toDate: () => d,
    toMillis: () => d.getTime(),
  });

  test('supaTimestampToIso normalizes ISO strings, dump shapes, and epoch numbers', () => {
    expect(supaTimestampToIso('2026-10-20T00:00:00.000Z')).toBe('2026-10-20T00:00:00.000Z');
    expect(supaTimestampToIso({ _seconds: 0, _nanoseconds: 0 })).toBe('1970-01-01T00:00:00.000Z');
    expect(supaTimestampToIso({ seconds: 0, nanoseconds: 0 })).toBe('1970-01-01T00:00:00.000Z');
    expect(supaTimestampToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(supaTimestampToIso(null)).toBeNull();
    expect(supaTimestampToIso('not a date')).toBeNull();
  });

  test('supaTimestampToMillis reads Timestamp-like values and jsonb shapes alike', () => {
    expect(supaTimestampToMillis({ toMillis: () => 42 })).toBe(42);
    expect(supaTimestampToMillis('2026-10-20T00:00:00.000Z')).toBe(Date.parse('2026-10-20T00:00:00.000Z'));
    expect(supaTimestampToMillis(undefined)).toBeNull();
  });

  test('restoreInboxTimestamps gives created_at a toDate and toMillis like a Firestore Timestamp', () => {
    const restored = restoreInboxTimestamps(
      { created_at: '2026-10-20T00:00:00.000Z', summary_text: 'x' },
      makeTimestamp,
    );
    expect(typeof restored.created_at.toDate).toBe('function');
    expect(restored.created_at.toDate().toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(restored.created_at.toMillis()).toBe(Date.parse('2026-10-20T00:00:00.000Z'));
    expect(restored.summary_text).toBe('x');
  });

  test('restoreInboxTimestamps restores the fallback chain fields the page synthesizes created_at from', () => {
    const restored = restoreInboxTimestamps(
      {
        submittedAt: { _seconds: 100, _nanoseconds: 0 },
        updatedAt: '1970-01-01T00:03:20.000Z',
        createdAt: '1970-01-01T00:01:40.000Z',
      },
      makeTimestamp,
    );
    // tasks chain: submittedAt first; applications chain: created_at,
    // then submittedAt, then createdAt. Each must be Timestamp-like.
    expect(restored.submittedAt.toMillis()).toBe(100000);
    expect(restored.updatedAt.toMillis()).toBe(200000);
    expect(restored.createdAt.toMillis()).toBe(100000);
  });

  test('restoreInboxTimestamps leaves bare date labels and non timestamp fields untouched', () => {
    const restored = restoreInboxTimestamps(
      { startDate: '2026-10-20', created_at: '2026-10-20' },
      makeTimestamp,
    );
    expect(restored.startDate).toBe('2026-10-20');
    // A bare date in a timestamp field is not an ISO datetime and is
    // left as the string the Firestore path would have passed through.
    expect(restored.created_at).toBe('2026-10-20');
  });

  test('restored rows produce the same rendered date decision as Firestore rows', () => {
    const firestoreLike = { created_at: makeTimestamp(new Date('2026-10-20T00:00:00.000Z')) };
    const supaRestored = restoreInboxTimestamps(
      { created_at: '2026-10-20T00:00:00.000Z' },
      makeTimestamp,
    );
    const render = (r: any) =>
      r.created_at?.toDate ? r.created_at.toDate().toISOString() : 'Unknown';
    expect(render(supaRestored)).toBe(render(firestoreLike));
  });
});

describe('flag behaviour: off by default, on only for the inbox surface', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  test('server flag is OFF when SUPA_SURFACES is unset or names other surfaces', () => {
    delete process.env.SUPA_SURFACES;
    expect(inboxSupaServerEnabled()).toBe(false);
    process.env.SUPA_SURFACES = 'announcements,tasks';
    expect(inboxSupaServerEnabled()).toBe(false);
  });

  test('server flag is ON for inbox or the wildcard, case-insensitively', () => {
    process.env.SUPA_SURFACES = 'announcements, Inbox ';
    expect(inboxSupaServerEnabled()).toBe(true);
    process.env.SUPA_SURFACES = '*';
    expect(inboxSupaServerEnabled()).toBe(true);
  });

  test('client flag reads only the NEXT_PUBLIC twin', () => {
    delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
    process.env.SUPA_SURFACES = 'inbox';
    expect(inboxSupaClientEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = 'inbox';
    expect(inboxSupaClientEnabled()).toBe(true);
  });
});

describe('mirror serialization', () => {
  test('serializeInboxForSupa converts Timestamp-like values to ISO and keeps primitives', () => {
    const out = serializeInboxForSupa({
      status: 'approved',
      pointsAwarded: 10,
      reviewedAt: { toDate: () => new Date('2026-10-20T00:00:00.000Z') },
      nested: { at: { _seconds: 0, _nanoseconds: 0 } },
    });
    expect(out).toEqual({
      status: 'approved',
      pointsAwarded: 10,
      reviewedAt: '2026-10-20T00:00:00.000Z',
      nested: { at: '1970-01-01T00:00:00.000Z' },
    });
  });
});
