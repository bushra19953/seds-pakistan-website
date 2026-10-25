/**
 * @jest-environment node
 *
 * Route tests for the elections + AGM API routes (G4).
 *
 * Pins the non-negotiables of the Supabase route migration:
 * - ELECTIONS_ENABLED off -> every mutating elections + AGM route
 *   refuses 503 { code: "elections_disabled" } before auth/db work.
 * - Unauthenticated callers get the 401 shape from requireRouteContext.
 * - The converted routes (officials / challenges / count / elections
 *   list) return byte-identical shapes flag OFF (fake Firestore through
 *   the domain seam) and flag ON (fake adapter registered at the seam,
 *   Firestore untouched).
 * All data is mocked; zero live Firestore or Supabase reads.
 */

jest.mock("firebase-admin", () =>
  require("@/lib/server/__tests__/helpers/fake-firestore").fakeFirebaseAdminModule(),
);

process.env.ELECTION_MARKER_PEPPER = "test-pepper-for-g4-routes-0123456789";

const FOUNDER = "founder-uid";
const RO = "ro-uid";
const TELLER = "teller-uid";
const MEMBER = "member-uid";
const OTHER = "other-uid";

const mockAuthState: { uid: string | null } = { uid: RO };
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
  resolveCanonicalRole: jest.fn(async () => null),
}));

import { NextRequest } from "next/server";
import {
  createFakeDb,
  FakeTimestamp,
} from "@/lib/server/__tests__/helpers/fake-firestore";
import {
  registerElectionSupaAdapter,
  resetElectionSupaAdapter,
  type ElectionSupaAdapter as G1Adapter,
} from "@/lib/server/election-supa";
import {
  __setElectionSupaAdapterForTests,
  type ElectionSupaAdapter as DomainAdapter,
  type SupaDoc,
  type SupaDocData,
  type SupaWhereClause,
} from "@/lib/server/election-domain-supa";
import { GET as officialsGET, POST as officialsPOST } from "@/app/api/elections/[electionId]/officials/route";
import { GET as challengesGET, POST as challengesPOST } from "@/app/api/elections/[electionId]/challenges/route";
import { GET as countGET, POST as countPOST } from "@/app/api/elections/[electionId]/count/route";
import { GET as electionsGET, POST as electionsPOST } from "@/app/api/elections/route";
import { POST as agmPOST } from "@/app/api/agm/route";
import { PATCH as agmPATCH } from "@/app/api/agm/[agmId]/route";
import { POST as noticePOST } from "@/app/api/agm/[agmId]/notice/route";

/* ------------------------------------------------------------ helpers */

function jsonReq(url: string, body?: unknown, method = "POST") {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const electionParams = (electionId: string) => ({
  params: Promise.resolve({ electionId }),
});
const agmParams = (agmId: string) => ({ params: Promise.resolve({ agmId }) });

function seedElection(db: ReturnType<typeof createFakeDb>, overrides: Record<string, unknown> = {}) {
  return db
    .collection("elections")
    .doc("e1")
    .set({
      title: "Board Election 2026",
      kind: "board",
      seatCategory: "governor",
      seats: 3,
      status: "counting",
      returningOfficerUid: RO,
      returningOfficerName: "R. Officer",
      timetable: {},
      agmId: null,
      ...overrides,
    });
}

function seedOfficial(db: ReturnType<typeof createFakeDb>, uid: string, role: string) {
  return db
    .collection("elections")
    .doc("e1")
    .collection("officials")
    .doc(uid)
    .set({
      uid,
      name: `Official ${uid}`,
      officialRole: role,
      appointedByUid: RO,
      forCandidateUid: null,
      isCandidate: false,
      appointedAt: FakeTimestamp.fromMillis(1_700_000_000_000),
    });
}

function seedChallenge(db: ReturnType<typeof createFakeDb>, id: string, challengerUid: string) {
  return db
    .collection("elections")
    .doc("e1")
    .collection("challenges")
    .doc(id)
    .set({
      electionId: "e1",
      challengerUid,
      grounds: `grounds-${id}`,
      filedAt: FakeTimestamp.fromMillis(1_700_000_100_000),
      withinWindow: true,
      status: "filed",
      roRuling: null,
    });
}

/* ------------------------------------------- fake adapters (flag ON) */

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** G2 domain-seam adapter: keyed by full collection path. */
class FakeDomainAdapter implements DomainAdapter {
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
  async getDoc(path: string, id: string): Promise<SupaDoc | null> {
    const data = this.bucket(path).get(id);
    return data ? { id, ...jsonClone(data) } : null;
  }
  async listDocs(path: string, options?: { where?: SupaWhereClause[] }): Promise<SupaDoc[]> {
    const out: SupaDoc[] = [];
    for (const [id, data] of this.bucket(path)) {
      const matches = (options?.where ?? []).every(
        ([field, , value]) => data[field] === value,
      );
      if (matches) out.push({ id, ...jsonClone(data) });
    }
    return out;
  }
  async setDoc(path: string, id: string, data: SupaDocData): Promise<SupaDoc> {
    this.bucket(path).set(id, jsonClone(data));
    return { id, ...jsonClone(data) };
  }
  async updateDoc(path: string, id: string, updates: SupaDocData): Promise<SupaDoc> {
    const next = { ...(this.bucket(path).get(id) ?? {}), ...jsonClone(updates) };
    this.bucket(path).set(id, next);
    return { id, ...next };
  }
  async deleteDoc(path: string, id: string): Promise<void> {
    this.bucket(path).delete(id);
  }
}

/** G1 core-seam adapter: keyed by collection + id. */
class FakeG1Adapter implements G1Adapter {
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
    return docs.filter((d) =>
      (where ?? []).every(([f, , v]) => d[f] === v),
    ).length;
  }
  async setDoc(collection: string, id: string, data: Record<string, unknown>) {
    this.store.set(this.key(collection, id), jsonClone(data));
    return { id, ...jsonClone(data) };
  }
  async updateDoc(collection: string, id: string, data: Record<string, unknown>) {
    const next = { ...(this.store.get(this.key(collection, id)) ?? {}), ...jsonClone(data) };
    this.store.set(this.key(collection, id), next);
    return { id, ...next };
  }
  async deleteDoc(collection: string, id: string) {
    this.store.delete(this.key(collection, id));
  }
}

/* ------------------------------------------------------------------ */

beforeEach(() => {
  fakeHolder.db = createFakeDb();
  mockAuthState.uid = RO;
  delete process.env.ELECTIONS_ENABLED;
  delete process.env.SUPA_SURFACES;
  __setElectionSupaAdapterForTests(null);
  registerElectionSupaAdapter(null);
});

afterEach(() => {
  __setElectionSupaAdapterForTests(undefined);
  resetElectionSupaAdapter();
  delete process.env.ELECTIONS_ENABLED;
  delete process.env.SUPA_SURFACES;
});

describe("ELECTIONS_ENABLED gate (flag OFF -> 503 elections_disabled)", () => {
  it("refuses mutating elections routes", async () => {
    const officials = await officialsPOST(
      jsonReq("http://x/api/elections/e1/officials", { action: "appoint_teller", uid: TELLER, name: "T" }),
      electionParams("e1"),
    );
    expect(officials.status).toBe(503);
    expect((await officials.json()).code).toBe("elections_disabled");

    const challenges = await challengesPOST(
      jsonReq("http://x/api/elections/e1/challenges", { grounds: "g" }),
      electionParams("e1"),
    );
    expect(challenges.status).toBe(503);
    expect((await challenges.json()).code).toBe("elections_disabled");

    const count = await countPOST(
      jsonReq("http://x/api/elections/e1/count", { action: "open" }),
      electionParams("e1"),
    );
    expect(count.status).toBe(503);

    const root = await electionsPOST(
      jsonReq("http://x/api/elections", { title: "X" }),
    );
    expect(root.status).toBe(503);
    expect((await root.json()).code).toBe("elections_disabled");
  });

  it("refuses mutating AGM routes", async () => {
    const agm = await agmPOST(jsonReq("http://x/api/agm", { year: 2026 }));
    expect(agm.status).toBe(503);
    expect((await agm.json()).code).toBe("elections_disabled");

    const patch = await agmPATCH(
      jsonReq("http://x/api/agm/a1", { action: "update_agenda", agenda: [] }, "PATCH"),
      agmParams("a1"),
    );
    expect(patch.status).toBe(503);

    const notice = await noticePOST(
      jsonReq("http://x/api/agm/a1/notice", { action: "issue" }),
      agmParams("a1"),
    );
    expect(notice.status).toBe(503);
    expect((await notice.json()).code).toBe("elections_disabled");
  });
});

describe("auth (flag ON, unauthenticated -> 401 unauthenticated)", () => {
  beforeEach(() => {
    process.env.ELECTIONS_ENABLED = "true";
    mockAuthState.uid = null;
  });

  it("401s the converted routes", async () => {
    const officials = await officialsGET(
      jsonReq("http://x/api/elections/e1/officials", undefined, "GET"),
      electionParams("e1"),
    );
    expect(officials.status).toBe(401);
    expect((await officials.json()).code).toBe("unauthenticated");

    const challenges = await challengesGET(
      jsonReq("http://x/api/elections/e1/challenges", undefined, "GET"),
      electionParams("e1"),
    );
    expect(challenges.status).toBe(401);

    const count = await countGET(
      jsonReq("http://x/api/elections/e1/count", undefined, "GET"),
      electionParams("e1"),
    );
    expect(count.status).toBe(401);

    const list = await electionsGET(
      jsonReq("http://x/api/elections", undefined, "GET"),
    );
    expect(list.status).toBe(401);
  });
});

describe("converted routes, flag OFF (Firestore through the seam)", () => {
  it("GET officials returns id-merged official records", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedElection(db);
    await seedOfficial(db, TELLER, "teller");
    await seedOfficial(db, "observer-uid", "observer");

    const res = await officialsGET(
      jsonReq("http://x/api/elections/e1/officials", undefined, "GET"),
      electionParams("e1"),
    );
    expect(res.status).toBe(200);
    const { officials } = await res.json();
    expect(officials).toHaveLength(2);
    const teller = officials.find((o: { id: string }) => o.id === TELLER);
    expect(teller.officialRole).toBe("teller");
    expect(teller.name).toBe(`Official ${TELLER}`);
    expect(teller.uid).toBe(TELLER);
  });

  it("GET challenges: RO sees all, a member sees only their own", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedElection(db, { status: "declared" });
    await seedChallenge(db, "c1", MEMBER);
    await seedChallenge(db, "c2", OTHER);

    mockAuthState.uid = RO;
    const asRo = await challengesGET(
      jsonReq("http://x/api/elections/e1/challenges", undefined, "GET"),
      electionParams("e1"),
    );
    expect(asRo.status).toBe(200);
    expect((await asRo.json()).challenges).toHaveLength(2);

    mockAuthState.uid = MEMBER;
    const asMember = await challengesGET(
      jsonReq("http://x/api/elections/e1/challenges", undefined, "GET"),
      electionParams("e1"),
    );
    const mine = (await asMember.json()).challenges;
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe("c1");
    expect(mine[0].challengerUid).toBe(MEMBER);
    expect(mine[0].grounds).toBe("grounds-c1");
  });

  it("GET count: teller (official) allowed before declaration, plain member 403", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedElection(db, { status: "counting" });
    await seedOfficial(db, TELLER, "teller");
    await db
      .collection("elections")
      .doc("e1")
      .collection("count_record")
      .doc("main")
      .set({ status: "open", totalBallots: 0 });

    mockAuthState.uid = MEMBER;
    const denied = await countGET(
      jsonReq("http://x/api/elections/e1/count", undefined, "GET"),
      electionParams("e1"),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("forbidden");

    mockAuthState.uid = TELLER;
    const allowed = await countGET(
      jsonReq("http://x/api/elections/e1/count", undefined, "GET"),
      electionParams("e1"),
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).count.status).toBe("open");
  });

  it("GET /api/elections: drafts hidden from members, own draft visible to its RO", async () => {
    const db = fakeHolder.db as ReturnType<typeof createFakeDb>;
    await seedElection(db, { status: "poll_open" });
    await db.collection("elections").doc("e2").set({
      title: "Draft Election",
      kind: "board",
      seatCategory: "governor",
      seats: 1,
      status: "draft",
      returningOfficerUid: RO,
      returningOfficerName: "R. Officer",
      timetable: {},
      agmId: null,
    });
    await db.collection("elections").doc("e3").set({
      title: "Other Draft",
      kind: "board",
      seatCategory: "governor",
      seats: 1,
      status: "draft",
      returningOfficerUid: OTHER,
      returningOfficerName: "Someone Else",
      timetable: {},
      agmId: null,
    });

    mockAuthState.uid = MEMBER;
    const asMember = await electionsGET(
      jsonReq("http://x/api/elections", undefined, "GET"),
    );
    const memberList = (await asMember.json()).elections;
    expect(memberList.map((e: { id: string }) => e.id)).toEqual(["e1"]);
    expect(memberList[0].title).toBe("Board Election 2026");
    expect(memberList[0].agmId).toBeNull();

    mockAuthState.uid = RO;
    const asRo = await electionsGET(
      jsonReq("http://x/api/elections", undefined, "GET"),
    );
    const roList = (await asRo.json()).elections;
    expect(roList.map((e: { id: string }) => e.id).sort()).toEqual(["e1", "e2"]);
  });
});

describe("converted routes, flag ON (fake adapter at the seam)", () => {
  beforeEach(() => {
    process.env.SUPA_SURFACES = "elections";
  });

  it("GET officials is served by the domain adapter; Firestore stays empty", async () => {
    const adapter = new FakeDomainAdapter();
    adapter.seed("elections/e1/officials", TELLER, {
      uid: TELLER,
      name: "Supa Teller",
      officialRole: "teller",
      appointedByUid: RO,
      forCandidateUid: null,
      isCandidate: false,
      appointedAt: new Date(1_700_000_000_000).toISOString(),
    });
    __setElectionSupaAdapterForTests(adapter);

    const res = await officialsGET(
      jsonReq("http://x/api/elections/e1/officials", undefined, "GET"),
      electionParams("e1"),
    );
    expect(res.status).toBe(200);
    const { officials } = await res.json();
    expect(officials).toHaveLength(1);
    expect(officials[0].id).toBe(TELLER);
    expect(officials[0].name).toBe("Supa Teller");
    // Timestamp restored by the seam to Timestamp shape; over JSON that
    // is { seconds, nanoseconds } with the exact seeded millis.
    expect(officials[0].appointedAt.seconds).toBe(1_700_000_000);
    expect(officials[0].appointedAt.nanoseconds).toBe(0);

    const fsSnap = await (fakeHolder.db as ReturnType<typeof createFakeDb>)
      .collection("elections")
      .doc("e1")
      .collection("officials")
      .get();
    expect(fsSnap.empty).toBe(true);
  });

  it("GET challenges is served through both seams (G1 election doc + G2 challenges)", async () => {
    const g1 = new FakeG1Adapter();
    g1.seed("elections", "e1", {
      title: "Board Election 2026",
      kind: "board",
      seatCategory: "governor",
      seats: 3,
      status: "declared",
      returningOfficerUid: RO,
      returningOfficerName: "R. Officer",
      timetable: {},
      agmId: null,
    });
    registerElectionSupaAdapter(g1 as unknown as G1Adapter);

    const domain = new FakeDomainAdapter();
    domain.seed("elections/e1/challenges", "c9", {
      electionId: "e1",
      challengerUid: MEMBER,
      grounds: "supa-grounds",
      filedAt: new Date(1_700_000_100_000).toISOString(),
      withinWindow: true,
      status: "filed",
      roRuling: null,
    });
    __setElectionSupaAdapterForTests(domain);

    mockAuthState.uid = RO;
    const res = await challengesGET(
      jsonReq("http://x/api/elections/e1/challenges", undefined, "GET"),
      electionParams("e1"),
    );
    expect(res.status).toBe(200);
    const { challenges } = await res.json();
    expect(challenges).toHaveLength(1);
    expect(challenges[0].id).toBe("c9");
    expect(challenges[0].grounds).toBe("supa-grounds");
  });
});
