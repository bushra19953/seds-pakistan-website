import {
  InMemoryCircularStore,
  autoCloseCircular,
  circulateCircular,
  createCircularDraft,
  signCircular,
  type CircularDeps,
} from "../circular";
import { InMemoryConsentsClient, type ConsentView } from "../consents-client";
import {
  InMemoryDecisionClassesReader,
  localMatrixDecisionClassesReader,
  type ServerDecisionClassView,
} from "../decision-classes";
import { InMemoryDecisionsClient } from "../decisions-client";
import {
  GovernanceServiceError,
  InMemoryBodyReader,
  InMemoryFilingTaskCreator,
  type BodyView,
} from "../shared";

const T0 = new Date("2026-10-21T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const GOVERNORS_9 = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];

const boardBody: BodyView = {
  id: "board_body",
  name: "Board of Governors",
  type: "board",
  chairUid: "g1",
  secretaryUid: "ngs_1",
  memberUids: [...GOVERNORS_9],
  quorumOverride: null,
  chapterId: null,
};

const consent = (over: Partial<ConsentView> = {}): ConsentView => ({
  id: "consent_1",
  status: "granted",
  matter: "Budget",
  proposedAct: "Approve budget by circular",
  decidedAt: T0,
  decidedBy: "founder",
  meetingId: null,
  ...over,
});

function makeDeps(over: Partial<CircularDeps> = {}): CircularDeps {
  const store = new InMemoryCircularStore();
  return {
    store,
    consents: new InMemoryConsentsClient([consent()]),
    classes: localMatrixDecisionClassesReader(),
    decisions: new InMemoryDecisionsClient(),
    filingTasks: new InMemoryFilingTaskCreator(),
    bodies: new InMemoryBodyReader([boardBody]),
    newId: () => store.nextId(),
    ...over,
  };
}

async function circulatingDraft(deps: CircularDeps, decisionClassId = "class_board_ordinary") {
  const { resolution } = await createCircularDraft(deps, {
    bodyId: "board_body",
    title: "Budget",
    text: "The Board resolves to approve the budget.",
    decisionClassId,
    consentId: "consent_1",
    createdBy: "g1",
    at: T0,
  });
  const circ = await circulateCircular(deps, {
    resolutionId: resolution.id,
    actorUid: "g1",
    isFounder: false,
    at: T0,
  });
  return circ.resolution;
}

describe("circular draft + circulate gates (ws-a §4.7, test case 16)", () => {
  it("a draft without a consent is created with a warning", async () => {
    const deps = makeDeps();
    const { warnings } = await createCircularDraft(deps, {
      bodyId: "board_body",
      title: "T",
      text: "X",
      decisionClassId: "class_board_ordinary",
      createdBy: "g1",
      at: T0,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/No Consent attached/);
  });

  it("circulars are Board-only in v1", async () => {
    const deps = makeDeps({
      bodies: new InMemoryBodyReader([{ ...boardBody, id: "nec_body", type: "nec" }]),
    });
    await expect(
      createCircularDraft(deps, {
        bodyId: "nec_body",
        title: "T",
        text: "X",
        decisionClassId: "class_board_ordinary",
        consentId: "consent_1",
        createdBy: "g1",
        at: T0,
      }),
    ).rejects.toMatchObject({ code: "circular_board_only", status: 422 });
  });

  it("circulate without a consent returns 422 consent_not_decided", async () => {
    const deps = makeDeps();
    const { resolution } = await createCircularDraft(deps, {
      bodyId: "board_body",
      title: "T",
      text: "X",
      decisionClassId: "class_board_ordinary",
      createdBy: "g1",
      at: T0,
    });
    await expect(
      circulateCircular(deps, { resolutionId: resolution.id, actorUid: "g1", isFounder: false, at: T0 }),
    ).rejects.toMatchObject({ code: "consent_not_decided", status: 422 });
  });

  it("circulate with a PENDING consent returns 422 consent_not_decided", async () => {
    const deps = makeDeps({ consents: new InMemoryConsentsClient([consent({ status: "pending" })]) });
    const { resolution } = await createCircularDraft(deps, {
      bodyId: "board_body",
      title: "T",
      text: "X",
      decisionClassId: "class_board_ordinary",
      consentId: "consent_1",
      createdBy: "g1",
      at: T0,
    });
    await expect(
      circulateCircular(deps, { resolutionId: resolution.id, actorUid: "g1", isFounder: false, at: T0 }),
    ).rejects.toMatchObject({ code: "consent_not_decided", status: 422 });
  });

  it("circulate with a REFUSED consent returns 422 consent_not_decided", async () => {
    const deps = makeDeps({ consents: new InMemoryConsentsClient([consent({ status: "refused" })]) });
    const { resolution } = await createCircularDraft(deps, {
      bodyId: "board_body",
      title: "T",
      text: "X",
      decisionClassId: "class_board_ordinary",
      consentId: "consent_1",
      createdBy: "g1",
      at: T0,
    });
    await expect(
      circulateCircular(deps, { resolutionId: resolution.id, actorUid: "g1", isFounder: false, at: T0 }),
    ).rejects.toMatchObject({ code: "consent_not_decided", status: 422 });
  });

  it("circulate by someone who is not creator, chair, or Founder is 403", async () => {
    const deps = makeDeps();
    const { resolution } = await createCircularDraft(deps, {
      bodyId: "board_body",
      title: "T",
      text: "X",
      decisionClassId: "class_board_ordinary",
      consentId: "consent_1",
      createdBy: "g2",
      at: T0,
    });
    await expect(
      circulateCircular(deps, { resolutionId: resolution.id, actorUid: "g5", isFounder: false, at: T0 }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("a decided consent circulates: snapshot is ALL Governors, window is 7 days, majority is 5 of 9", async () => {
    const deps = makeDeps();
    const res = await circulatingDraft(deps);
    expect(res.status).toBe("circulating");
    expect(res.governorUidsSnapshot).toEqual(GOVERNORS_9);
    expect(res.closesAt!.getTime() - res.circulatedAt!.getTime()).toBe(7 * DAY);
  });
});

describe("circular signing (ws-a §4.7, test case 16)", () => {
  it("a non-Governor cannot sign (403)", async () => {
    const deps = makeDeps();
    const res = await circulatingDraft(deps);
    await expect(
      signCircular(deps, { resolutionId: res.id, uid: "outsider", displayName: "X", at: T0 }),
    ).rejects.toMatchObject({ code: "not_a_governor", status: 403 });
  });

  it("a repeat signature is 409 already_signed with NO state change", async () => {
    const deps = makeDeps();
    const res = await circulatingDraft(deps);
    await signCircular(deps, { resolutionId: res.id, uid: "g1", displayName: "G1", at: T0 });
    await expect(
      signCircular(deps, { resolutionId: res.id, uid: "g1", displayName: "G1", at: T0 }),
    ).rejects.toMatchObject({ code: "already_signed", status: 409 });
    const stored = await deps.store.getResolution(res.id);
    expect(stored?.signedCount).toBe(1);
    expect((deps.decisions as InMemoryDecisionsClient).all()).toHaveLength(0);
  });

  it("the 5th signature of 9 passes and writes exactly ONE decisions entry and no filing task (flag off)", async () => {
    const deps = makeDeps();
    const res = await circulatingDraft(deps);
    let last;
    for (const uid of GOVERNORS_9.slice(0, 5)) {
      last = await signCircular(deps, { resolutionId: res.id, uid, displayName: uid, at: T0 });
    }
    expect(last).toEqual({ signedCount: 5, majorityNeeded: 5, status: "passed" });
    const entries = (deps.decisions as InMemoryDecisionsClient).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "circular", sourceId: res.id, outcome: "passed", status: "effective" });
    expect(entries[0].votingSummary.denominator).toBe(9);
    expect((deps.filingTasks as InMemoryFilingTaskCreator).created).toHaveLength(0);
    const stored = await deps.store.getResolution(res.id);
    expect(stored?.decisionId).toBe(entries[0].id);
  });

  it("a flagged class creates exactly ONE filing task on pass, assigned to the secretary, due in 30 days", async () => {
    const filingClass: ServerDecisionClassView = {
      id: "class_filing",
      label: "Filing class",
      assignedBodyType: "board",
      majorityType: "fraction_of_all_governors",
      numerator: 1,
      denominatorKind: "all_governors",
      consentRequired: true,
      isReservedMatter: false,
      filingFlag: true,
      sourceRow: "5.54",
      enforcementMode: "warn-only",
    };
    const deps = makeDeps({ classes: new InMemoryDecisionClassesReader([filingClass]) });
    const res = await circulatingDraft(deps, "class_filing");
    for (const uid of GOVERNORS_9.slice(0, 5)) {
      await signCircular(deps, { resolutionId: res.id, uid, displayName: uid, at: T0 });
    }
    const created = (deps.filingTasks as InMemoryFilingTaskCreator).created;
    expect(created).toHaveLength(1);
    expect(created[0].assigneeUid).toBe("ngs_1");
    expect(created[0].deadline.getTime() - T0.getTime()).toBe(30 * DAY);
    const stored = await deps.store.getResolution(res.id);
    expect(stored?.filingTaskId).not.toBeNull();
  });
});

describe("circular auto-close backstop (ws-a §6.6 T3, test case 16)", () => {
  it("cron close at 7 days with 4 signatures marks lapsed and writes NO decisions entry", async () => {
    const deps = makeDeps();
    const res = await circulatingDraft(deps);
    for (const uid of GOVERNORS_9.slice(0, 4)) {
      await signCircular(deps, { resolutionId: res.id, uid, displayName: uid, at: T0 });
    }
    const after = new Date(res.closesAt!.getTime() + 1000);
    const { transition } = await autoCloseCircular(deps, { resolutionId: res.id, now: after });
    expect(transition).toBe("lapsed");
    expect((await deps.store.getResolution(res.id))?.status).toBe("lapsed");
    expect((deps.decisions as InMemoryDecisionsClient).all()).toHaveLength(0);
  });

  it("auto-close is idempotent: a second run does nothing", async () => {
    const deps = makeDeps();
    const res = await circulatingDraft(deps);
    const after = new Date(res.closesAt!.getTime() + 1000);
    await autoCloseCircular(deps, { resolutionId: res.id, now: after });
    const second = await autoCloseCircular(deps, { resolutionId: res.id, now: after });
    expect(second.transition).toBeNull();
  });
});
