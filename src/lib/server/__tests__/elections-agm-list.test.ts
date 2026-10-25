/**
 * @jest-environment node
 *
 * F4 — listAgms year-less records (BUILDOUT_AUDIT §5, flip-blocker F4).
 *
 * Firestore `orderBy("year", "desc")` EXCLUDES documents that have
 * no `year` field at all (an orderBy is also an existence filter).
 * The original Supa path of listAgms included such records, sorted
 * as year 0. This suite pins the corrected Supa semantics:
 * year-less records are excluded, and the rest are returned
 * year-descending, shaped exactly as the Firestore arm shapes them.
 *
 * The Firestore arm is unchanged and is covered by the existing
 * suites; a light flag-OFF control is included here only to show
 * the two arms agree on the records that carry a year.
 *
 * Zero live reads: fake Firestore + in-memory fake adapter only.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

import { createFakeDb, setFakeNow } from "./helpers/fake-firestore";
import { listAgms } from "../agm";
import {
  __setAgmSupaAdapterForTests,
  agmSupaEnabled,
  type AgmSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from "../agm-domain-supa";

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeSupaAdapter implements AgmSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();

  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }

  seed(path: string, id: string, data: SupaDocData): void {
    this.bucket(path).set(id, jsonClone(data));
  }

  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }

  async listDocs(
    path: string,
    options?: { where?: SupaWhereClause[] },
  ): Promise<SupaDoc[]> {
    const out: SupaDoc[] = [];
    for (const [id, data] of this.bucket(path)) {
      const matches = (options?.where ?? []).every(
        ([field, , value]) => data[field] === value,
      );
      if (matches) out.push({ id, ...jsonClone(data) });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  }

  async setDoc(path: string, id: string, data: SupaDocData): Promise<SupaDoc> {
    this.bucket(path).set(id, jsonClone(data));
    return { id, ...jsonClone(data) };
  }

  async updateDoc(
    path: string,
    id: string,
    updates: SupaDocData,
  ): Promise<SupaDoc> {
    const existing = this.bucket(path).get(id);
    if (!existing) throw new Error(`fake supa: updateDoc missing ${path}/${id}`);
    const next = { ...existing, ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    return { id, ...next };
  }

  async deleteDoc(path: string, id: string): Promise<void> {
    this.bucket(path).delete(id);
  }
}

const T_CREATE = Date.UTC(2026, 10, 15);

function agmRow(year: number | undefined, title: string): SupaDocData {
  const row: SupaDocData = {
    title,
    status: "notice_due",
    scheduledAt: new Date(Date.UTC(2026, 11, 31)).toISOString(),
    createdAt: new Date(T_CREATE).toISOString(),
  };
  if (year !== undefined) row.year = year;
  return row;
}

describe("F4 listAgms: year-less records", () => {
  const savedSurfaces = process.env.SUPA_SURFACES;

  afterEach(() => {
    __setAgmSupaAdapterForTests(undefined);
    if (savedSurfaces === undefined) delete process.env.SUPA_SURFACES;
    else process.env.SUPA_SURFACES = savedSurfaces;
  });

  it("flag ON (Supa): a record with no `year` field is EXCLUDED; the rest sort year-desc", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);
    expect(agmSupaEnabled()).toBe(true);

    // Seeded out of order on purpose; the bridge returns id order,
    // so the year-desc order must come from listAgms itself.
    adapter.seed("agm_events", "agm-2024", agmRow(2024, "AGM 2024"));
    adapter.seed("agm_events", "agm-noyear", agmRow(undefined, "Malformed AGM (no year)"));
    adapter.seed("agm_events", "agm-2026", agmRow(2026, "AGM 2026"));
    adapter.seed("agm_events", "agm-2025", agmRow(2025, "AGM 2025"));

    const db = createFakeDb();
    setFakeNow(T_CREATE);
    const agms = await listAgms(db);

    expect(agms.map((a) => a.id)).toEqual(["agm-2026", "agm-2025", "agm-2024"]);
    expect(agms.map((a) => a.year)).toEqual([2026, 2025, 2024]);
    expect(agms.some((a) => a.id === "agm-noyear")).toBe(false);
    // Shape control: the surviving records carry their fields through.
    expect(agms[0].title).toBe("AGM 2026");

    // Nothing was read from (or written to) the Firestore side.
    const fsSnap = await db.collection("agm_events").get();
    expect(fsSnap.size).toBe(0);
  });

  it("flag ON (Supa): when EVERY record lacks `year`, the list is empty (not year-0 sorted)", async () => {
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeSupaAdapter();
    __setAgmSupaAdapterForTests(adapter);

    adapter.seed("agm_events", "agm-noyear", agmRow(undefined, "Malformed AGM (no year)"));

    const db = createFakeDb();
    setFakeNow(T_CREATE);
    await expect(listAgms(db)).resolves.toEqual([]);
  });

  it("flag OFF control: Firestore records with a year list year-desc, agreeing with the Supa arm", async () => {
    delete process.env.SUPA_SURFACES;
    __setAgmSupaAdapterForTests(new FakeSupaAdapter());
    expect(agmSupaEnabled()).toBe(false);

    const db = createFakeDb();
    setFakeNow(T_CREATE);
    await db.collection("agm_events").doc("agm-2024").set({
      year: 2024,
      title: "AGM 2024",
      status: "notice_due",
    });
    await db.collection("agm_events").doc("agm-2026").set({
      year: 2026,
      title: "AGM 2026",
      status: "notice_due",
    });
    await db.collection("agm_events").doc("agm-2025").set({
      year: 2025,
      title: "AGM 2025",
      status: "notice_due",
    });

    const agms = await listAgms(db);
    expect(agms.map((a) => a.id)).toEqual(["agm-2026", "agm-2025", "agm-2024"]);
    expect(agms.map((a) => a.year)).toEqual([2026, 2025, 2024]);
  });
});
