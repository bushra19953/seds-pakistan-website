/**
 * Service tests for src/lib/server/governance/meetings.ts.
 * No existing repo server test mocks a full Firestore, so these inject a
 * minimal in-memory fake store through the service's db parameter (the
 * service takes db as its first argument, exactly so this is possible).
 */
import {
  createMeeting,
  getMeeting,
  recordAttendance,
  sendNotice,
  verifyQuorum,
  MeetingServiceError,
  QuorumForbiddenError,
} from '../meetings';

// --- Fake Firestore ---------------------------------------------------------

function makeFakeDb() {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let auto = 0;
  const coll = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  function docRef(name: string, id: string) {
    return {
      id,
      async get() {
        const data = coll(name).get(id);
        return { exists: data !== undefined, id, data: () => data };
      },
      async set(data: Record<string, unknown>) {
        coll(name).set(id, { ...data });
      },
      async update(patch: Record<string, unknown>) {
        const cur = coll(name).get(id);
        if (!cur) throw new Error(`update on missing doc ${name}/${id}`);
        coll(name).set(id, { ...cur, ...patch });
      },
    };
  }
  function query(name: string, filters: Array<[string, string, unknown]> = []) {
    return {
      where(field: string, op: string, value: unknown) {
        return query(name, [...filters, [field, op, value]]);
      },
      async get() {
        const docs = [...coll(name).entries()]
          .filter(([, data]) => filters.every(([f, , v]) => data[f] === v))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  const db = {
    collection(name: string) {
      return {
        doc(id?: string) {
          return docRef(name, id ?? `auto-${++auto}`);
        },
        where(field: string, op: string, value: unknown) {
          return query(name, [[field, op, value]]);
        },
        async get() {
          return query(name).get();
        },
      };
    },
    _store: store,
  };
  return db;
}

const MEMBERS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'];
const NOW = new Date('2026-11-01T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function seedBoard(db: ReturnType<typeof makeFakeDb>) {
  await db.collection('bodies').doc('body-board').set({
    name: 'Board of Governors',
    type: 'board',
    chairUid: 'u1',
    secretaryUid: 'u2',
    memberUids: [...MEMBERS],
    quorumOverride: null,
    quorum: null,
    chapterId: null,
    term: null,
    createdBy: 'founder',
    updatedBy: 'founder',
  });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    bodyId: 'body-board',
    type: 'ordinary' as const,
    title: 'Board meeting',
    scheduledAt: new Date(NOW.getTime() + 20 * DAY),
    durationMinutes: 90,
    location: 'Room 131',
    actorUid: 'u1',
    meetingId: 'm-1',
    now: NOW,
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

describe('meetings service: createMeeting', () => {
  it('blocks creation on short notice with error_code notice_too_short', async () => {
    const db = makeFakeDb();
    await seedBoard(db);
    await expect(
      createMeeting(db, baseInput({ scheduledAt: new Date(NOW.getTime() + 5 * DAY) })),
    ).rejects.toMatchObject({ error_code: 'notice_too_short', status: 422 });
    expect(db._store.get('meetings')?.size ?? 0).toBe(0);
  });

  it('blocks a board emergency with no consent (consent_required)', async () => {
    const db = makeFakeDb();
    await seedBoard(db);
    await expect(
      createMeeting(db, baseInput({ type: 'emergency', scheduledAt: new Date(NOW.getTime() + 3 * DAY) })),
    ).rejects.toMatchObject({ error_code: 'consent_required' });
  });

  it('blocks a board emergency whose consent is not decided (consent_not_decided)', async () => {
    const db = makeFakeDb();
    await seedBoard(db);
    await expect(
      createMeeting(
        db,
        baseInput({
          type: 'emergency',
          scheduledAt: new Date(NOW.getTime() + 3 * DAY),
          consentId: 'c-1',
          consentState: { consentId: 'c-1', decided: false, state: 'not_decided' },
        }),
      ),
    ).rejects.toMatchObject({ error_code: 'consent_not_decided' });
  });

  it('blocks an emergency for a non-board body (emergency_board_only)', async () => {
    const db = makeFakeDb();
    await db.collection('bodies').doc('body-nec').set({
      name: 'NEC', type: 'nec', chairUid: 'u1', secretaryUid: 'u2',
      memberUids: [...MEMBERS], quorumOverride: null, quorum: null, chapterId: null,
    });
    await expect(
      createMeeting(db, baseInput({ bodyId: 'body-nec', type: 'emergency', scheduledAt: new Date(NOW.getTime() + 3 * DAY) })),
    ).rejects.toMatchObject({ error_code: 'emergency_board_only' });
  });

  it('stores quorumRequired and denormalized chair/secretary/bodyType', async () => {
    const db = makeFakeDb();
    await seedBoard(db);
    const result = await createMeeting(db, baseInput());
    expect(result.quorumRequired).toBe(5);
    expect(result.status).toBe('draft');
    const meeting = await getMeeting(db, 'm-1');
    expect(meeting?.quorumRequired).toBe(5);
    expect(meeting?.chairUid).toBe('u1');
    expect(meeting?.secretaryUid).toBe('u2');
    expect(meeting?.bodyType).toBe('board');
    // One pre-created absent attendance doc per member.
    expect(db._store.get('meeting_attendance')?.size).toBe(9);
    expect(db._store.get('meeting_attendance')?.get('m-1_u3')).toMatchObject({ mode: 'absent', isPresent: false });
  });

  it('fails with body_not_found for a missing body', async () => {
    const db = makeFakeDb();
    await expect(createMeeting(db, baseInput({ bodyId: 'nope' }))).rejects.toMatchObject({
      error_code: 'body_not_found',
    });
  });
});

describe('meetings service: sendNotice', () => {
  it('sets noticeSentAt + deemedReceivedAt, appends the log id, draft -> noticed', async () => {
    const db = makeFakeDb();
    await seedBoard(db);
    await createMeeting(db, baseInput());
    const out = await sendNotice(db, { meetingId: 'm-1', actorUid: 'u1', now: NOW });
    expect(out.status).toBe('noticed');
    expect(out.logId).toBe('stub-notice-m-1');
    const meeting = await getMeeting(db, 'm-1');
    expect(meeting?.status).toBe('noticed');
    expect(meeting?.noticeSentAt?.getTime()).toBe(NOW.getTime());
    expect(meeting?.deemedReceivedAt).not.toBeNull();
    expect(meeting!.deemedReceivedAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(meeting?.noticeEmailLogIds).toEqual(['stub-notice-m-1']);
  });
});

describe('meetings service: recordAttendance', () => {
  it('writes meeting_attendance doc with id `${meetingId}_${uid}` and contract shape', async () => {
    const db = makeFakeDb();
    await seedBoard(db);
    await createMeeting(db, baseInput());
    const record = await recordAttendance(db, {
      meetingId: 'm-1', uid: 'u3', mode: 'electronic', actorUid: 'u1', displayName: 'Member Three', now: NOW,
    });
    expect(record.id).toBe('m-1_u3');
    const stored = db._store.get('meeting_attendance')?.get('m-1_u3');
    expect(stored).toMatchObject({
      id: 'm-1_u3', meetingId: 'm-1', bodyId: 'body-board', uid: 'u3',
      displayName: 'Member Three', mode: 'electronic', isPresent: true, updatedBy: 'u1',
    });
    expect(stored?.checkedInAt).toEqual(NOW);
    expect(stored?.leftAt).toBeNull();
  });
});

describe('meetings service: verifyQuorum', () => {
  async function noticedMeetingWithPresent(presentCount: number) {
    const db = makeFakeDb();
    await seedBoard(db);
    await createMeeting(db, baseInput());
    await sendNotice(db, { meetingId: 'm-1', actorUid: 'u1', now: NOW });
    for (const uid of MEMBERS.slice(0, presentCount)) {
      await recordAttendance(db, { meetingId: 'm-1', uid, mode: 'in_person', actorUid: 'u1', now: NOW });
    }
    return db;
  }

  it('forbids a non-chair with a typed 403 error', async () => {
    const db = await noticedMeetingWithPresent(5);
    const err = await verifyQuorum(db, { meetingId: 'm-1', actorUid: 'u3', now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(QuorumForbiddenError);
    expect(err).toBeInstanceOf(MeetingServiceError);
    expect(err.error_code).toBe('forbidden_not_chair');
    expect(err.status).toBe(403);
    const meeting = await getMeeting(db, 'm-1');
    expect(meeting?.quorumVerifiedAt).toBeNull();
  });

  it('verifies for the chair using the stored quorumRequired and stamps the meeting', async () => {
    const db = await noticedMeetingWithPresent(5);
    const result = await verifyQuorum(db, { meetingId: 'm-1', actorUid: 'u1', now: NOW });
    expect(result.quorumMet).toBe(true);
    expect(result.presentCount).toBe(5);
    expect(result.quorumRequired).toBe(5);
    const meeting = await getMeeting(db, 'm-1');
    expect(meeting?.quorumVerifiedBy).toBe('u1');
    expect(meeting?.quorumVerifiedAt?.getTime()).toBe(NOW.getTime());
    expect(meeting?.status).toBe('convened');
  });

  it('reports quorum not met (and writes nothing) when present count is short', async () => {
    const db = await noticedMeetingWithPresent(4);
    const result = await verifyQuorum(db, { meetingId: 'm-1', actorUid: 'u1', now: NOW });
    expect(result.quorumMet).toBe(false);
    expect(result.presentCount).toBe(4);
    const meeting = await getMeeting(db, 'm-1');
    expect(meeting?.quorumVerifiedAt).toBeNull();
  });
});
