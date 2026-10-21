import {
  InMemoryBodyDirectory,
  InMemoryUrgentStore,
  NATIONAL_PRESIDENT_ROLE_KEY,
  confirmUrgentNotification,
  processUrgentTimers,
  ratifyUrgentDecision,
  submitUrgentDecision,
  type UrgentDeps,
  type UrgentNotifier,
} from "../urgent";
import {
  InMemoryDecisionClassesReader,
  type ServerDecisionClassView,
} from "../decision-classes";
import { InMemoryDecisionsClient, type DecisionEntryInput } from "../decisions-client";
import { InMemoryBodyReader, type BodyView } from "../shared";
import type { UrgentDecisionRecord } from "@/lib/governance/urgent-decisions";

const T0 = new Date("2026-10-21T09:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BOARD_9 = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"];

const boardBody: BodyView = {
  id: "board_body",
  name: "Board of Governors",
  type: "board",
  chairUid: "g1",
  secretaryUid: "ngs_1",
  memberUids: [...BOARD_9],
  quorumOverride: null,
  chapterId: null,
};

const normalClass: ServerDecisionClassView = {
  id: "class_ops",
  label: "Operational decision",
  assignedBodyType: "board",
  majorityType: "fraction_of_all_governors",
  numerator: 1,
  denominatorKind: "all_governors",
  consentRequired: false,
  isReservedMatter: false,
  filingFlag: false,
  sourceRow: "4.10",
  enforcementMode: "enforce",
};

const reservedClass: ServerDecisionClassView = {
  ...normalClass,
  id: "class_reserved",
  label: "Reserved Matter",
  isReservedMatter: true,
  sourceRow: "RM-1",
};

class RecordingNotifier implements UrgentNotifier {
  submittedCalls: Array<{ id: string; uids: string[] }> = [];
  escalatedCalls: string[] = [];
  voidedCalls: Array<{ id: string; uids: string[] }> = [];
  async submitted(rec: UrgentDecisionRecord, uids: string[]) {
    this.submittedCalls.push({ id: rec.id, uids });
  }
  async escalated(rec: UrgentDecisionRecord) {
    this.escalatedCalls.push(rec.id);
  }
  async voided(rec: UrgentDecisionRecord, uids: string[]) {
    this.voidedCalls.push({ id: rec.id, uids });
  }
}

function makeDeps() {
  const store = new InMemoryUrgentStore();
  const notifier = new RecordingNotifier();
  const deps: UrgentDeps = {
    store,
    classes: new InMemoryDecisionClassesReader([normalClass, reservedClass]),
    decisions: new InMemoryDecisionsClient(),
    bodies: new InMemoryBodyReader([boardBody]),
    bodyDirectory: new InMemoryBodyDirectory([boardBody]),
    notifier,
    newId: () => store.nextId(),
  };
  return { deps, store, notifier };
}

const submitInput = (over: Record<string, unknown> = {}) => ({
  actorUid: "president_1",
  actorRoleKey: NATIONAL_PRESIDENT_ROLE_KEY as string | null,
  isFounderActor: false,
  title: "Emergency venue booking",
  description: "Book the backup venue today.",
  decisionClassId: "class_ops",
  harmStatement: "The booked venue floods tomorrow; without a replacement the AGM cannot sit.",
  affectedPartyUids: ["member_x"],
  at: T0,
  ...over,
});

describe("urgent submit gates (ws-a §4.8, test case 17)", () => {
  it("a Reserved Matter class returns 422 and creates NOTHING", async () => {
    const { deps, store } = makeDeps();
    await expect(
      submitUrgentDecision(deps, submitInput({ decisionClassId: "class_reserved" })),
    ).rejects.toMatchObject({ code: "reserved_matter_blocked", status: 422 });
    expect(await store.listDecisions()).toHaveLength(0);
    expect((deps.decisions as InMemoryDecisionsClient).all()).toHaveLength(0);
  });

  it("a Founder submit is 403 president_only, even with the President key absent", async () => {
    const { deps } = makeDeps();
    await expect(
      submitUrgentDecision(deps, submitInput({ isFounderActor: true })),
    ).rejects.toMatchObject({ code: "president_only", status: 403 });
  });

  it("a non-President member submit is 403 president_only", async () => {
    const { deps } = makeDeps();
    await expect(
      submitUrgentDecision(deps, submitInput({ actorRoleKey: "national_treasurer" })),
    ).rejects.toMatchObject({ code: "president_only", status: 403 });
  });

  it("a missing harm statement is 422", async () => {
    const { deps } = makeDeps();
    await expect(
      submitUrgentDecision(deps, submitInput({ harmStatement: "  " })),
    ).rejects.toMatchObject({ code: "harm_statement_required", status: 422 });
  });

  it("a valid submit sets both deadlines exactly, notifies the Board, and opens a pending_ratification register entry", async () => {
    const { deps, notifier } = makeDeps();
    const { record, registerDecisionId } = await submitUrgentDecision(deps, submitInput());
    expect(record.status).toBe("notified_pending_confirmation");
    expect(record.notificationDueAtMs - record.createdAtMs).toBe(24 * HOUR);
    expect(record.ratificationDueAtMs - record.createdAtMs).toBe(30 * DAY);
    expect(record.ratifyingBodyId).toBe("board_body");
    expect(notifier.submittedCalls).toEqual([{ id: record.id, uids: BOARD_9 }]);
    const entry = await deps.decisions.getDecision(registerDecisionId);
    expect(entry).toMatchObject({ source: "urgent", status: "pending_ratification", sourceId: record.id });
    expect(record.decisionId).toBe(registerDecisionId);
  });

  it("timer math holds across a month boundary (created Jan 31, ratification due Mar 2)", async () => {
    const { deps } = makeDeps();
    const jan31 = new Date("2027-01-31T09:00:00Z");
    const { record } = await submitUrgentDecision(deps, submitInput({ at: jan31 }));
    expect(new Date(record.ratificationDueAtMs).toISOString()).toBe("2027-03-02T09:00:00.000Z");
    expect(new Date(record.notificationDueAtMs).toISOString()).toBe("2027-02-01T09:00:00.000Z");
  });
});

describe("urgent confirm + timers (ws-a §6.5, §6.6 T4/T5, test case 17)", () => {
  it("confirmation flips to active_pending_ratification and is idempotent", async () => {
    const { deps } = makeDeps();
    const { record } = await submitUrgentDecision(deps, submitInput());
    const confirmed = await confirmUrgentNotification(deps, {
      decisionId: record.id,
      actorUid: "g3",
      at: new Date(T0.getTime() + HOUR),
    });
    expect(confirmed.status).toBe("active_pending_ratification");
    expect(confirmed.notificationConfirmedBy).toBe("g3");
    const again = await confirmUrgentNotification(deps, {
      decisionId: record.id,
      actorUid: "g4",
      at: new Date(T0.getTime() + 2 * HOUR),
    });
    expect(again.notificationConfirmedBy).toBe("g3"); // unchanged
  });

  it("cron at 24h unconfirmed escalates ONCE; rerunning escalates nothing", async () => {
    const { deps, notifier } = makeDeps();
    const { record } = await submitUrgentDecision(deps, submitInput());
    const at24 = new Date(T0.getTime() + 24 * HOUR);
    const first = await processUrgentTimers(deps, { now: at24 });
    expect(first.urgentEscalated).toBe(1);
    expect(notifier.escalatedCalls).toEqual([record.id]);
    const second = await processUrgentTimers(deps, { now: new Date(at24.getTime() + HOUR) });
    expect(second.urgentEscalated).toBe(0);
    expect(notifier.escalatedCalls).toHaveLength(1);
  });

  it("a confirmed decision is never escalated", async () => {
    const { deps } = makeDeps();
    const { record } = await submitUrgentDecision(deps, submitInput());
    await confirmUrgentNotification(deps, { decisionId: record.id, actorUid: "g1", at: T0 });
    const summary = await processUrgentTimers(deps, { now: new Date(T0.getTime() + 25 * HOUR) });
    expect(summary.urgentEscalated).toBe(0);
  });

  it("cron at 30 days unratified voids RETROACTIVELY, notifies affected parties, and deletes nothing", async () => {
    const { deps, store, notifier } = makeDeps();
    const { record, registerDecisionId } = await submitUrgentDecision(deps, submitInput());
    const at30 = new Date(T0.getTime() + 30 * DAY);
    const summary = await processUrgentTimers(deps, { now: at30 });
    expect(summary.urgentVoided).toBe(1);
    expect(summary.urgentEscalated).toBe(0); // void wins over escalation
    const stored = await store.getDecision(record.id);
    expect(stored).not.toBeNull(); // nothing deleted
    expect(stored?.status).toBe("void_retroactive");
    expect(stored?.voidReason).toBe("ratification_deadline_expired");
    const entry = await deps.decisions.getDecision(registerDecisionId);
    expect(entry?.status).toBe("void");
    // Retroactive: effective from the ORIGINAL createdAt, not the void time.
    expect(entry?.voidEffectiveFrom?.getTime()).toBe(T0.getTime());
    expect(entry?.voidedAt?.getTime()).toBe(at30.getTime());
    expect(notifier.voidedCalls[0].uids).toContain("president_1");
    expect(notifier.voidedCalls[0].uids).toContain("member_x"); // affected party
    expect(notifier.voidedCalls[0].uids).toContain("g5"); // Board member
    // Idempotent: a rerun voids nothing twice.
    const rerun = await processUrgentTimers(deps, { now: new Date(at30.getTime() + DAY) });
    expect(rerun.urgentVoided).toBe(0);
  });
});

describe("urgent ratify (ws-a §4.8, test case 18)", () => {
  async function ratificationEntry(
    deps: UrgentDeps,
    over: Partial<DecisionEntryInput> = {},
  ): Promise<string> {
    const entry = await (deps.decisions as InMemoryDecisionsClient).writeDecision({
      bodyId: "board_body",
      decisionClassId: "class_ops",
      source: "meeting_motion",
      sourceId: "motion_ratify",
      text: "Ratify the urgent decision",
      outcome: "passed",
      votingSummary: { votesFor: 6, votesAgainst: 1, abstentions: 0, denominator: 9, thresholdApplied: {} },
      consentId: null,
      decidedAt: T0,
      effectiveAt: T0,
      status: "effective",
      supersedesDecisionId: null,
      retentionUntil: new Date("2036-10-21T09:00:00Z"),
      ...over,
    });
    return entry.id;
  }

  it("ratify with a decisions entry of the WRONG CLASS returns 422", async () => {
    const { deps } = makeDeps();
    const { record } = await submitUrgentDecision(deps, submitInput());
    const wrongClass = await ratificationEntry(deps, { decisionClassId: "class_reserved" });
    await expect(
      ratifyUrgentDecision(deps, {
        decisionId: record.id,
        ratificationDecisionId: wrongClass,
        ratificationMotionId: "motion_ratify",
        actorUid: "g1",
        actorBodyIds: ["board_body"],
        at: new Date(T0.getTime() + DAY),
      }),
    ).rejects.toMatchObject({ code: "ratification_decision_invalid", status: 422 });
  });

  it("ratify by a non-member of the ratifying body is 403", async () => {
    const { deps } = makeDeps();
    const { record } = await submitUrgentDecision(deps, submitInput());
    const good = await ratificationEntry(deps);
    await expect(
      ratifyUrgentDecision(deps, {
        decisionId: record.id,
        ratificationDecisionId: good,
        ratificationMotionId: "motion_ratify",
        actorUid: "outsider",
        actorBodyIds: ["nec_body"],
        at: new Date(T0.getTime() + DAY),
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("a valid ratification sets ratified on BOTH the record and the register entry", async () => {
    const { deps, store } = makeDeps();
    const { record, registerDecisionId } = await submitUrgentDecision(deps, submitInput());
    const good = await ratificationEntry(deps);
    const ratified = await ratifyUrgentDecision(deps, {
      decisionId: record.id,
      ratificationDecisionId: good,
      ratificationMotionId: "motion_ratify",
      actorUid: "g1",
      actorBodyIds: ["board_body"],
      at: new Date(T0.getTime() + 2 * DAY),
    });
    expect(ratified.status).toBe("ratified");
    expect(ratified.ratificationDecisionId).toBe(good);
    expect((await store.getDecision(record.id))?.status).toBe("ratified");
    const entry = await deps.decisions.getDecision(registerDecisionId);
    expect(entry?.status).toBe("ratified");
    expect(entry?.ratifiedAt).not.toBeNull();
  });

  it("ratifying after the 30-day deadline is refused (ratification_deadline_expired)", async () => {
    const { deps } = makeDeps();
    const { record } = await submitUrgentDecision(deps, submitInput());
    const good = await ratificationEntry(deps);
    await expect(
      ratifyUrgentDecision(deps, {
        decisionId: record.id,
        ratificationDecisionId: good,
        ratificationMotionId: "motion_ratify",
        actorUid: "g1",
        actorBodyIds: ["board_body"],
        at: new Date(T0.getTime() + 30 * DAY),
      }),
    ).rejects.toMatchObject({ code: "ratification_deadline_expired", status: 422 });
  });
});
