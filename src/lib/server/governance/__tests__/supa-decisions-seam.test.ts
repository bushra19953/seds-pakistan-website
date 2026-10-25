/**
 * @jest-environment node
 *
 * Flag-ON mocked-adapter tests for the G4 seam (decisions-supa.ts).
 * The 60 contract suites pin flag-OFF / pure behaviour; these pin the
 * Supa path: register round-trip through jsonb-shaped storage, owned
 * transitions with the Firestore impl's error codes, the urgent
 * 30-day deadline at millisecond precision, and Firestore fallback on
 * adapter error.
 */
import { createFakeSupaAdapter } from "./fake-supa-adapter";
import {
  SupaDecisionClassesReader,
  SupaDecisionsClient,
  SupaUrgentStore,
  readDecisionsFromSupa,
} from "../decisions-supa";
import {
  FirestoreDecisionsClient,
  FirestoreDecisionClassesReader,
  FirestoreUrgentStore,
} from "../firestore-stores";
import { InMemoryDecisionsClient } from "../decisions-client";
import { InMemoryUrgentStore, ratifyUrgentDecision, submitUrgentDecision, NATIONAL_PRESIDENT_ROLE_KEY, type UrgentDeps } from "../urgent";
import { InMemoryDecisionClassesReader, type ServerDecisionClassView } from "../decision-classes";
import { InMemoryBodyReader, type BodyView } from "../shared";
import { InMemoryBodyDirectory } from "../urgent";
import { __setGovSupaAdapterForTests } from "../supa-shared";
import type { DecisionEntryInput } from "../decisions-client";

const T0 = new Date("2026-10-21T09:00:00.123Z");
const DAY = 24 * 60 * 60 * 1000;

const entryInput = (over: Partial<DecisionEntryInput> = {}): DecisionEntryInput => ({
  bodyId: "board_body",
  decisionClassId: "class_ops",
  source: "urgent",
  sourceId: "urgent_1",
  text: "Emergency repair",
  outcome: "effective",
  votingSummary: { votesFor: 0, votesAgainst: 0, abstentions: 0, denominator: 8, thresholdApplied: { kind: "fraction" } },
  consentId: null,
  decidedAt: T0,
  effectiveAt: T0,
  status: "pending_ratification",
  supersedesDecisionId: null,
  retentionUntil: new Date(T0.getTime() + 365 * DAY),
  ...over,
});

function supaDecisions(adapter = createFakeSupaAdapter()) {
  const fallback = new InMemoryDecisionsClient() as never;
  return { adapter, client: new SupaDecisionsClient(adapter, fallback) };
}

describe("SupaDecisionsClient (flag ON, mocked adapter)", () => {
  it("write -> read round-trips through ISO storage with ms precision and nested votingSummary intact", async () => {
    const { adapter, client } = supaDecisions();
    const entry = await client.writeDecision(entryInput());
    expect(entry.id).toHaveLength(20);
    const raw = adapter.raw("decisions", entry.id)!;
    expect(raw.decidedAt).toBe("2026-10-21T09:00:00.123Z");
    const back = await client.getDecision(entry.id);
    expect(back?.decidedAt).toEqual(T0);
    expect(back?.decidedAt.getTime()).toBe(T0.getTime());
    expect(back?.votingSummary).toEqual(entryInput().votingSummary);
    expect(back?.status).toBe("pending_ratification");
    expect(await client.isEffectiveDecision(entry.id)).toBe(false);
  });

  it("owned transition pending_ratification -> ratified stamps ratifiedAt; a second transition is 422 invalid_decision_transition", async () => {
    const { client } = supaDecisions();
    const entry = await client.writeDecision(entryInput());
    const at = new Date(T0.getTime() + DAY);
    const done = await client.transitionDecisionStatus(entry.id, "ratified", { ratifiedAt: at });
    expect(done.status).toBe("ratified");
    expect(done.ratifiedAt).toEqual(at);
    await expect(client.transitionDecisionStatus(entry.id, "void", {})).rejects.toMatchObject({
      code: "invalid_decision_transition",
      status: 422,
    });
  });

  it("transition on a missing entry is 404 decision_not_found (Firestore impl codes preserved)", async () => {
    const { client } = supaDecisions();
    await expect(client.transitionDecisionStatus("nope", "ratified", {})).rejects.toMatchObject({
      code: "decision_not_found",
      status: 404,
    });
  });

  it("adapter error delegates to the Firestore-side fallback instead of throwing", async () => {
    const adapter = createFakeSupaAdapter();
    adapter.failAll = true;
    const fallback = new InMemoryDecisionsClient();
    const client = new SupaDecisionsClient(adapter, fallback as never);
    const entry = await client.writeDecision(entryInput());
    expect(fallback.all()).toHaveLength(1);
    expect(entry.id).toBe(fallback.all()[0].id);
  });
});

describe("readDecisionsFromSupa (decisions route seam)", () => {
  afterEach(() => __setGovSupaAdapterForTests(undefined));

  it("returns null when no adapter is injected and the flag is off (Firestore path)", async () => {
    __setGovSupaAdapterForTests(null);
    await expect(readDecisionsFromSupa({})).resolves.toBeNull();
  });

  it("list: decidedAt DESC, limit 200, bodyId filter — over ISO-stored docs", async () => {
    const adapter = createFakeSupaAdapter();
    __setGovSupaAdapterForTests(adapter);
    for (let i = 0; i < 3; i++) {
      adapter.seed("decisions", `d${i}`, {
        bodyId: i === 2 ? "other_body" : "board_body",
        decidedAt: new Date(T0.getTime() + i * DAY),
        status: "effective",
      });
    }
    const all = await readDecisionsFromSupa({});
    expect(all?.docs?.map((d) => d.id)).toEqual(["d2", "d1", "d0"]);
    const filtered = await readDecisionsFromSupa({ bodyId: "board_body" });
    expect(filtered?.docs?.map((d) => d.id)).toEqual(["d1", "d0"]);
    const single = await readDecisionsFromSupa({ id: "d1" });
    expect(single?.found).toBe(true);
    expect(single?.doc?.id).toBe("d1");
    const missing = await readDecisionsFromSupa({ id: "nope" });
    expect(missing?.found).toBe(false);
  });
});

describe("urgent chain over Supa stores: 30-day deadline to the millisecond", () => {
  const urgentClass: ServerDecisionClassView = {
    id: "class_ops", label: "Operational decision", assignedBodyType: "board",
    majorityType: "fraction_of_all_governors", numerator: 1,
    denominatorKind: "all_governors", consentRequired: false,
    isReservedMatter: false, filingFlag: false, sourceRow: "4.10", enforcementMode: "enforce",
  };
  const board8: BodyView = {
    id: "board_body", name: "Board of Governors", type: "board",
    chairUid: "g1", secretaryUid: "ngs_1",
    memberUids: ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"],
    quorumOverride: null, chapterId: null,
  };

  function makeDeps() {
    const adapter = createFakeSupaAdapter();
    const store = new SupaUrgentStore(adapter, new InMemoryUrgentStore() as never);
    const decisions = new SupaDecisionsClient(adapter, new InMemoryDecisionsClient() as never);
    const deps: UrgentDeps = {
      store, decisions,
      classes: new InMemoryDecisionClassesReader([urgentClass]),
      bodies: new InMemoryBodyReader([board8]),
      bodyDirectory: new InMemoryBodyDirectory([board8]),
      newId: () => store.nextId(),
    };
    return { adapter, deps, store, decisions };
  }

  it("submit stores *Ms numbers untouched; ratify at due-1ms succeeds, at due is expired", async () => {
    const { adapter, deps, store } = makeDeps();
    const { record, registerDecisionId } = await submitUrgentDecision(deps, {
      actorUid: "president_1", actorRoleKey: NATIONAL_PRESIDENT_ROLE_KEY,
      isFounderActor: false, title: "Emergency repair", description: "Fix it",
      decisionClassId: "class_ops", harmStatement: "Delay breaks the programme",
      affectedPartyUids: [], at: T0,
    });
    expect(record.ratificationDueAtMs).toBe(T0.getTime() + 30 * DAY);
    const raw = adapter.raw("urgent_decisions", record.id)!;
    expect(raw.ratificationDueAtMs).toBe(T0.getTime() + 30 * DAY);
    expect(typeof raw.ratificationDueAtMs).toBe("number");

    const entry = await deps.decisions.writeDecision({
      bodyId: "board_body", decisionClassId: "class_ops", source: "meeting_motion",
      sourceId: "motion_ratify_1", text: "Ratify", outcome: "passed",
      votingSummary: { votesFor: 6, votesAgainst: 1, abstentions: 0, denominator: 8, thresholdApplied: {} },
      consentId: null, decidedAt: T0, effectiveAt: T0, status: "effective",
      supersedesDecisionId: null, retentionUntil: new Date(T0.getTime() + 365 * DAY),
    });
    const ratify = (at: Date) =>
      ratifyUrgentDecision(deps, {
        decisionId: record.id, ratificationDecisionId: entry.id,
        ratificationMotionId: "motion_ratify_1", actorUid: "g2",
        actorBodyIds: ["board_body"], at,
      });
    await expect(ratify(new Date(record.ratificationDueAtMs))).rejects.toMatchObject({
      code: "ratification_deadline_expired", status: 422,
    });
    const ok = await ratify(new Date(record.ratificationDueAtMs - 1));
    expect(ok.status).toBe("ratified");
    expect((await deps.decisions.getDecision(registerDecisionId))?.status).toBe("ratified");
    expect(await store.getDecision(record.id)).toMatchObject({ status: "ratified" });
  });

  it("classes reader: missing class is null (no local-matrix fallback smuggled in)", async () => {
    const adapter = createFakeSupaAdapter();
    const reader = new SupaDecisionClassesReader(adapter, new InMemoryDecisionClassesReader([]) as never);
    await expect(reader.getClass("class_ops")).resolves.toBeNull();
    adapter.seed("decisionClasses", "class_ops", { ...urgentClass });
    const got = await reader.getClass("class_ops");
    expect(got?.enforcementMode).toBe("enforce");
    void FirestoreDecisionsClient; void FirestoreDecisionClassesReader; void FirestoreUrgentStore;
  });
});
