/**
 * elections client-supa seam tests (Supabase migration, elections
 * cluster G5).
 *
 * Pins the migration contract for the client data layer:
 * - flag OFF by default; ON only when NEXT_PUBLIC_SUPA_SURFACES lists
 *   the `elections` surface (comma-separated, case-insensitive);
 * - EVERY wrapper issues exactly the request the pages issue today
 *   (URL, method, JSON body, Bearer token + JSON content-type
 *   headers) — in BOTH flag states, because both states go through
 *   the same API routes and the server flips backends behind them;
 * - route errors propagate with the same shape callers handle today
 *   (Error carrying the route's message, .code and .status);
 * - a signed-out user fails before any fetch, exactly as today.
 *
 * No live reads: fetch is mocked throughout.
 */

import {
  ELECTIONS_SUPA_SURFACE,
  addAgmDocument,
  appointTeller,
  castBallot,
  certifyCandidates,
  createAgm,
  createElection,
  declareElection,
  decideNomination,
  electionCountAction,
  electionRollAction,
  electionsClientRequest,
  electionsSupaEnabled,
  fileChallenge,
  getAgm,
  getAgmDocuments,
  getAgmNotice,
  getElection,
  getElectionAudit,
  getElectionCandidates,
  getElectionChallenges,
  getElectionCount,
  getElectionNominations,
  getElectionResult,
  getElectionTurnout,
  getOwnRollEntry,
  isSupaSurfaceEnabled,
  issueAgmNotice,
  listAgms,
  listElections,
  obtainBallotToken,
  patchAgm,
  patchElection,
  recordTieLot,
  ruleOnChallenge,
  submitNomination,
} from "../client-supa";

/* eslint-disable @typescript-eslint/no-explicit-any */

const user = { getIdToken: async () => "test-token" };

const fetchMock = jest.fn();

function mockOk(payload: unknown = {}) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockOk();
  (global as any).fetch = fetchMock;
  delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPA_SURFACES;
});

describe("flag parsing: NEXT_PUBLIC_SUPA_SURFACES", () => {
  it("surface name is 'elections'", () => {
    expect(ELECTIONS_SUPA_SURFACE).toBe("elections");
  });

  it("unset/empty = OFF", () => {
    expect(isSupaSurfaceEnabled("elections", undefined)).toBe(false);
    expect(isSupaSurfaceEnabled("elections", "")).toBe(false);
    expect(electionsSupaEnabled()).toBe(false);
  });

  it("ON only when the list contains elections (case-insensitive, whitespace tolerated)", () => {
    expect(isSupaSurfaceEnabled("elections", "elections")).toBe(true);
    expect(isSupaSurfaceEnabled("elections", "announcements, ELECTIONS ")).toBe(true);
    expect(isSupaSurfaceEnabled("elections", "announcements")).toBe(false);
    expect(isSupaSurfaceEnabled("elections", "elections2")).toBe(false);
  });

  it("electionsSupaEnabled reads the env at call time", () => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = "notifications,elections";
    expect(electionsSupaEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_SUPA_SURFACES = "notifications";
    expect(electionsSupaEnabled()).toBe(false);
  });
});

interface Case {
  name: string;
  run: () => Promise<unknown>;
  url: string;
  method?: string;
  body?: string;
}

const E = "el-1";
const A = "agm-1";

const cases: Case[] = [
  { name: "listElections", run: () => listElections(user), url: "/api/elections" },
  { name: "getElection", run: () => getElection(user, E), url: `/api/elections/${E}` },
  { name: "getElectionCandidates", run: () => getElectionCandidates(user, E), url: `/api/elections/${E}/candidates` },
  { name: "getElectionNominations", run: () => getElectionNominations(user, E), url: `/api/elections/${E}/nominations` },
  { name: "getElectionCount", run: () => getElectionCount(user, E), url: `/api/elections/${E}/count` },
  { name: "getElectionResult", run: () => getElectionResult(user, E), url: `/api/elections/${E}/declare` },
  { name: "getElectionChallenges", run: () => getElectionChallenges(user, E), url: `/api/elections/${E}/challenges` },
  { name: "getElectionAudit", run: () => getElectionAudit(user, E), url: `/api/elections/${E}/audit` },
  { name: "getOwnRollEntry", run: () => getOwnRollEntry(user, E), url: `/api/elections/${E}/roll?self=1` },
  { name: "getElectionTurnout", run: () => getElectionTurnout(user, E), url: `/api/elections/${E}/ballot` },
  {
    name: "createElection",
    run: () => createElection(user, { title: "T", electionDay: 123, returningOfficerUid: "ro", returningOfficerName: "RO", agmId: null }),
    url: "/api/elections",
    method: "POST",
    body: JSON.stringify({ title: "T", electionDay: 123, returningOfficerUid: "ro", returningOfficerName: "RO", agmId: null }),
  },
  {
    name: "patchElection",
    run: () => patchElection(user, E, { action: "open_poll" }),
    url: `/api/elections/${E}`,
    method: "PATCH",
    body: JSON.stringify({ action: "open_poll" }),
  },
  {
    name: "electionRollAction",
    run: () => electionRollAction(user, E, "freeze"),
    url: `/api/elections/${E}/roll`,
    method: "POST",
    body: JSON.stringify({ action: "freeze" }),
  },
  {
    name: "submitNomination",
    run: () => submitNomination(user, E, {
      candidateUid: "c1", candidateName: "Cand", nominatorUids: ["n1", "n2"],
      candidateStatement: "s", consentDriveFileId: "f", consentSha256: "h",
      campaignCodeAccepted: true,
    }),
    url: `/api/elections/${E}/nominations`,
    method: "POST",
    body: JSON.stringify({
      candidateUid: "c1", candidateName: "Cand", nominatorUids: ["n1", "n2"],
      candidateStatement: "s", consentDriveFileId: "f", consentSha256: "h",
      campaignCodeAccepted: true,
    }),
  },
  {
    name: "decideNomination",
    run: () => decideNomination(user, E, "nom-1", { decision: "rejected", reason: "late" }),
    url: `/api/elections/${E}/nominations/nom-1`,
    method: "PATCH",
    body: JSON.stringify({ decision: "rejected", reason: "late" }),
  },
  {
    name: "certifyCandidates",
    run: () => certifyCandidates(user, E),
    url: `/api/elections/${E}/candidates`,
    method: "POST",
    body: JSON.stringify({ action: "certify" }),
  },
  {
    name: "appointTeller",
    run: () => appointTeller(user, E, "t1", "Teller One"),
    url: `/api/elections/${E}/officials`,
    method: "POST",
    body: JSON.stringify({ action: "appoint_teller", uid: "t1", name: "Teller One" }),
  },
  {
    name: "obtainBallotToken",
    run: () => obtainBallotToken(user, E, true),
    url: `/api/elections/${E}/ballot-token`,
    method: "POST",
    body: JSON.stringify({ reissue: true }),
  },
  {
    name: "castBallot",
    run: () => castBallot(user, E, "tok", ["c1", "c2"]),
    url: `/api/elections/${E}/ballot`,
    method: "POST",
    body: JSON.stringify({ token: "tok", choices: ["c1", "c2"] }),
  },
  {
    name: "electionCountAction",
    run: () => electionCountAction(user, E, "sign_off"),
    url: `/api/elections/${E}/count`,
    method: "POST",
    body: JSON.stringify({ action: "sign_off" }),
  },
  {
    name: "declareElection (default empty body)",
    run: () => declareElection(user, E),
    url: `/api/elections/${E}/declare`,
    method: "POST",
    body: "{}",
  },
  {
    name: "declareElection (retry writeback)",
    run: () => declareElection(user, E, { action: "retry_writeback" }),
    url: `/api/elections/${E}/declare`,
    method: "POST",
    body: JSON.stringify({ action: "retry_writeback" }),
  },
  {
    name: "fileChallenge",
    run: () => fileChallenge(user, E, "grounds here"),
    url: `/api/elections/${E}/challenges`,
    method: "POST",
    body: JSON.stringify({ grounds: "grounds here" }),
  },
  {
    name: "ruleOnChallenge",
    run: () => ruleOnChallenge(user, E, "ch-1", { ruling: "r", upheld: false, effectOnResult: "none" }),
    url: `/api/elections/${E}/challenges/ch-1/ruling`,
    method: "POST",
    body: JSON.stringify({ ruling: "r", upheld: false, effectOnResult: "none" }),
  },
  {
    name: "recordTieLot",
    run: () => recordTieLot(user, E, {
      method: "sealed tokens", witnesses: [{ uid: "w1" }],
      outcomeWinningCandidateUid: "c1", drawnAt: 999, evidence: null,
    }),
    url: `/api/elections/${E}/tie-lot`,
    method: "POST",
    body: JSON.stringify({
      method: "sealed tokens", witnesses: [{ uid: "w1" }],
      outcomeWinningCandidateUid: "c1", drawnAt: 999, evidence: null,
    }),
  },
  { name: "listAgms", run: () => listAgms(user), url: "/api/agm" },
  { name: "getAgm", run: () => getAgm(user, A), url: `/api/agm/${A}` },
  { name: "getAgmNotice", run: () => getAgmNotice(user, A), url: `/api/agm/${A}/notice` },
  { name: "getAgmDocuments", run: () => getAgmDocuments(user, A), url: `/api/agm/${A}/documents` },
  {
    name: "createAgm",
    run: () => createAgm(user, { year: 2026, scheduledAt: 456, locationOrLink: "Hall", electionId: null }),
    url: "/api/agm",
    method: "POST",
    body: JSON.stringify({ year: 2026, scheduledAt: 456, locationOrLink: "Hall", electionId: null }),
  },
  {
    name: "patchAgm",
    run: () => patchAgm(user, A, { action: "finalise_agenda" }),
    url: `/api/agm/${A}`,
    method: "PATCH",
    body: JSON.stringify({ action: "finalise_agenda" }),
  },
  {
    name: "issueAgmNotice",
    run: () => issueAgmNotice(user, A),
    url: `/api/agm/${A}/notice`,
    method: "POST",
    body: JSON.stringify({ action: "issue" }),
  },
  {
    name: "addAgmDocument",
    run: () => addAgmDocument(user, A, {
      kind: "audited_accounts", title: "Accounts", driveFileId: "df",
      driveLink: "https://example.test/f", fileName: "Accounts",
      sha256: "ab12", sourceModule: "manual_upload",
    }),
    url: `/api/agm/${A}/documents`,
    method: "POST",
    body: JSON.stringify({
      kind: "audited_accounts", title: "Accounts", driveFileId: "df",
      driveLink: "https://example.test/f", fileName: "Accounts",
      sha256: "ab12", sourceModule: "manual_upload",
    }),
  },
  {
    name: "electionsClientRequest (generic pass-through)",
    run: () => electionsClientRequest(user, "/api/elections/x", { method: "DELETE" }),
    url: "/api/elections/x",
    method: "DELETE",
  },
];

function expectIdenticalRequest(c: Case) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(c.url);
  expect(init.method).toBe(c.method);
  expect(init.body).toBe(c.body);
  expect(init.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer test-token",
  });
}

describe("wrappers issue today's requests — flag OFF (default)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(electionsSupaEnabled()).toBe(false);
    await c.run();
    expectIdenticalRequest(c);
  });
});

describe("wrappers issue the SAME requests through the module — flag ON", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    process.env.NEXT_PUBLIC_SUPA_SURFACES = "announcements, elections";
    expect(electionsSupaEnabled()).toBe(true);
    await c.run();
    expectIdenticalRequest(c);
  });
});

describe("response + error propagation matches today's handling", () => {
  it("resolves with the parsed route payload", async () => {
    mockOk({ elections: [{ id: "x" }] });
    await expect(listElections(user)).resolves.toEqual({ elections: [{ id: "x" }] });
  });

  it("route error rejects with message, code and status from the body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden here", code: "not_ro" }),
    });
    const err = await getElection(user, E).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Forbidden here");
    expect(err.code).toBe("not_ro");
    expect(err.status).toBe(403);
  });

  it("route error without a body message falls back to the status text", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    });
    const err = await listAgms(user).catch((e) => e);
    expect(err.message).toBe("Request failed (503)");
    expect(err.status).toBe(503);
    expect(err.code).toBeUndefined();
  });

  it("signed-out user rejects before any fetch", async () => {
    await expect(listElections(null)).rejects.toThrow("Not signed in.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
