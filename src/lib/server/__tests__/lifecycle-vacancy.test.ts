/**
 * T11 (spec D.9): vacancy derivation.
 *
 * - role removal opens exactly one vacancy at the next scan with the
 *   audit-derived reason; rescan does not move openedAt;
 * - fill closes it with the appointment id;
 * - a chapter losing a minimum officer flags underConstitutedOfficerCount
 *   on the chapter doc and chapterUnderConstituted on the vacancy;
 * - governor_* and founder_patron never produce V1 vacancies; pool roles
 *   never produce vacancies;
 * - alert stages fire exactly once each across repeated scans spanning
 *   day 0/7/23/30 (fake clock); day-30 sets founderFallbackAvailable;
 * - a vacancy whose appointer is itself vacant escalates to the Founder.
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

import { FOUNDER_UID } from '@/lib/roles';
import {
  nationalSeatInventory,
  scanVacancies,
  vacancyDocId,
} from '../lifecycle-vacancy';
import { toMillis } from '../lifecycle-ratification';

// --- Fake Firestore (same posture as the other lifecycle suites) -----------

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

// --- Fixtures ---------------------------------------------------------------

const T0 = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TECH_VACANCY_ID = vacancyDocId('chapter', 'chapter_tech_lead', 'ist');

function seedWorld(db: FakeDb) {
  // National holders: president, treasurer, NGS seated; other B seats empty.
  db.seed('roles', 'pres-1', { role: 'president_national' });
  db.seed('roles', 'treas-1', { role: 'national_treasurer' });
  db.seed('roles', 'ngs-1', { role: 'national_general_secretary' });
  // Chapter ist: 4 of 5 Art. 7.2 officers seated; tech lead removed at T0.
  db.seed('chapters', 'ist', { slug: 'ist', isActive: true });
  db.seed('roles', 'cp-1', { role: 'chapter_president', chapterSlug: 'ist' });
  db.seed('roles', 'cvp-1', { role: 'chapter_vice_president', chapterSlug: 'ist' });
  db.seed('roles', 'cgs-1', { role: 'chapter_general_secretary', chapterSlug: 'ist' });
  db.seed('roles', 'ct-1', { role: 'chapter_treasurer', chapterSlug: 'ist' });
  db.seed('audit_logs', 'audit-revoke-1', {
    action: 'role_revoked',
    roleKey: 'chapter_tech_lead',
    chapterSlug: 'ist',
    targetUid: 'tech-1',
    createdAt: T0,
  });
}

function notificationsFor(vacancyId: string, stage?: string) {
  return mockNotificationSend.mock.calls.filter((call) => {
    const payload = call[1] as { metadata?: Record<string, unknown> } | undefined;
    const meta = payload?.metadata ?? {};
    return meta.vacancyId === vacancyId && (stage === undefined || meta.stage === stage);
  });
}

beforeEach(() => {
  mockNotificationSend.mockClear();
});

describe('T11 vacancy derivation', () => {
  it('inventory excludes governor seats, founder_patron, and pool roles', () => {
    const keys = nationalSeatInventory().map((s) => s.seatKey);
    expect(keys).not.toContain('governor_member');
    expect(keys).not.toContain('governor_founder');
    expect(keys).not.toContain('governor_coopted');
    expect(keys).not.toContain('founder_patron');
    expect(keys).not.toContain('cubesat_team');
    expect(keys).not.toContain('member');
    expect(keys).toContain('national_treasurer');
    expect(keys).toContain('president_national');
  });

  it('removal opens exactly one vacancy with the audit reason; openedAt never moves on rescan', async () => {
    const db = new FakeDb();
    seedWorld(db);
    const first = await scanVacancies(db, T0);
    expect(first.errors).toBe(0);
    const vac = db.readDoc('vacancies', TECH_VACANCY_ID)!;
    expect(vac).toBeDefined();
    expect(vac.status).toBe('open');
    expect(vac.vacancyReason).toBe('role_revoked');
    expect(vac.openedAtSource).toBe('audit_trail');
    expect(toMillis(vac.openedAt)).toBe(T0.getTime());
    expect(vac.lastHolderUid).toBe('tech-1');
    expect(vac.chapterUnderConstituted).toBe(true);
    expect(db.readDoc('chapters', 'ist')!.underConstitutedOfficerCount).toBe(1);
    // Exactly one vacancy doc for the seat, and held seats produce none.
    const techDocs = db
      .readCollection('vacancies')
      .filter(([id]) => id === TECH_VACANCY_ID);
    expect(techDocs).toHaveLength(1);
    expect(db.readDoc('vacancies', vacancyDocId('national', 'national_treasurer', null))).toBeUndefined();
    expect(db.readDoc('vacancies', vacancyDocId('chapter', 'chapter_president', 'ist'))).toBeUndefined();

    const second = await scanVacancies(db, new Date(T0.getTime() + 3 * DAY));
    expect(second.opened).toBe(0);
    expect(toMillis(db.readDoc('vacancies', TECH_VACANCY_ID)!.openedAt)).toBe(T0.getTime());
    expect(db.readDoc('vacancies', TECH_VACANCY_ID)!.daysOpen).toBe(3);
  });

  it('alert stages fire exactly once each across day 0/7/23/30 scans; day-30 sets the fallback flag', async () => {
    const db = new FakeDb();
    seedWorld(db);
    await scanVacancies(db, T0);
    // Day 0 alert went to the appointer (chapter president of ist).
    const day0 = notificationsFor(TECH_VACANCY_ID, 'day0');
    expect(day0).toHaveLength(1);
    expect(day0[0][0]).toBe('cp-1');

    await scanVacancies(db, new Date(T0.getTime() + 7 * DAY));
    const day7 = notificationsFor(TECH_VACANCY_ID, 'day7');
    const day7Recipients = day7.map((c) => c[0]).sort();
    expect(day7Recipients).toEqual(['cp-1', 'ngs-1']);
    expect(notificationsFor(TECH_VACANCY_ID, 'day0')).toHaveLength(1);

    await scanVacancies(db, new Date(T0.getTime() + 23 * DAY));
    expect(notificationsFor(TECH_VACANCY_ID, 'day23')).toHaveLength(1);
    expect(db.readDoc('vacancies', TECH_VACANCY_ID)!.founderFallbackAvailable).toBe(false);

    await scanVacancies(db, new Date(T0.getTime() + 30 * DAY));
    const day30 = notificationsFor(TECH_VACANCY_ID, 'day30');
    expect(day30.map((c) => c[0])).toContain(FOUNDER_UID);
    expect(db.readDoc('vacancies', TECH_VACANCY_ID)!.founderFallbackAvailable).toBe(true);

    // Repeated scans re-fire nothing. Total sends across all stages:
    // day0 x1 recipient, day7 x2, day23 x1, day30 x3 = 7 sends, 4 stages.
    const sendsBefore = notificationsFor(TECH_VACANCY_ID).length;
    expect(sendsBefore).toBe(7);
    await scanVacancies(db, new Date(T0.getTime() + 31 * DAY));
    expect(notificationsFor(TECH_VACANCY_ID)).toHaveLength(sendsBefore);
    const stamps = db.readDoc('vacancies', TECH_VACANCY_ID)!.alertsSent as Record<string, unknown>;
    expect(stamps.day0).not.toBeNull();
    expect(stamps.day7).not.toBeNull();
    expect(stamps.day23).not.toBeNull();
    expect(stamps.day30).not.toBeNull();
  });

  it('fill closes the vacancy with the appointment id and clears the chapter flag', async () => {
    const db = new FakeDb();
    seedWorld(db);
    await scanVacancies(db, T0);
    db.seed('roles', 'tech-2', { role: 'chapter_tech_lead', chapterSlug: 'ist' });
    db.seed('audit_logs', 'audit-assign-1', {
      action: 'role_assigned',
      roleKey: 'chapter_tech_lead',
      chapterSlug: 'ist',
      targetUid: 'tech-2',
      appointmentId: 'appt-99',
      createdAt: new Date(T0.getTime() + 2 * DAY),
    });
    await scanVacancies(db, new Date(T0.getTime() + 2 * DAY));
    const vac = db.readDoc('vacancies', TECH_VACANCY_ID)!;
    expect(vac.status).toBe('filled');
    expect(vac.filledByUid).toBe('tech-2');
    expect(vac.fillingAppointmentId).toBe('appt-99');
    expect(db.readDoc('chapters', 'ist')!.underConstitutedOfficerCount).toBe(0);
  });

  it('a vacancy whose appointer is itself vacant escalates the day-0 alert to the Founder', async () => {
    const db = new FakeDb();
    seedWorld(db);
    // Chapter khi exists but has NO officers at all: the chapter_treasurer
    // vacancy's appointer (khi's chapter president) is missing.
    db.seed('chapters', 'khi', { slug: 'khi', isActive: true });
    await scanVacancies(db, T0);
    const treasurerVacancy = vacancyDocId('chapter', 'chapter_treasurer', 'khi');
    const day0 = notificationsFor(treasurerVacancy, 'day0');
    expect(day0.map((c) => c[0])).toEqual([FOUNDER_UID]);
    // The chapter_president vacancy itself goes to its appointer, the
    // National President, not the Founder.
    const presidentVacancy = vacancyDocId('chapter', 'chapter_president', 'khi');
    expect(notificationsFor(presidentVacancy, 'day0').map((c) => c[0])).toEqual(['pres-1']);
    expect(db.readDoc('chapters', 'khi')!.underConstitutedOfficerCount).toBe(5);
  });

  it('a national vacancy with no audit explanation reports reason unknown, honestly', async () => {
    const db = new FakeDb();
    seedWorld(db);
    await scanVacancies(db, T0);
    const vac = db.readDoc('vacancies', vacancyDocId('national', 'national_treasurer', null));
    expect(vac).toBeUndefined(); // treasurer is seated in the fixture
    const vp = db.readDoc('vacancies', vacancyDocId('national', 'national_vice_president', null))!;
    expect(vp).toBeDefined();
    expect(vp.vacancyReason).toBe('unknown');
    expect(vp.openedAtSource).toBe('first_observation');
  });
});
