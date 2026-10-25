/**
 * @jest-environment node
 *
 * F5 — DEDICATED ROUTE TESTS for the two G6-swapped GETs and the
 * elections list GET (BUILDOUT_AUDIT §5, flip-blocker F5), in the
 * G4 route-suite pattern (src/app/api/elections/__tests__/routes.test.ts):
 *
 *   GET /api/agm                    flag OFF (Firestore) + flag ON (Supa seam)
 *   GET /api/agm/[agmId]/notice     flag OFF + flag ON
 *                                   (notice present + recipient counts by
 *                                    deliveryStatus; no notice ->
 *                                    { notice: null } with 200 on BOTH flags)
 *   GET /api/elections              flag ON (the third F5 gap; the flag-OFF
 *                                   arm is pinned by the G4 suite)
 *
 * The flag-OFF and flag-ON responses must be identical in shape and
 * content for the same seeded data — the seam must be invisible at
 * the HTTP boundary.
 *
 * All data is mocked; zero live Firestore or Supabase reads.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-f5-routes-0123456789";

const FOUNDER = "founder-uid";
const MEMBER = "member-uid";
const RO = "ro-uid";
const OTHER = "other-uid";

const mockAuthState: { uid: string | null } = { uid: FOUNDER };
const mockRoleState: { role: string | null } = { role: null };
const fakeHolder: { db: unknown } = { db: null };

jest.mock("@/lib/server/firebase-admin", () => ({
  ensureAdminInitialized: () => true,
  getDb: () => fakeHolder.db,
}));

jest.mock("@/lib/auth-middleware", () => ({
  verifyAuthentication: jest.fn(async () =>
    mockAuthState.uid
      ? { authenticated: true, user: { user: { uid: mockAuthState.uid } } }
      : { authenticated: false, user: null, error: "Unauthenticated" },
  ),
}));

jest.mock("@/lib/roles", () => ({
  isFounder: (uid: string) => uid === FOUNDER,
}));

jest.mock("@/lib/server/permissions", () => ({
  resolveCanonicalRole: jest.fn(async () => mockRoleState.role),
}));

import { NextRequest } from "next/server";
import {
  createFakeDb,
  FakeTimestamp,
} from "./helpers/fake-firestore";
import {
  __setAgmSupaAdapterForTests,
  type AgmSupaAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from "../agm-domain-supa";
import {
  registerElectionSupaAdapter,
  resetElectionSupaAdapter,
  type ElectionSupaAdapter as CoreSupaAdapter,
} from "../election-supa";
import { GET as agmListGET } from "@/app/api/agm/route";
import { GET as noticeGET } from "@/app/api/agm/[agmId]/notice/route";
import { GET as electionsListGET } from "@/app/api/elections/route";

/* ------------------------------------------------------------ helpers */

function getReq(url: string) {
  return new NextRequest(url, { method: "GET" });
}

const agmParams = (agmId: string) => ({ params: Promise.resolve({ agmId }) });

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** AGM-seam adapter fake: keyed by full collection path. */
class FakeAgmAdapter implements AgmSupaAdapter {
  readonly store = new Map<string, Map<string, SupaDocData>>();
  private bucket(path: string): Map<string, SupaDocData> {
    let b = this.store.get(path);
    if (!b) {
      b = new Map();
      this.store.set(path, b);
    }
    return b;
  }
  seed(path: string, id: string, data: SupaDocData) {
    this.bucket(path).set(id, jsonClone(data));
  }
  docsAt(path: string): Map<string, SupaDocData> {
    return this.store.get(path) ?? new Map();
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

/** G1 core-seam adapter fake: keyed by collection + id. */
class FakeCoreAdapter implements CoreSupaAdapter {
  readonly store = new Map<string, Record<string, unknown>>();
  private key(collection: string, id: string) {
    return `${collection}/${id}`;
  }
  seed(collection: string, id: string, data: Record<string, unknown>) {
    this.store.set(this.key(collection, id), jsonClone(data));
  }
  async getDoc(collection: string, id: string) {
    const data = this.store.get(this.key(collection, id));
    return data ? { id, ...jsonClone(data) } : null;
  }
  async listDocs(collection: string) {
    const prefix = `${collection}/`;
    const out: Array<Record<string, unknown>> = [];
    for (const [k, data] of this.store.entries()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({ id: rest, ...jsonClone(data) });
    }
    return out;
  }
  async countDocs(collection: string, where?: Array<[string, string, unknown]>) {
    const docs = await this.listDocs(collection);
    return docs.filter((d) => (where ?? []).every(([f, , v]) => d[f] === v)).length;
  }
  async setDoc(collection: string, id: string, data: Record<string, unknown>) {
    this.store.set(this.key(collection, id), jsonClone(data));
    return { id, ...jsonClone(data) };
  }
  async updateDoc(collection: string, id: string, data: Record<string, unknown>) {
    const existing = this.store.get(this.key(collection, id));
    if (!existing) throw new Error(`fake core: updateDoc missing ${collection}/${id}`);
    const next = { ...existing, ...jsonClone(data) };
    this.store.set(this.key(collection, id), next);
    return { id, ...next };
  }
  async deleteDoc(collection: string, id: string) {
    this.store.delete(this.key(collection, id));
  }
}

/* ------------------------------------------------------- seed fixtures */

const AGM_DAY = Date.UTC(2026, 11, 31);
const T_ISSUE = Date.UTC(2026, 11, 10);

const AGM_SEEDS: Array<{ id: string; year: number }> = [
  { id: "agm-2024", year: 2024 },
  { id: "agm-2026", year: 2026 },
  { id: "agm-2025", year: 2025 },
];

async function seedAgmsFirestore(db: ReturnType<typeof createFakeDb>) {
  for (const s of AGM_SEEDS) {
    await db.collection("agm_events").doc(s.id).set({
      year: s.year,
      title: `AGM ${s.year}`,
      status: "notice_due",
      scheduledAt: FakeTimestamp.fromMillis(AGM_DAY),
    });
  }
}

function seedAgmsSupa(adapter: FakeAgmAdapter) {
  for (const s of AGM_SEEDS) {
    adapter.seed("agm_events", s.id, {
      year: s.year,
      title: `AGM ${s.year}`,
      status: "notice_due",
      scheduledAt: new Date(AGM_DAY).toISOString(),
    });
  }
}

interface RecipientSeed {
  uid: string;
  inApp: string | null; // null => no deliveryStatus at all ("unknown")
}

const RECIPIENT_SEEDS: RecipientSeed[] = [
  { uid: "u1", inApp: "created" },
  { uid: "u2", inApp: "created" },
  { uid: "u3", inApp: "failed" },
  { uid: "u4", inApp: null },
];

const EXPECTED_COUNTS = { created: 2, failed: 1, unknown: 1 };

function noticeDataFs(): Record<string, unknown> {
  return {
    agmId: "agm1",
    issuedByUid: FOUNDER,
    issuedAt: FakeTimestamp.fromMillis(T_ISSUE),
    agendaSnapshot: [],
    documentIds: [],
  };
}

function noticeDataSupa(): SupaDocData {
  return {
    agmId: "agm1",
    issuedByUid: FOUNDER,
    issuedAt: new Date(T_ISSUE).toISOString(),
    agendaSnapshot: [],
    documentIds: [],
  };
}

function recipientData(r: RecipientSeed): Record<string, unknown> {
  const data: Record<string, unknown> = {
    uid: r.uid,
    displayName: `Member ${r.uid}`,
    inAppNotificationId: `notif-${r.uid}`,
  };
  if (r.inApp !== null) {
    data.deliveryStatus = { inApp: r.inApp, email: "sent", push: "skipped" };
  }
  return data;
}

async function seedNoticeFirestore(db: ReturnType<typeof createFakeDb>) {
  const notices = db.collection("agm_events").doc("agm1").collection("notices");
  await notices.doc("n1").set(noticeDataFs());
  for (const r of RECIPIENT_SEEDS) {
    await notices.doc("n1").collection("recipients").doc(r.uid).set(recipientData(r));
  }
}

function seedNoticeSupa(adapter: FakeAgmAdapter) {
  adapter.seed("agm_events/agm1/notices", "n1", noticeDataSupa());
  for (const r of RECIPIENT_SEEDS) {
    adapter.seed(
      "agm_events/agm1/notices/n1/recipients",
      r.uid,
      recipientData(r) as SupaDocData,
    );
  }
}

/* ------------------------------------------------------------------ */

beforeEach(() => {
  fakeHolder.db = createFakeDb();
  mockAuthState.uid = FOUNDER;
  mockRoleState.role = null;
  delete process.env.SUPA_SURFACES;
  __setAgmSupaAdapterForTests(null);
  registerElectionSupaAdapter(null);
});

afterEach(() => {
  __setAgmSupaAdapterForTests(undefined);
  resetElectionSupaAdapter();
  delete process.env.SUPA_SURFACES;
});

describe("F5 GET /api/agm — listAgms at the HTTP boundary", () => {
  it("flag OFF: served from Firestore, year-desc, { agms: [{ id, ...data }] } shape", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedAgmsFirestore(db);

    const res = await agmListGET(getReq("http://x/api/agm"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["agms"]);
    expect(body.agms.map((a: { id: string }) => a.id)).toEqual([
      "agm-2026",
      "agm-2025",
      "agm-2024",
    ]);
    expect(body.agms.map((a: { year: number }) => a.year)).toEqual([2026, 2025, 2024]);
    expect(body.agms[0].title).toBe("AGM 2026");
    expect(body.agms[0].status).toBe("notice_due");
  });

  it("flag ON: served from the Supa seam with an IDENTICAL response to flag OFF", async () => {
    // Flag OFF arm, same seed data.
    const offDb = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedAgmsFirestore(offDb);
    const offRes = await agmListGET(getReq("http://x/api/agm"));
    const offBody = await offRes.json();

    // Flag ON arm: fresh Firestore (must stay untouched) + Supa seed.
    fakeHolder.db = createFakeDb();
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeAgmAdapter();
    seedAgmsSupa(adapter);
    __setAgmSupaAdapterForTests(adapter);

    const onRes = await agmListGET(getReq("http://x/api/agm"));
    expect(onRes.status).toBe(200);
    const onBody = await onRes.json();
    expect(onBody).toEqual(offBody);
    expect(onBody.agms.map((a: { id: string }) => a.id)).toEqual([
      "agm-2026",
      "agm-2025",
      "agm-2024",
    ]);

    const fsSnap = await (fakeHolder.db as ReturnType<typeof createFakeDb>)
      .collection("agm_events")
      .get();
    expect(fsSnap.size).toBe(0);
  });
});

describe("F5 GET /api/agm/[agmId]/notice — getNoticeDelivery at the HTTP boundary", () => {
  it("flag OFF: notice present + recipient counts by deliveryStatus (privileged caller sees recipients)", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedNoticeFirestore(db);
    mockAuthState.uid = FOUNDER; // privileged: recipients exposed

    const res = await noticeGET(getReq("http://x/api/agm/agm1/notice"), agmParams("agm1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notice.id).toBe("n1");
    expect(body.notice.agmId).toBe("agm1");
    expect(body.deliveryCounts).toEqual(EXPECTED_COUNTS);
    expect(body.recipients).toHaveLength(RECIPIENT_SEEDS.length);
    expect(
      body.recipients.map((r: { id: string }) => r.id).sort(),
    ).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("flag ON: served from the Supa seam with an IDENTICAL response to flag OFF; Firestore untouched", async () => {
    const offDb = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedNoticeFirestore(offDb);
    mockAuthState.uid = FOUNDER;
    const offRes = await noticeGET(getReq("http://x/api/agm/agm1/notice"), agmParams("agm1"));
    const offBody = await offRes.json();

    fakeHolder.db = createFakeDb();
    process.env.SUPA_SURFACES = "elections";
    const adapter = new FakeAgmAdapter();
    seedNoticeSupa(adapter);
    __setAgmSupaAdapterForTests(adapter);

    const onRes = await noticeGET(getReq("http://x/api/agm/agm1/notice"), agmParams("agm1"));
    expect(onRes.status).toBe(200);
    const onBody = await onRes.json();
    expect(onBody).toEqual(offBody);
    expect(onBody.deliveryCounts).toEqual(EXPECTED_COUNTS);
    expect(onBody.recipients).toHaveLength(RECIPIENT_SEEDS.length);

    const fsNotices = await (fakeHolder.db as ReturnType<typeof createFakeDb>)
      .collection("agm_events")
      .doc("agm1")
      .collection("notices")
      .get();
    expect(fsNotices.size).toBe(0);
  });

  it("flag OFF: non-privileged caller gets counts but recipients are withheld", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedNoticeFirestore(db);
    mockAuthState.uid = MEMBER;
    mockRoleState.role = null;

    const res = await noticeGET(getReq("http://x/api/agm/agm1/notice"), agmParams("agm1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notice.id).toBe("n1");
    expect(body.deliveryCounts).toEqual(EXPECTED_COUNTS);
    expect(body.recipients).toBeUndefined();
  });

  it("no notice -> { notice: null } with 200 on BOTH flags (even for a missing AGM)", async () => {
    // Flag OFF: nothing seeded anywhere.
    mockAuthState.uid = FOUNDER;
    const offRes = await noticeGET(
      getReq("http://x/api/agm/ghost/notice"),
      agmParams("ghost"),
    );
    expect(offRes.status).toBe(200);
    expect(await offRes.json()).toEqual({ notice: null });

    // Flag ON: empty Supa store, empty Firestore.
    process.env.SUPA_SURFACES = "elections";
    __setAgmSupaAdapterForTests(new FakeAgmAdapter());
    const onRes = await noticeGET(
      getReq("http://x/api/agm/ghost/notice"),
      agmParams("ghost"),
    );
    expect(onRes.status).toBe(200);
    expect(await onRes.json()).toEqual({ notice: null });
  });
});

describe("F5 GET /api/elections — flag ON list through the G1 core seam", () => {
  it("flag ON: published elections served from Supa; drafts hidden from a plain member; summary projection only", async () => {
    process.env.SUPA_SURFACES = "elections";
    const core = new FakeCoreAdapter();
    core.seed("elections", "e1", {
      title: "Board Election 2026",
      kind: "board",
      seatCategory: "governor",
      seats: 3,
      status: "poll_open",
      returningOfficerUid: RO,
      returningOfficerName: "R. Officer",
      timetable: {},
      agmId: null,
      // Fields the summary projection must NOT leak:
      voterRoll: { status: "frozen", rollSize: 42 },
      counters: { ballotsCast: 9, markersCast: 9, tokensRedeemed: 9 },
    });
    core.seed("elections", "e2", {
      title: "Draft Election",
      kind: "board",
      seatCategory: "governor",
      seats: 1,
      status: "draft",
      returningOfficerUid: OTHER,
      returningOfficerName: "Someone Else",
      timetable: {},
      agmId: "agm1",
    });
    registerElectionSupaAdapter(core as unknown as CoreSupaAdapter);

    mockAuthState.uid = MEMBER;
    mockRoleState.role = null;
    const res = await electionsListGET(getReq("http://x/api/elections"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.elections).toHaveLength(1);
    const only = body.elections[0];
    expect(only.id).toBe("e1");
    expect(only.title).toBe("Board Election 2026");
    expect(only.status).toBe("poll_open");
    expect(only.agmId).toBeNull();
    expect(Object.keys(only).sort()).toEqual(
      [
        "agmId",
        "id",
        "kind",
        "returningOfficerName",
        "seatCategory",
        "seats",
        "status",
        "timetable",
        "title",
      ].sort(),
    );

    // Firestore stayed empty: the list really came from the seam.
    const fsSnap = await (fakeHolder.db as ReturnType<typeof createFakeDb>)
      .collection("elections")
      .get();
    expect(fsSnap.size).toBe(0);
  });
});
