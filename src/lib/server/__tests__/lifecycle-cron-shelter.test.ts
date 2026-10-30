/**
 * Cron shelter (census 20 row 2): governance bounded reads.
 *
 * The fake below is HONEST: where/orderBy/limit really filter, and
 * every executed query is recorded. Pins:
 *  - scanVacancies reads audit_logs through ONE bounded query:
 *    action IN (the exact vacating + appointing actions its two
 *    consumers use) + createdAt >= now - AUDIT_TRAIL_WINDOW_MS +
 *    limit AUDIT_TRAIL_LIMIT — never a bare collection get();
 *  - behaviour on today's shapes is preserved: the tech-lead vacancy
 *    still opens with the audit-derived reason and openedAt, and an
 *    entry OUTSIDE the window (400 days old) no longer explains a
 *    vacancy (reason falls back to 'unknown', honestly);
 *  - stampDeemedRatifications queries ratifications with
 *    status == 'pending' + limit, and still stamps a past-deadline
 *    pending record (and only that one);
 *  - retryProbationRestores queries probation_restores with
 *    status == 'pending' + limit, and still decides an expired
 *    pending record for a banned user (escalated, not stranded).
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
  AUDIT_TRAIL_ACTIONS,
  AUDIT_TRAIL_LIMIT,
  AUDIT_TRAIL_WINDOW_MS,
  scanVacancies,
  vacancyDocId,
} from '../lifecycle-vacancy';
import {
  RATIFICATION_SCAN_LIMIT,
  stampDeemedRatifications,
  toMillis,
} from '../lifecycle-ratification';
import {
  PROBATION_RETRY_SCAN_LIMIT,
  retryProbationRestores,
} from '../lifecycle-probation';

// --- Recording, honest fake Firestore --------------------------------------

type DocData = Record<string, unknown>;

interface QueryRecord {
  collection: string;
  filters: Array<{ field: string; op: string; value: unknown }>;
  orderByField: string | null;
  limitN: number | null;
  /** True when get() was called on the bare collection (no where). */
  bare: boolean;
}

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

function matchesFilter(data: DocData, f: { field: string; op: string; value: unknown }): boolean {
  const v = data[f.field];
  if (f.op === '==') return v === f.value;
  if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(v as never);
  if (f.op === '>=') return toMillis(v) >= toMillis(f.value);
  if (f.op === '<') return toMillis(v) < toMillis(f.value);
  return true;
}

class FakeQuery {
  constructor(
    protected db: FakeDb,
    protected name: string,
    protected filters: QueryRecord['filters'] = [],
    protected orderByField: string | null = null,
    protected limitN: number | null = null,
  ) {}
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.db, this.name, [...this.filters, { field, op, value }], this.orderByField, this.limitN);
  }
  orderBy(field: string) {
    return new FakeQuery(this.db, this.name, this.filters, field, this.limitN);
  }
  limit(n: number) {
    return new FakeQuery(this.db, this.name, this.filters, this.orderByField, n);
  }
  async get() {
    this.db.queryLog.push({
      collection: this.name,
      filters: this.filters,
      orderByField: this.orderByField,
      limitN: this.limitN,
      bare: this.filters.length === 0 && this.limitN === null,
    });
    let docs = this.db
      .readCollection(this.name)
      .filter(([, data]) => this.filters.every((f) => matchesFilter(data, f)))
      .map(([id, data]) => new FakeDocSnapshot(id, data));
    if (this.orderByField) {
      const field = this.orderByField;
      docs = [...docs].sort((a, b) => toMillis(b.data()?.[field]) - toMillis(a.data()?.[field]));
    }
    if (this.limitN !== null) docs = docs.slice(0, this.limitN);
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach: (cb: (d: FakeDocSnapshot) => void) => docs.forEach(cb),
    };
  }
}

class FakeCollectionRef extends FakeQuery {
  constructor(db: FakeDb, name: string) {
    super(db, name);
  }
  doc(id?: string) {
    return new FakeDocRef(this.db, this.name, id ?? this.db.nextId());
  }
  async add(data: DocData) {
    const ref = this.doc();
    this.db.writeDoc(this.name, ref.id, { ...data }, false);
    return ref;
  }
}

class FakeDb {
  private store = new Map<string, Map<string, DocData>>();
  private counter = 0;
  queryLog: QueryRecord[] = [];
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
  queriesFor(collection: string): QueryRecord[] {
    return this.queryLog.filter((q) => q.collection === collection);
  }
}

// --- Fixtures ----------------------------------------------------------------

const T0 = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mockNotificationSend.mockClear();
});

describe('scanVacancies bounded audit read', () => {
  function seedWorld(db: FakeDb) {
    db.seed('roles', 'pres-1', { role: 'president_national' });
    db.seed('roles', 'ngs-1', { role: 'national_general_secretary' });
    db.seed('chapters', 'ist', { slug: 'ist', isActive: true });
    db.seed('roles', 'cp-1', { role: 'chapter_president', chapterSlug: 'ist' });
    db.seed('roles', 'cvp-1', { role: 'chapter_vice_president', chapterSlug: 'ist' });
    db.seed('roles', 'cgs-1', { role: 'chapter_general_secretary', chapterSlug: 'ist' });
    db.seed('roles', 'ct-1', { role: 'chapter_treasurer', chapterSlug: 'ist' });
    // In-window explanation for the tech-lead vacancy.
    db.seed('audit_logs', 'audit-revoke-1', {
      action: 'role_revoked',
      roleKey: 'chapter_tech_lead',
      chapterSlug: 'ist',
      targetUid: 'tech-1',
      createdAt: T0,
    });
    // An unrelated action that must never be read into the trail.
    db.seed('audit_logs', 'audit-noise', {
      action: 'task_completed',
      roleKey: 'chapter_tech_lead',
      chapterSlug: 'ist',
      targetUid: 'tech-1',
      createdAt: T0,
    });
    // A vacating entry 400 days old: outside the shelter window.
    db.seed('audit_logs', 'audit-ancient', {
      action: 'role_revoked',
      roleKey: 'national_vice_president',
      targetUid: 'vp-old',
      createdAt: new Date(T0.getTime() - 400 * DAY),
    });
  }

  it('queries audit_logs by action set + createdAt window + limit, never bare', async () => {
    const db = new FakeDb();
    seedWorld(db);
    await scanVacancies(db, T0);
    const auditQueries = db.queriesFor('audit_logs');
    // add() calls from audit writes do not log queries; the read is one.
    const reads = auditQueries.filter((q) => !q.bare || q.filters.length > 0);
    expect(reads).toHaveLength(1);
    const q = reads[0];
    expect(q.bare).toBe(false);
    const actionFilter = q.filters.find((f) => f.field === 'action');
    expect(actionFilter?.op).toBe('in');
    expect(new Set(actionFilter?.value as string[])).toEqual(new Set(AUDIT_TRAIL_ACTIONS));
    // Exactly the consumed actions: 6 vacating + 4 appointing.
    expect(AUDIT_TRAIL_ACTIONS).toHaveLength(10);
    expect(AUDIT_TRAIL_ACTIONS).toContain('role_revoked');
    expect(AUDIT_TRAIL_ACTIONS).toContain('role_assigned');
    const windowFilter = q.filters.find((f) => f.field === 'createdAt');
    expect(windowFilter?.op).toBe('>=');
    expect(toMillis(windowFilter?.value)).toBe(T0.getTime() - AUDIT_TRAIL_WINDOW_MS);
    expect(q.limitN).toBe(AUDIT_TRAIL_LIMIT);
  });

  it('preserves behaviour in-window; out-of-window entries no longer explain a vacancy', async () => {
    const db = new FakeDb();
    seedWorld(db);
    const result = await scanVacancies(db, T0);
    expect(result.errors).toBe(0);
    const tech = db.readDoc('vacancies', vacancyDocId('chapter', 'chapter_tech_lead', 'ist'))!;
    expect(tech.status).toBe('open');
    expect(tech.vacancyReason).toBe('role_revoked');
    expect(tech.openedAtSource).toBe('audit_trail');
    expect(toMillis(tech.openedAt)).toBe(T0.getTime());
    expect(tech.lastHolderUid).toBe('tech-1');
    const vp = db.readDoc('vacancies', vacancyDocId('national', 'national_vice_president', null))!;
    expect(vp).toBeDefined();
    expect(vp.vacancyReason).toBe('unknown');
    expect(vp.openedAtSource).toBe('first_observation');
  });
});

describe('stampDeemedRatifications bounded read', () => {
  it('queries status == pending with a limit and stamps only the due pending record', async () => {
    const db = new FakeDb();
    db.seed('ratifications', 'rat-due', {
      status: 'pending',
      userId: 'u-1',
      roleKey: 'national_treasurer',
      ratificationDeadline: new Date(T0.getTime() - DAY),
      voteId: null,
    });
    db.seed('ratifications', 'rat-future', {
      status: 'pending',
      userId: 'u-2',
      roleKey: 'national_treasurer',
      ratificationDeadline: new Date(T0.getTime() + 10 * DAY),
      voteId: null,
    });
    db.seed('ratifications', 'rat-done', {
      status: 'ratified',
      userId: 'u-3',
      roleKey: 'national_treasurer',
      ratificationDeadline: new Date(T0.getTime() - DAY),
      voteId: null,
    });
    const result = await stampDeemedRatifications(db, T0);
    const q = db.queriesFor('ratifications')[0];
    expect(q.filters).toEqual([{ field: 'status', op: '==', value: 'pending' }]);
    expect(q.limitN).toBe(RATIFICATION_SCAN_LIMIT);
    expect(result).toMatchObject({ scanned: 2, stamped: 1, skipped: 1, errors: 0 });
    expect(db.readDoc('ratifications', 'rat-due')!.status).toBe('deemed_ratified');
    expect(db.readDoc('ratifications', 'rat-future')!.status).toBe('pending');
    expect(db.readDoc('ratifications', 'rat-done')!.status).toBe('ratified');
  });
});

describe('retryProbationRestores bounded read', () => {
  it('queries status == pending with a limit; expired banned record is decided, others untouched', async () => {
    const db = new FakeDb();
    db.seed('users', 'banned-1', { isBanned: true, displayName: 'Banned One' });
    db.seed('probation_restores', 'w-banned', {
      warningId: 'w-banned',
      userId: 'banned-1',
      status: 'pending',
      restoreMode: 'reappoint',
      probationEndsAt: new Date(T0.getTime() - DAY),
      preWarningRoleKey: 'chapter_president',
      demotedToRoleKey: 'member_basic',
    });
    db.seed('probation_restores', 'w-future', {
      warningId: 'w-future',
      userId: 'banned-1',
      status: 'pending',
      restoreMode: 'reappoint',
      probationEndsAt: new Date(T0.getTime() + 10 * DAY),
      preWarningRoleKey: 'chapter_president',
      demotedToRoleKey: 'member_basic',
    });
    db.seed('probation_restores', 'w-done', {
      warningId: 'w-done',
      userId: 'banned-1',
      status: 'restored_automatic',
      restoreMode: 'reappoint',
      probationEndsAt: new Date(T0.getTime() - DAY),
      preWarningRoleKey: 'chapter_president',
      demotedToRoleKey: 'member_basic',
    });
    const result = await retryProbationRestores(db, T0);
    const q = db.queriesFor('probation_restores')[0];
    expect(q.filters).toEqual([{ field: 'status', op: '==', value: 'pending' }]);
    expect(q.limitN).toBe(PROBATION_RETRY_SCAN_LIMIT);
    expect(result).toMatchObject({ scanned: 1, acted: 1, errors: 0 });
    expect(db.readDoc('probation_restores', 'w-banned')!.status).toBe('escalated');
    expect(db.readDoc('probation_restores', 'w-future')!.status).toBe('pending');
    expect(db.readDoc('probation_restores', 'w-done')!.status).toBe('restored_automatic');
  });
});
