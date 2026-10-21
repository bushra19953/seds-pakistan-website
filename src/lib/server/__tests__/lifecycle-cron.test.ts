/**
 * T14 (spec D.9/D.6): the governance cron dispatcher.
 *
 * - one action throwing does not prevent the other actions from running;
 * - the run summary counts each action separately;
 * - stub stanzas (Workstreams E and C) are registered but disabled;
 * - dryRun executes nothing and writes nothing;
 * - the default registry runs end-to-end against an empty store.
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
  buildGovernanceCronRegistry,
  runGovernanceCron,
  type GovernanceCronAction,
} from '../lifecycle-cron';

// --- Minimal fake (empty-store posture is all the dispatcher needs) --------

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
    const ref = this.doc();
    this.db.writeDoc(this.name, ref.id, { ...data }, false);
    return ref;
  }
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

const NOW = new Date('2026-10-21T04:00:00.000Z');
const zeros = { scanned: 0, acted: 0, skipped: 0, errors: 0 };

describe('T14 governance cron dispatcher', () => {
  it('a throwing action is counted and does not starve later actions; counts stay per-action', async () => {
    const ran: string[] = [];
    const registry: GovernanceCronAction[] = [
      {
        name: 'first',
        owner: 'D',
        enabled: true,
        run: async () => {
          ran.push('first');
          return { scanned: 3, acted: 1, skipped: 2, errors: 0 };
        },
      },
      {
        name: 'boom',
        owner: 'D',
        enabled: true,
        run: async () => {
          ran.push('boom');
          throw new Error('kaboom');
        },
      },
      {
        name: 'stampDeemedRatifications',
        owner: 'D',
        enabled: true,
        run: async () => {
          ran.push('stampDeemedRatifications');
          return { scanned: 2, acted: 2, skipped: 0, errors: 0 };
        },
      },
    ];
    const db = new FakeDb();
    const summary = await runGovernanceCron(db, NOW, { registry });
    expect(ran).toEqual(['first', 'boom', 'stampDeemedRatifications']);
    const byName = Object.fromEntries(summary.actions.map((a) => [a.name, a]));
    expect(byName.first).toMatchObject({ scanned: 3, acted: 1, skipped: 2, errors: 0 });
    expect(byName.boom).toMatchObject({ errors: 1, errorMessage: 'kaboom' });
    expect(byName.stampDeemedRatifications).toMatchObject({ scanned: 2, acted: 2, errors: 0 });
    expect(summary.totals).toEqual({ scanned: 5, acted: 3, skipped: 2, errors: 1 });
    // The run itself is audit-logged.
    const audits = db.readCollection('audit_logs').map(([, d]) => d);
    expect(audits.some((a) => a.action === 'governance_cron_run')).toBe(true);
  });

  it('default registry: D actions enabled, E and C stanzas registered disabled', () => {
    const registry = buildGovernanceCronRegistry();
    const byName = Object.fromEntries(registry.map((a) => [a.name, a]));
    expect(byName.stampDeemedRatifications.enabled).toBe(true);
    expect(byName.scanVacancies.enabled).toBe(true);
    expect(byName.retryProbationRestores.enabled).toBe(true);
    expect(byName.deadlineReferralDrafting).toMatchObject({ enabled: false, owner: 'E' });
    expect(byName.governorTermAlerts).toMatchObject({ enabled: false, owner: 'C' });
  });

  it('default registry runs end-to-end on an empty store with zero errors', async () => {
    const db = new FakeDb();
    const summary = await runGovernanceCron(db, NOW);
    expect(summary.totals.errors).toBe(0);
    expect(summary.auditError).toBeUndefined();
    const vacancyAction = summary.actions.find((a) => a.name === 'scanVacancies')!;
    expect(vacancyAction.scanned).toBe(10); // the 10 national V1 seats, no chapters
  });

  it('dryRun executes nothing, writes nothing, and reports the posture', async () => {
    const db = new FakeDb();
    // A ratification that WOULD deem on a real run.
    db.seed('ratifications', 'rat_x', {
      status: 'pending',
      ratificationDeadline: new Date('2026-10-01T00:00:00.000Z'),
      userId: 'officer-1',
      roleKey: 'national_treasurer',
    });
    const summary = await runGovernanceCron(db, NOW, { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.settings.lifecycleEnforce).toBe(false);
    expect(summary.settings.probationRestoreMode).toBe('reappoint');
    expect(summary.totals).toEqual(zeros);
    expect(db.readDoc('ratifications', 'rat_x')!.status).toBe('pending');
    expect(db.readCollection('audit_logs')).toHaveLength(0);
  });

  it('a real run after a dry run still deems (dryRun consumed nothing)', async () => {
    const db = new FakeDb();
    db.seed('ratifications', 'rat_x', {
      status: 'pending',
      appointedAt: new Date('2026-09-21T00:00:00.000Z'),
      ratificationDeadline: new Date('2026-10-01T00:00:00.000Z'),
      userId: 'officer-1',
      roleKey: 'national_treasurer',
      voteId: null,
    });
    await runGovernanceCron(db, NOW, { dryRun: true });
    const summary = await runGovernanceCron(db, NOW);
    const deem = summary.actions.find((a) => a.name === 'stampDeemedRatifications')!;
    expect(deem.acted).toBe(1);
    expect(db.readDoc('ratifications', 'rat_x')!.status).toBe('deemed_ratified');
  });
});
