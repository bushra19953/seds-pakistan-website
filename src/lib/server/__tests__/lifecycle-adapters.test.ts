/**
 * Tests for lifecycle-adapters.ts (Phase 2 Section D adapter layer).
 *
 * Uses a hand-rolled in-memory fake Firestore. The fake's query surface is
 * intentionally minimal: collection().get() returns every doc and where()
 * returns the same collection (full scan + in-memory filtering is the
 * adapter's documented test posture). doc(id).get()/set() and
 * collection().add() are the only other operations the adapters use.
 */

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
      },
    },
  },
}));

const mockNotificationSend = jest.fn(async () => undefined);
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: (...args: unknown[]) => mockNotificationSend(...(args as [])),
  },
}));

import {
  GovernanceAuditError,
  writeGovernanceAuditOrThrow,
  getDecidedConsent,
  membershipClassOf,
  isCadetInProbation,
  resolveRoleHolders,
  resolveRoleHoldersInChapter,
  resolveSeatedGovernors,
  resolveChapterOfficers,
  getLifecycleSettings,
  sendLifecycleNotification,
  createLifecycleTask,
} from '../lifecycle-adapters';

// --- Hand-rolled fake Firestore -------------------------------------------

type DocData = Record<string, unknown>;

class FakeDocSnapshot {
  constructor(
    public id: string,
    private _data: DocData | undefined,
  ) {}
  get exists() {
    return this._data !== undefined;
  }
  data() {
    return this._data;
  }
}

class FakeDocRef {
  constructor(
    private db: FakeDb,
    private collectionName: string,
    public id: string,
  ) {}
  async get() {
    return new FakeDocSnapshot(this.id, this.db.readDoc(this.collectionName, this.id));
  }
  async set(data: DocData, opts?: { merge?: boolean }) {
    this.db.writeDoc(this.collectionName, this.id, data, !!opts?.merge);
    return this;
  }
  async update(data: DocData) {
    this.db.writeDoc(this.collectionName, this.id, data, true);
    return this;
  }
}

class FakeCollectionRef {
  constructor(
    private db: FakeDb,
    private name: string,
  ) {}
  doc(id?: string) {
    return new FakeDocRef(this.db, this.name, id ?? this.db.nextId());
  }
  async add(data: DocData) {
    if (this.db.failAddCollections.has(this.name)) {
      throw new Error(`fake add failure for ${this.name}`);
    }
    const ref = this.doc();
    this.db.writeDoc(this.name, ref.id, { ...data }, false);
    return ref;
  }
  // Minimal query surface: where() returns all docs (see header comment).
  where() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    const docs = this.db
      .readCollection(this.name)
      .map(([id, data]) => new FakeDocSnapshot(id, data));
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach: (cb: (d: FakeDocSnapshot) => void) => docs.forEach(cb),
    };
  }
}

class FakeDb {
  private store = new Map<string, Map<string, DocData>>();
  failAddCollections = new Set<string>();
  private counter = 0;

  nextId() {
    this.counter += 1;
    return `auto-${this.counter}`;
  }
  collection(name: string) {
    return new FakeCollectionRef(this, name);
  }
  seed(collectionName: string, id: string, data: DocData) {
    this.writeDoc(collectionName, id, data, false);
  }
  readDoc(collectionName: string, id: string): DocData | undefined {
    return this.store.get(collectionName)?.get(id);
  }
  readCollection(collectionName: string): Array<[string, DocData]> {
    return Array.from(this.store.get(collectionName)?.entries() ?? []);
  }
  writeDoc(collectionName: string, id: string, data: DocData, merge: boolean) {
    if (!this.store.has(collectionName)) this.store.set(collectionName, new Map());
    const col = this.store.get(collectionName)!;
    col.set(id, merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
  }
}

// --- Tests ------------------------------------------------------------------

describe('writeGovernanceAuditOrThrow (Section 0.5)', () => {
  it('writes to audit_logs with a server timestamp and returns the id', async () => {
    const db = new FakeDb();
    const id = await writeGovernanceAuditOrThrow(db as never, {
      action: 'lifecycle.test',
      actorUid: 'actor-1',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const stored = db.readDoc('audit_logs', id);
    expect(stored).toMatchObject({ action: 'lifecycle.test', actorUid: 'actor-1' });
    expect(stored?.createdAt).toBe('SERVER_TIMESTAMP');
  });

  it('throws GovernanceAuditError when the add fails (never swallows)', async () => {
    const db = new FakeDb();
    db.failAddCollections.add('audit_logs');
    await expect(
      writeGovernanceAuditOrThrow(db as never, { action: 'lifecycle.test' }),
    ).rejects.toBeInstanceOf(GovernanceAuditError);
    expect(db.readCollection('audit_logs')).toHaveLength(0);
  });
});

describe('membershipClassOf (Phase 1 P17 adapter)', () => {
  it("returns 'Full' for a Full member", async () => {
    const db = new FakeDb();
    db.seed('users', 'u1', { membershipClass: 'Full' });
    await expect(membershipClassOf(db as never, 'u1')).resolves.toBe('Full');
  });

  it("returns 'Provisional' for a Provisional member", async () => {
    const db = new FakeDb();
    db.seed('users', 'u2', { membershipClass: 'Provisional' });
    await expect(membershipClassOf(db as never, 'u2')).resolves.toBe('Provisional');
  });

  it("returns 'other' when the field exists with another value", async () => {
    const db = new FakeDb();
    db.seed('users', 'u3', { membershipClass: 'Honorary' });
    await expect(membershipClassOf(db as never, 'u3')).resolves.toBe('other');
  });

  it('returns null when the doc or the field is absent', async () => {
    const db = new FakeDb();
    db.seed('users', 'u4', { displayName: 'No Class' });
    await expect(membershipClassOf(db as never, 'u4')).resolves.toBeNull();
    await expect(membershipClassOf(db as never, 'missing-user')).resolves.toBeNull();
  });
});

describe('isCadetInProbation (Workstream F soft dependency)', () => {
  it('defaults to false when the flag, field or user is absent', async () => {
    const db = new FakeDb();
    db.seed('users', 'u1', { displayName: 'Plain' });
    await expect(isCadetInProbation(db as never, 'u1')).resolves.toBe(false);
    await expect(isCadetInProbation(db as never, 'missing-user')).resolves.toBe(false);
  });

  it('returns true only when cadetInProbation is exactly true', async () => {
    const db = new FakeDb();
    db.seed('users', 'cadet', { cadetInProbation: true });
    db.seed('users', 'not-cadet', { cadetInProbation: false });
    await expect(isCadetInProbation(db as never, 'cadet')).resolves.toBe(true);
    await expect(isCadetInProbation(db as never, 'not-cadet')).resolves.toBe(false);
  });
});

describe('resolveRoleHolders (Section 0.4 adapter)', () => {
  it('matches roleKey, role and currentRoleKey fields and roles arrays', async () => {
    const db = new FakeDb();
    db.seed('roles', 'uid-a', { roleKey: 'chapter_treasurer' });
    db.seed('roles', 'uid-b', { role: 'chapter_treasurer' });
    db.seed('roles', 'uid-c', { currentRoleKey: 'chapter_treasurer' });
    db.seed('roles', 'uid-d', { roles: ['team_member', 'chapter_treasurer'] });
    db.seed('roles', 'uid-e', { roleKey: 'chapter_president' });
    const holders = await resolveRoleHolders(db as never, 'chapter_treasurer');
    expect(holders.sort()).toEqual(['uid-a', 'uid-b', 'uid-c', 'uid-d']);
  });

  it('returns [] for a vacant role and for an empty collection', async () => {
    const db = new FakeDb();
    db.seed('roles', 'uid-a', { roleKey: 'chapter_president' });
    await expect(resolveRoleHolders(db as never, 'governor_member')).resolves.toEqual([]);
    await expect(resolveRoleHolders(new FakeDb() as never, 'anything')).resolves.toEqual([]);
  });
});

describe('resolveRoleHoldersInChapter / resolveChapterOfficers (D.8 adapter)', () => {
  it('scopes holders by chapterSlug or chapterId', async () => {
    const db = new FakeDb();
    db.seed('roles', 'ist-pres', { roleKey: 'chapter_president', chapterSlug: 'seds-ist' });
    db.seed('roles', 'other-pres', { roleKey: 'chapter_president', chapterId: 'seds-other' });
    await expect(
      resolveRoleHoldersInChapter(db as never, 'chapter_president', 'seds-ist'),
    ).resolves.toEqual(['ist-pres']);
  });

  it('maps the five Art. 7.2 seats to a holder uid or null', async () => {
    const db = new FakeDb();
    db.seed('roles', 'ist-pres', { roleKey: 'chapter_president', chapterSlug: 'seds-ist' });
    db.seed('roles', 'ist-treasurer', { role: 'chapter_treasurer', chapterId: 'seds-ist' });
    const officers = await resolveChapterOfficers(db as never, 'seds-ist');
    expect(officers).toEqual({
      chapter_president: 'ist-pres',
      chapter_vice_president: null,
      chapter_general_secretary: null,
      chapter_treasurer: 'ist-treasurer',
      chapter_tech_lead: null,
    });
  });
});

describe('resolveSeatedGovernors (Workstream C adapter)', () => {
  it('maps the governors collection when it has uid docs', async () => {
    const db = new FakeDb();
    db.seed('governors', 'seat-1', { uid: 'gov-1' });
    db.seed('governors', 'seat-2', { uid: 'gov-2', seatKey: 'member-seat', roleKey: 'governor_member' });
    await expect(resolveSeatedGovernors(db as never)).resolves.toEqual([
      { uid: 'gov-1', seatKey: 'seat-1', roleKey: 'governor_founder' },
      { uid: 'gov-2', seatKey: 'member-seat', roleKey: 'governor_member' },
    ]);
  });

  it('falls back to roles scans when there is no governors collection', async () => {
    const db = new FakeDb();
    db.seed('roles', 'gov-1', { roleKey: 'governor_founder' });
    db.seed('roles', 'gov-2', { roles: ['governor_member'] });
    const seated = await resolveSeatedGovernors(db as never);
    expect(seated).toContainEqual({ uid: 'gov-1', seatKey: 'governor_founder', roleKey: 'governor_founder' });
    expect(seated).toContainEqual({ uid: 'gov-2', seatKey: 'governor_member', roleKey: 'governor_member' });
  });
});

describe('getLifecycleSettings (Section 0.1 / D.10-D.11 ship posture)', () => {
  it('returns the ship-posture defaults when the doc is missing', async () => {
    const db = new FakeDb();
    await expect(getLifecycleSettings(db as never)).resolves.toEqual({
      lifecycleEnforce: false,
      probationRestoreMode: 'reappoint',
      ratificationRevocationArmed: false,
    });
  });

  it('reads overrides when governance_settings/phase2 is present', async () => {
    const db = new FakeDb();
    db.seed('governance_settings', 'phase2', {
      lifecycleEnforce: true,
      probationRestoreMode: 'auto',
      ratificationRevocationArmed: true,
    });
    await expect(getLifecycleSettings(db as never)).resolves.toEqual({
      lifecycleEnforce: true,
      probationRestoreMode: 'auto',
      ratificationRevocationArmed: true,
    });
  });

  it('falls back per-field for invalid values', async () => {
    const db = new FakeDb();
    db.seed('governance_settings', 'phase2', {
      lifecycleEnforce: 'yes',
      probationRestoreMode: 'sometimes',
    });
    await expect(getLifecycleSettings(db as never)).resolves.toEqual({
      lifecycleEnforce: false,
      probationRestoreMode: 'reappoint',
      ratificationRevocationArmed: false,
    });
  });
});

describe('getDecidedConsent (Workstream A adapter, matter schedule_3_2_c)', () => {
  it('returns null when consent_requests is empty (safe degraded state)', async () => {
    const db = new FakeDb();
    await expect(
      getDecidedConsent(db as never, 'uid-1', 'national_vp_finance'),
    ).resolves.toBeNull();
  });

  it('returns the decided grant matching subject, matter and status', async () => {
    const db = new FakeDb();
    db.seed('consent_requests', 'cr-1', {
      subjectUid: 'uid-1',
      roleKey: 'national_vp_finance',
      matterKey: 'schedule_3_2_c',
      status: 'granted',
    });
    db.seed('consent_requests', 'cr-2', {
      subjectUid: 'uid-1',
      roleKey: 'national_vp_finance',
      matter: 'schedule_3_2_c',
      status: 'pending',
    });
    db.seed('consent_requests', 'cr-3', {
      subjectUid: 'someone-else',
      roleKey: 'national_vp_finance',
      matter: 'schedule_3_2_c',
      status: 'decided',
    });
    const found = await getDecidedConsent(db as never, 'uid-1', 'national_vp_finance');
    expect(found).toEqual({
      id: 'cr-1',
      subjectUid: 'uid-1',
      roleKey: 'national_vp_finance',
      status: 'granted',
    });
  });
});

describe('sendLifecycleNotification / createLifecycleTask', () => {
  beforeEach(() => {
    mockNotificationSend.mockClear();
  });

  it('uses the real notificationService when the payload has title and body', async () => {
    const db = new FakeDb();
    await sendLifecycleNotification(db as never, 'uid-1', 'lifecycle_notice', {
      title: 'Notice',
      body: 'Something happened',
    });
    expect(mockNotificationSend).toHaveBeenCalledTimes(1);
    expect(mockNotificationSend.mock.calls[0][0]).toBe('uid-1');
    expect(db.readCollection('notifications')).toHaveLength(0);
  });

  it('falls back to a notifications doc when the payload does not fit, and never throws', async () => {
    const db = new FakeDb();
    await sendLifecycleNotification(db as never, 'uid-1', 'lifecycle_notice', {
      detail: 'no title/body here',
    });
    expect(mockNotificationSend).not.toHaveBeenCalled();
    const docs = db.readCollection('notifications');
    expect(docs).toHaveLength(1);
    expect(docs[0][1]).toMatchObject({
      userId: 'uid-1',
      type: 'lifecycle_notice',
      detail: 'no title/body here',
      read: false,
    });
  });

  it('creates a tasks doc with the real tasks field names and lifecycle metadata', async () => {
    const db = new FakeDb();
    const id = await createLifecycleTask(db as never, {
      title: 'Restore role',
      body: 'Restore the pre-warning role',
      assigneeUids: ['uid-b', 'uid-a'],
      relatedUserId: 'uid-a',
      relatedWarningId: 'warn-1',
    });
    const stored = db.readDoc('tasks', id);
    expect(stored).toMatchObject({
      title: 'Restore role',
      description: 'Restore the pre-warning role',
      assigneeId: 'uid-a',
      assigneeIds: ['uid-a', 'uid-b'],
      status: 'pending',
      acceptanceStatus: 'pending-acceptance',
      relatedUserId: 'uid-a',
      relatedWarningId: 'warn-1',
    });
    expect((stored?.metadata as DocData)?.source).toBe('lifecycle');
  });
});
