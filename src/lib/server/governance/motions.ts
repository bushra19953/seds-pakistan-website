/**
 * Motions service (ws-a §3.5, §4.5, §6.2, §6.4) — server only.
 *
 * Owns motion OPEN and CLOSE. Ballot casting lives in
 * src/lib/server/governance/ballots.ts (demand, traceable, secret token
 * flow, casting ballot, counting); close delegates counting to
 * closeMotionBallots there and then performs the register write (ONLY
 * through decisions-client), the filing task, and the canonical record
 * update here.
 *
 * The threshold is copied IMMUTABLY at open through
 * governance/meetings/decision-class-adapter.ts and never re-read.
 * The denominator snapshot is frozen at open; later joins/leaves and a
 * quorum pause/resume never retake it (ws-a §6.2).
 *
 * ADAPTER (meeting / attendance): meetings and attendance are Meetings
 * Core modules. This service reads them through MeetingReader /
 * AttendanceReader; Core's services satisfy these directly.
 *
 * ADAPTER (quorum at open): the open gate checks the meeting's stored
 * quorumRequired against live present count. The Board adjourned-sitting
 * Founder-presence rule is enforced by Core's verify-quorum step, which
 * must already have succeeded for the meeting to be convened (ws-a §4.4);
 * when Core's quorum-engine lands, evaluateQuorum replaces this count
 * check at this single seam.
 *
 * ADAPTER (referral lock): referrals are a sibling Part A module. The
 * lock check goes through ReferralLockReader; the default denies nothing
 * (no referrals module wired). Per ws-a §4.5 the assigned-body block and
 * the referral block both apply in enforce mode; in warn-only mode the
 * motion proceeds with a stamped matrixWarning naming what was overridden.
 */

import { fractionDenominatorFor } from "@/lib/governance/circular/threshold";
import { copyThresholdFromClass } from "@/lib/governance/meetings/decision-class-adapter";
import type {
  DecisionClassView as MotionDecisionClassView,
  InterestDisclosure,
  Motion,
} from "@/lib/governance/meetings/motions-types";
import { closeMotionBallots, type BallotStore } from "./ballots";
import type { DecisionsClient } from "./decisions-client";
import type { DecisionClassesReader, ServerDecisionClassView } from "./decision-classes";
import {
  GovernanceServiceError,
  filingDeadlineFor,
  recordRetentionUntil,
  type BodyReader,
  type FilingTaskCreator,
} from "./shared";

// ---------------------------------------------------------------------------
// Consumed interfaces (ADAPTERS, see header)
// ---------------------------------------------------------------------------

export interface MeetingView {
  id: string;
  bodyId: string;
  bodyType: string;
  chairUid: string;
  secretaryUid: string;
  status: string; // draft | noticed | convened | adjourned | reconvened | closed | cancelled
  quorumRequired: number;
  quorumVerifiedAt: Date | null;
}

export interface MeetingReader {
  getMeeting(meetingId: string): Promise<MeetingView | null>;
}

export class InMemoryMeetingReader implements MeetingReader {
  constructor(private meetings: MeetingView[] = []) {}

  add(m: MeetingView): void {
    this.meetings.push(m);
  }

  async getMeeting(meetingId: string): Promise<MeetingView | null> {
    return this.meetings.find((m) => m.id === meetingId) ?? null;
  }
}

export interface AttendanceReader {
  listPresentUids(meetingId: string): Promise<string[]>;
}

export class InMemoryAttendanceReader implements AttendanceReader {
  constructor(private present: Record<string, string[]> = {}) {}

  setPresent(meetingId: string, uids: string[]): void {
    this.present[meetingId] = [...uids];
  }

  async listPresentUids(meetingId: string): Promise<string[]> {
    return [...(this.present[meetingId] ?? [])];
  }
}

export interface ReferralLockReader {
  hasOpenReferral(bodyId: string, decisionClassId: string): Promise<boolean>;
}

export const noReferralLock: ReferralLockReader = {
  async hasOpenReferral() {
    return false;
  },
};

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export interface MotionStore {
  getMotion(id: string): Promise<Motion | null>;
  saveMotion(motion: Motion): Promise<void>;
  listMotionsByMeeting(meetingId: string): Promise<Motion[]>;
}

/** In-memory MotionStore for local tests. */
export class InMemoryMotionStore implements MotionStore {
  private motions = new Map<string, Motion>();
  private seq = 0;

  nextMotionId(): string {
    return `motion_${++this.seq}`;
  }

  async getMotion(id: string): Promise<Motion | null> {
    return this.motions.get(id) ?? null;
  }

  async saveMotion(motion: Motion): Promise<void> {
    this.motions.set(motion.id, motion);
  }

  async listMotionsByMeeting(meetingId: string): Promise<Motion[]> {
    return [...this.motions.values()].filter((m) => m.meetingId === meetingId);
  }
}

/** Project the canonical Motion to the ballots module's MotionRef shape. */
export function toMotionRef(m: Motion) {
  return {
    id: m.id,
    meetingId: m.meetingId,
    bodyId: m.bodyId,
    bodyType: m.bodyType,
    text: m.text,
    proposerUid: m.proposerUid,
    decisionClassId: m.decisionClassId,
    threshold: {
      majorityType: m.threshold.majorityType,
      numerator: m.threshold.numerator,
      denominatorKind: m.threshold.denominatorKind,
      requiredCount: m.threshold.requiredCount,
      consentRequired: m.threshold.consentRequired,
      isReservedMatter: m.threshold.isReservedMatter,
      filingFlag: m.threshold.filingFlag,
    },
    denominatorSnapshot: m.denominatorSnapshot,
    method: m.method,
    secretDemandedBy: [...m.secretDemandedBy],
    status: m.status,
  };
}

/**
 * BallotStore facade over a MotionStore: the ballots functions call
 * getMotion/saveMotion with MotionRef; this facade projects on read and
 * merges the mutable ballot-owned fields (status, method,
 * secretDemandedBy) back into the canonical Motion on write.
 */
export function ballotStoreFor(motions: MotionStore, ballots: BallotStore): BallotStore {
  return {
    // Ballot documents delegate 1:1 (explicit delegation: a spread would
    // silently drop the store's prototype methods).
    getBallot: (ballotId) => ballots.getBallot(ballotId),
    putBallot: (ballotId, doc) => ballots.putBallot(ballotId, doc),
    listBallots: (motionId) => ballots.listBallots(motionId),
    getSecretToken: (tokenHash) => ballots.getSecretToken(tokenHash),
    putSecretToken: (tokenHash, doc) => ballots.putSecretToken(tokenHash, doc),
    putSecretChoice: (choiceId, doc) => ballots.putSecretChoice(choiceId, doc),
    listSecretChoices: (motionId) => ballots.listSecretChoices(motionId),
    getTokenIssue: (motionId, uid) => ballots.getTokenIssue(motionId, uid),
    putTokenIssue: (motionId, uid, issuedAt) => ballots.putTokenIssue(motionId, uid, issuedAt),
    deleteTokenIssueLog: (motionId) => ballots.deleteTokenIssueLog(motionId),
    getProxyAuthorization: (authId) => ballots.getProxyAuthorization(authId),
    // Motion access projects / merges the canonical Motion.
    async getMotion(motionId: string) {
      const m = await motions.getMotion(motionId);
      return m ? toMotionRef(m) : null;
    },
    async saveMotion(ref) {
      const existing = await motions.getMotion(ref.id);
      if (!existing) {
        throw new GovernanceServiceError("motion_not_found", 404, `No motion with id ${ref.id}`);
      }
      await motions.saveMotion({
        ...existing,
        status: ref.status,
        method: ref.method,
        secretDemandedBy: [...ref.secretDemandedBy],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Deps + helpers
// ---------------------------------------------------------------------------

export interface MotionDeps {
  motions: MotionStore;
  ballots: BallotStore;
  meetings: MeetingReader;
  attendance: AttendanceReader;
  bodies: BodyReader;
  classes: DecisionClassesReader;
  decisions: DecisionsClient;
  filingTasks: FilingTaskCreator;
  referrals?: ReferralLockReader;
  newId?: () => string;
}

function err(code: string, status: number, message: string): GovernanceServiceError {
  return new GovernanceServiceError(code, status, message);
}

async function mustGetMotion(deps: MotionDeps, id: string): Promise<Motion> {
  const m = await deps.motions.getMotion(id);
  if (!m) throw err("motion_not_found", 404, `No motion with id ${id}`);
  return m;
}

/** Map the server class view to the motions class view (single seam). */
export function toMotionClassView(cls: ServerDecisionClassView): MotionDecisionClassView {
  return {
    id: cls.id,
    label: cls.label,
    assignedBodyType: cls.assignedBodyType,
    majorityType: cls.majorityType,
    numerator: cls.numerator,
    fractionDenominator: fractionDenominatorFor(cls.majorityType, cls.numerator),
    denominatorKind: cls.denominatorKind as MotionDecisionClassView["denominatorKind"],
    consentRequired: cls.consentRequired,
    isReservedMatter: cls.isReservedMatter,
    filingFlag: cls.filingFlag,
    sourceRow: cls.sourceRow,
    enforcementMode: cls.enforcementMode === "enforce" ? "enforce" : "warn",
  };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open a motion (ws-a §4.5). Gates, in order: meeting exists; caller is
 * the chair (403); meeting is convened or reconvened (409 — which also
 * proves verify-quorum succeeded, §4.4); quorum currently met (409
 * quorum_not_met); class exists (422). In enforce mode a class assigned
 * to another body is 403 class_assigned_higher and an open referral is
 * 409 referral_open; in warn-only mode the motion proceeds with the
 * override stamped in matrixWarning. The threshold copy and the
 * denominator snapshot are frozen here and never retaken.
 */
export async function openMotion(
  deps: MotionDeps,
  input: {
    meetingId: string;
    actorUid: string;
    text: string;
    decisionClassId: string;
    proposerUid: string;
    method?: Motion["method"];
    subjectRef?: string | null;
    minutesApprovalFor?: string | null;
    supersedesDecisionId?: string | null;
    reversesDecisionId?: string | null;
    consentId?: string | null;
    at: Date;
  },
): Promise<{ motion: Motion; matrixWarning: string | null }> {
  const meeting = await deps.meetings.getMeeting(input.meetingId);
  if (!meeting) throw err("meeting_not_found", 404, `No meeting with id ${input.meetingId}`);
  if (input.actorUid !== meeting.chairUid) {
    throw err("not_chair", 403, "Only the chair may open a motion");
  }
  if (meeting.status !== "convened" && meeting.status !== "reconvened") {
    throw err("meeting_not_convened", 409, `Meeting is ${meeting.status}; motions open only after quorum verification convenes it`);
  }
  const cls = await deps.classes.getClass(input.decisionClassId);
  if (!cls) throw err("decision_class_not_found", 422, `No decision class with id ${input.decisionClassId}`);
  const clsView = toMotionClassView(cls);
  const mode = clsView.enforcementMode ?? "warn";

  const warnings: string[] = [];
  const assignedElsewhere = cls.assignedBodyType !== meeting.bodyType;
  if (assignedElsewhere) {
    if (mode === "enforce") {
      throw err(
        "class_assigned_higher",
        403,
        `Decision class ${cls.id} is assigned to ${cls.assignedBodyType}, not ${meeting.bodyType}`,
      );
    }
    warnings.push(`Class ${cls.id} is assigned to ${cls.assignedBodyType}; opened in ${meeting.bodyType} under warn-only mode`);
  }
  const referralOpen = deps.referrals ? await deps.referrals.hasOpenReferral(meeting.bodyId, cls.id) : false;
  if (referralOpen) {
    if (mode === "enforce") {
      throw err("referral_open", 409, `An open referral covers class ${cls.id} for this body; the matter sits with the higher body`);
    }
    warnings.push(`An open referral covers class ${cls.id} for this body; opened under warn-only mode`);
  }

  const body = await deps.bodies.getBody(meeting.bodyId);
  if (!body) throw err("body_not_found", 404, `No body with id ${meeting.bodyId}`);
  const presentUids = await deps.attendance.listPresentUids(meeting.id);
  if (presentUids.length < meeting.quorumRequired) {
    throw err(
      "quorum_not_met",
      409,
      `Quorum is ${meeting.quorumRequired} but only ${presentUids.length} members are present`,
    );
  }

  const denominatorSnapshot = {
    eligibleUids: [...body.memberUids],
    presentUids: [...presentUids],
    presentCount: presentUids.length,
    wholeBodyCount: body.memberUids.length,
  };
  const threshold = copyThresholdFromClass(clsView, denominatorSnapshot.wholeBodyCount);
  const matrixWarning = warnings.length > 0 ? warnings.join("; ") : null;

  const motion: Motion = {
    id: deps.newId ? deps.newId() : `motion_${input.at.getTime()}`,
    meetingId: meeting.id,
    bodyId: meeting.bodyId,
    bodyType: meeting.bodyType,
    text: input.text,
    proposerUid: input.proposerUid,
    decisionClassId: cls.id,
    threshold,
    denominatorSnapshot,
    method: input.method ?? "electronic_poll",
    secretDemandedBy: [],
    status: "open",
    disclosures: [],
    openedAt: input.at,
    openedBy: input.actorUid,
    closedAt: null,
    closedBy: null,
    result: null,
    decisionId: null,
    supersedesDecisionId: input.supersedesDecisionId ?? null,
    reversesDecisionId: input.reversesDecisionId ?? null,
    consentId: input.consentId ?? null,
    matrixWarning,
    subjectRef: input.subjectRef ?? null,
    minutesApprovalFor: input.minutesApprovalFor ?? null,
  };
  await deps.motions.saveMotion(motion);
  return { motion, matrixWarning };
}

/**
 * Record a per-motion interest disclosure (ws-a §3.5/§3.6, minutes field
 * (c)). A disclosure NEVER blocks anything (non-goal N1): it is recorded
 * and nothing more. Refused only when the motion is already closed.
 */
export async function recordMotionDisclosure(
  deps: MotionDeps,
  input: { motionId: string; uid: string; disclosure: InterestDisclosure; at: Date },
): Promise<Motion> {
  const motion = await mustGetMotion(deps, input.motionId);
  if (motion.status !== "open" && motion.status !== "paused_quorum_lost") {
    throw err("motion_not_open", 409, `Motion is ${motion.status}; disclosures are recorded while it is open`);
  }
  const next: Motion = {
    ...motion,
    disclosures: [
      ...motion.disclosures,
      { uid: input.uid, disclosure: input.disclosure, recordedAt: input.at },
    ],
  };
  await deps.motions.saveMotion(next);
  return next;
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export interface CloseMotionResult {
  status: Motion["status"];
  tied: boolean;
  result: Motion["result"];
  decisionId: string | null;
  filingTaskId: string | null;
}

/**
 * Close a motion (ws-a §4.5). Chair only. Counting and threshold
 * evaluation delegate to closeMotionBallots (the ballots slice). A tie
 * at Board/Council parks the motion at closed_tied_pending_casting with
 * NO register entry; the Founder casting ballot plus a second close
 * finalizes it. On final close: the result is stamped on the canonical
 * record, the decisions entry is written via decisions-client (failed
 * motions are recorded too — the register records each decision), and a
 * filing task is created when the copied threshold carries the filing
 * flag.
 */
export async function closeMotion(
  deps: MotionDeps,
  input: { motionId: string; actorUid: string; at: Date },
): Promise<CloseMotionResult> {
  const motion = await mustGetMotion(deps, input.motionId);
  if (motion.meetingId) {
    const meeting = await deps.meetings.getMeeting(motion.meetingId);
    if (meeting && input.actorUid !== meeting.chairUid) {
      throw err("not_chair", 403, "Only the chair may close a motion");
    }
  }
  const store = ballotStoreFor(deps.motions, deps.ballots);
  const outcome = await closeMotionBallots(store, { motionId: input.motionId });

  if (outcome.tied) {
    const parked = await mustGetMotion(deps, input.motionId);
    return { status: parked.status, tied: true, result: null, decisionId: null, filingTaskId: null };
  }

  const current = await mustGetMotion(deps, input.motionId);
  const result: Motion["result"] = outcome.result
    ? {
        votesFor: outcome.result.votesFor,
        votesAgainst: outcome.result.votesAgainst,
        abstentions: outcome.result.abstentions,
        denominatorUsed: outcome.result.denominatorUsed,
        thresholdMet: outcome.result.thresholdMet,
        castingVoteUsed: outcome.result.castingVoteUsed,
      }
    : null;

  const entry = await deps.decisions.writeDecision({
    bodyId: current.bodyId,
    decisionClassId: current.decisionClassId,
    source: current.reversesDecisionId ? "reversal" : current.supersedesDecisionId ? "override" : "meeting_motion",
    sourceId: current.id,
    text: current.text,
    outcome: outcome.status === "closed_passed" ? "passed" : "failed",
    votingSummary: {
      votesFor: outcome.tallies.votesFor,
      votesAgainst: outcome.tallies.votesAgainst,
      abstentions: outcome.tallies.abstentions,
      denominator: result?.denominatorUsed ?? current.denominatorSnapshot.wholeBodyCount,
      thresholdApplied: { ...current.threshold },
    },
    consentId: current.consentId,
    decidedAt: input.at,
    effectiveAt: input.at,
    status: "effective",
    supersedesDecisionId: current.supersedesDecisionId,
    retentionUntil: recordRetentionUntil(input.at),
  });

  let filingTaskId: string | null = null;
  if (current.threshold.filingFlag) {
    const meeting = current.meetingId ? await deps.meetings.getMeeting(current.meetingId) : null;
    filingTaskId = await deps.filingTasks.createFilingTask({
      title: `File decision: ${current.text.slice(0, 80)}`,
      description: `File the decision on motion ${current.id} (class ${current.decisionClassId}) with the register.`,
      assigneeUid: meeting?.secretaryUid ?? current.openedBy,
      deadline: filingDeadlineFor(input.at),
      sourceKind: "motion",
      sourceId: current.id,
    });
  }

  const closed: Motion = {
    ...current,
    status: outcome.status,
    result,
    decisionId: entry.id,
    closedAt: input.at,
    closedBy: input.actorUid,
  };
  await deps.motions.saveMotion(closed);
  return { status: closed.status, tied: false, result, decisionId: entry.id, filingTaskId };
}
