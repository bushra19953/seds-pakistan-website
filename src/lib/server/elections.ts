/**
 * Election core: create, timetable publish, lifecycle transitions.
 * Spec Sections 3.1, 3.2, 4 (routes 1-4), 6.1, 6.3.
 *
 * Gates: creation is a Founder act (Decision Rights row 5.25: the
 * Founder appoints the Returning Officer, Founder alone). Every other
 * mutation here is gated on the per-election RO uid. Every governed
 * action writes a server audit entry and fails if the audit fails.
 */

import type {
  Election,
  ElectionTimetable,
  FsTimestamp,
} from "@/types/elections";
import {
  ELECTION_KIND,
  ELECTION_SEAT_CATEGORY,
  MEMBER_GOVERNOR_SEATS,
} from "@/types/elections";
import {
  deriveTimetable,
  validateTimetable,
  timetablePublicationDeadline,
  type TimetableMillis,
} from "@/lib/elections/timetable";
import {
  ElectionError,
  type ElectionPorts,
} from "./election-ports";
import {
  type Db,
  tsFromMillis,
  serverTimestamp,
  millisOf,
  getElectionOrThrow,
  setElectionDoc,
  updateElectionDoc,
  listElectionsViaSupa,
  countPendingNominationsViaSupa,
  assertRo,
  assertElectionStatus,
} from "./election-db";
import { writeElectionAudit } from "./election-audit";

export const RETURNING_OFFICER_ROLE_KEY = "returning_officer";

export function timetableToMillis(tt: ElectionTimetable): TimetableMillis {
  return {
    electionDay: millisOf(tt.electionDay),
    timetablePublishedAt:
      tt.timetablePublishedAt != null ? millisOf(tt.timetablePublishedAt) : null,
    timetableLateReason: tt.timetableLateReason,
    nominationOpenAt: millisOf(tt.nominationOpenAt),
    nominationCloseAt: millisOf(tt.nominationCloseAt),
    vettingDeadlineAt: millisOf(tt.vettingDeadlineAt),
    candidateListDate: millisOf(tt.candidateListDate),
    candidateListPublishedAt:
      tt.candidateListPublishedAt != null
        ? millisOf(tt.candidateListPublishedAt)
        : null,
    pollOpenAt: millisOf(tt.pollOpenAt),
    pollCloseAt: millisOf(tt.pollCloseAt),
    challengeWindowClosesAt:
      tt.challengeWindowClosesAt != null
        ? millisOf(tt.challengeWindowClosesAt)
        : null,
    certificateDeadlineAt:
      tt.certificateDeadlineAt != null
        ? millisOf(tt.certificateDeadlineAt)
        : null,
  };
}

export function timetableFromMillis(tm: TimetableMillis): ElectionTimetable {
  const opt = (v: number | null): FsTimestamp | null =>
    v === null ? null : tsFromMillis(v);
  return {
    electionDay: tsFromMillis(tm.electionDay),
    timetablePublishedAt: opt(tm.timetablePublishedAt),
    timetableLateReason: tm.timetableLateReason,
    nominationOpenAt: tsFromMillis(tm.nominationOpenAt),
    nominationCloseAt: tsFromMillis(tm.nominationCloseAt),
    vettingDeadlineAt: tsFromMillis(tm.vettingDeadlineAt),
    candidateListDate: tsFromMillis(tm.candidateListDate),
    candidateListPublishedAt: opt(tm.candidateListPublishedAt),
    pollOpenAt: tsFromMillis(tm.pollOpenAt),
    pollCloseAt: tsFromMillis(tm.pollCloseAt),
    challengeWindowClosesAt: opt(tm.challengeWindowClosesAt),
    certificateDeadlineAt: opt(tm.certificateDeadlineAt),
  };
}

export interface CreateElectionInput {
  actorUid: string;
  actorIsFounder: boolean;
  title: string;
  /** Must be "member_governor" when present; anything else is a
   *  non-Governor office and is rejected (spec Section 1.2). */
  kind?: string;
  /** Must be "member_elected" when present. */
  seatCategory?: string;
  seats?: number;
  electionDayMillis: number;
  returningOfficerUid: string;
  returningOfficerName: string;
  agmId?: string | null;
  campaignCodeUrl?: string | null;
  campaignCodeDriveFileId?: string | null;
}

export async function createElection(
  db: Db,
  ports: ElectionPorts,
  input: CreateElectionInput,
  nowMillis: number = Date.now(),
): Promise<Election> {
  if (!input.actorIsFounder) {
    throw new ElectionError(
      "founder_only",
      403,
      "Only the Founder may create an election and appoint its Returning Officer.",
    );
  }
  if (input.kind !== undefined && input.kind !== ELECTION_KIND) {
    throw new ElectionError(
      "non_governor_office",
      422,
      `Elections may only be held for Governor seats (kind "${ELECTION_KIND}"); "${input.kind}" is not an electable office.`,
    );
  }
  if (input.seatCategory !== undefined && input.seatCategory !== ELECTION_SEAT_CATEGORY) {
    throw new ElectionError(
      "non_governor_office",
      422,
      `Seat category must be "${ELECTION_SEAT_CATEGORY}"; "${input.seatCategory}" is not an electable Governor seat category.`,
    );
  }
  const seats = input.seats ?? MEMBER_GOVERNOR_SEATS;
  if (seats !== MEMBER_GOVERNOR_SEATS) {
    throw new ElectionError(
      "invalid_seats",
      422,
      `A Member Governor election fills exactly ${MEMBER_GOVERNOR_SEATS} seats in v1.`,
    );
  }
  if (input.returningOfficerUid === input.actorUid) {
    throw new ElectionError(
      "ro_is_founder",
      422,
      "The Founder cannot appoint themselves Returning Officer.",
    );
  }
  const roHoldsRole = await ports.roles.holdsRole(
    input.returningOfficerUid,
    RETURNING_OFFICER_ROLE_KEY,
  );
  if (!roHoldsRole) {
    throw new ElectionError(
      "ro_role_missing",
      422,
      "The appointee does not hold the returning_officer role in the authoritative role store.",
    );
  }

  const timetable = deriveTimetable(input.electionDayMillis);
  const ref = db.collection("elections").doc();
  const electionId = ref.id as string;

  // Compliance obligations (spec 1.1 item 8): idempotent per election.
  const timetableObl = await ports.compliance.registerObligation({
    key: `election:${electionId}:timetable`,
    kind: "election_timetable_publish",
    title: `Publish election timetable: ${input.title}`,
    dueAtMillis: timetablePublicationDeadline(input.electionDayMillis),
    ownerRole: RETURNING_OFFICER_ROLE_KEY,
    electionId,
  });
  const certificateObl = await ports.compliance.registerObligation({
    key: `election:${electionId}:certificate`,
    kind: "election_certificate_deliver",
    title: `Deliver election certificate within 24h of count end: ${input.title}`,
    dueAtMillis: timetable.pollCloseAt + 24 * 60 * 60 * 1000,
    ownerRole: RETURNING_OFFICER_ROLE_KEY,
    electionId,
  });

  const doc: Record<string, unknown> = {
    title: input.title,
    kind: ELECTION_KIND,
    seatCategory: ELECTION_SEAT_CATEGORY,
    seats,
    governorSeatIds: [],
    status: "draft",
    returningOfficerUid: input.returningOfficerUid,
    returningOfficerName: input.returningOfficerName,
    appointedByUid: input.actorUid,
    appointedAt: tsFromMillis(nowMillis),
    roTermEndsAt: null,
    timetable: timetableFromMillis(timetable),
    voterRoll: {
      status: "not_built",
      builtAt: null,
      frozenAt: null,
      rollSize: 0,
      rollHash: "",
    },
    campaignCodeUrl: input.campaignCodeUrl ?? null,
    campaignCodeDriveFileId: input.campaignCodeDriveFileId ?? null,
    complianceObligationIds: {
      timetable: timetableObl.obligationId,
      agmNotice: null,
      agm: null,
      certificate: certificateObl.obligationId,
      registrarFiling: "",
    },
    meetingId: null,
    agmId: input.agmId ?? null,
    counters: { ballotsCast: 0, markersCast: 0, tokensRedeemed: 0 },
    createdByUid: input.actorUid,
    createdAt: tsFromMillis(nowMillis),
    updatedAt: serverTimestamp(),
    cancelledReason: null,
    vettingOverdue: false,
  };
  await setElectionDoc(ref, doc, nowMillis);

  // RO appointment recorded in Phase 1 role_history through the port
  // (spec 1.1 item 1; the appointment itself is the Founder's act).
  await ports.roleHistory.recordRoleEvent({
    uid: input.returningOfficerUid,
    roleKey: RETURNING_OFFICER_ROLE_KEY,
    action: "grant",
    previousRole: null,
    newRole: RETURNING_OFFICER_ROLE_KEY,
    actorUid: input.actorUid,
    reason: `Appointed Returning Officer for election "${input.title}" (${electionId}); term ends when the result is declared.`,
    source: "admin_assign",
  });

  await writeElectionAudit(db, {
    action: "election.create",
    actorUid: input.actorUid,
    targetUidOrResource: `election:${electionId}`,
    payload: {
      title: input.title,
      seats,
      returningOfficerUid: input.returningOfficerUid,
      electionDay: timetable.electionDay,
    },
  });

  return getElectionOrThrow(db, electionId);
}

export async function publishTimetable(
  db: Db,
  electionId: string,
  callerUid: string,
  opts: { lateReason?: string | null } = {},
  nowMillis: number = Date.now(),
): Promise<Election> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  assertElectionStatus(election, ["draft"], "publish the timetable");

  const tm = timetableToMillis(election.timetable);
  tm.timetablePublishedAt = nowMillis;
  const validation = validateTimetable(tm, {
    publicationLateReason: opts.lateReason ?? null,
  });
  if (!validation.valid) {
    throw new ElectionError(
      "timetable_invalid",
      422,
      `Timetable is invalid: ${validation.violations.map((v) => v.message).join(" ")}`,
    );
  }

  await updateElectionDoc(
    db,
    electionId,
    {
      status: "timetable_published",
      timetable: timetableFromMillis({
        ...tm,
        timetableLateReason: validation.publicationMissFlagged
          ? (opts.lateReason ?? null)
          : null,
      }),
      updatedAt: serverTimestamp(),
    },
    nowMillis,
  );
  await writeElectionAudit(db, {
    action: "election.timetable_publish",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: {
      publishedAt: nowMillis,
      publicationMissFlagged: validation.publicationMissFlagged,
      lateReason: opts.lateReason ?? null,
    },
  });
  return getElectionOrThrow(db, electionId);
}

/** RO correction of timetable fields while draft / timetable_published. */
export async function updateTimetable(
  db: Db,
  electionId: string,
  callerUid: string,
  patch: Partial<TimetableMillis>,
  nowMillis: number = Date.now(),
): Promise<Election> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  assertElectionStatus(
    election,
    ["draft", "timetable_published"],
    "correct the timetable",
  );
  const tm = { ...timetableToMillis(election.timetable), ...patch };
  tm.vettingDeadlineAt = tm.nominationCloseAt + 3 * 24 * 60 * 60 * 1000;
  const validation = validateTimetable(tm, {
    publicationLateReason: tm.timetableLateReason,
  });
  if (!validation.valid) {
    throw new ElectionError(
      "timetable_invalid",
      422,
      `Timetable correction is invalid: ${validation.violations.map((v) => v.message).join(" ")}`,
    );
  }
  await updateElectionDoc(
    db,
    electionId,
    {
      timetable: timetableFromMillis(tm),
      updatedAt: serverTimestamp(),
    },
    nowMillis,
  );
  await writeElectionAudit(db, {
    action: "election.timetable_correct",
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { correctedAt: nowMillis, fields: Object.keys(patch) },
  });
  return getElectionOrThrow(db, electionId);
}

export type ElectionTransition =
  | "open_nominations"
  | "close_nominations"
  | "open_poll"
  | "close_poll"
  | "cancel";

const TRANSITIONS: Record<
  ElectionTransition,
  { from: string[]; to: string; auditAction: string }
> = {
  open_nominations: {
    from: ["timetable_published"],
    to: "nominations_open",
    auditAction: "election.nominations_open",
  },
  close_nominations: {
    from: ["nominations_open"],
    to: "nominations_closed",
    auditAction: "election.nominations_close",
  },
  open_poll: {
    from: ["candidates_certified"],
    to: "poll_open",
    auditAction: "election.poll_open",
  },
  close_poll: {
    from: ["poll_open"],
    to: "poll_closed",
    auditAction: "election.poll_close",
  },
  cancel: {
    from: [
      "draft",
      "timetable_published",
      "nominations_open",
      "nominations_closed",
      "candidates_certified",
    ],
    to: "cancelled",
    auditAction: "election.cancel",
  },
};

export async function transitionElection(
  db: Db,
  electionId: string,
  callerUid: string,
  transition: ElectionTransition,
  opts: { reason?: string | null } = {},
  nowMillis: number = Date.now(),
): Promise<Election> {
  const election = await getElectionOrThrow(db, electionId);
  assertRo(election, callerUid);
  const rule = TRANSITIONS[transition];
  assertElectionStatus(election, rule.from, `run transition "${transition}"`);

  const tm = timetableToMillis(election.timetable);
  if (transition === "open_poll" && nowMillis < tm.pollOpenAt) {
    throw new ElectionError(
      "poll_not_yet_open",
      409,
      "The poll cannot open before the published pollOpenAt.",
    );
  }
  if (transition === "close_poll" && nowMillis < tm.pollCloseAt) {
    throw new ElectionError(
      "poll_still_open",
      409,
      "The poll cannot close before the published pollCloseAt.",
    );
  }

  const update: Record<string, unknown> = {
    status: rule.to,
    updatedAt: serverTimestamp(),
  };
  if (transition === "cancel") {
    update.cancelledReason = opts.reason ?? null;
  }
  await updateElectionDoc(db, electionId, update, nowMillis);
  await writeElectionAudit(db, {
    action: rule.auditAction,
    actorUid: callerUid,
    targetUidOrResource: `election:${electionId}`,
    payload: { at: nowMillis, reason: opts.reason ?? null },
  });
  return getElectionOrThrow(db, electionId);
}

/**
 * Idempotent lifecycle sweeps (cron route; spec 6.2/6.3/6.7). Time-based
 * status moves that must happen without a human click. The cast
 * transaction enforces poll hours itself, so a lagging sweep never
 * admits a late ballot; the sweep only updates displayed status.
 */
export async function runElectionLifecycleSweeps(
  db: Db,
  nowMillis: number = Date.now(),
): Promise<{ transitioned: Array<{ electionId: string; to: string }> }> {
  const transitioned: Array<{ electionId: string; to: string }> = [];
  // Supa path lists fs_elections through the seam; on fallback the
  // original Firestore scan + per-doc read runs unchanged.
  const supaElections = await listElectionsViaSupa();
  const electionsList: Election[] = [];
  if (supaElections) {
    electionsList.push(...supaElections);
  } else {
    const snap = await db.collection("elections").get();
    for (const docSnap of snap.docs) {
      electionsList.push(await getElectionOrThrow(db, docSnap.id));
    }
  }
  for (const election of electionsList) {
    const tm = timetableToMillis(election.timetable);
    let to: string | null = null;

    if (election.status === "timetable_published" && nowMillis >= tm.nominationOpenAt) {
      to = "nominations_open";
    } else if (election.status === "nominations_open" && nowMillis >= tm.nominationCloseAt) {
      to = "nominations_closed";
    } else if (election.status === "candidates_certified" && nowMillis >= tm.pollOpenAt) {
      to = "poll_open";
    } else if (election.status === "poll_open" && nowMillis >= tm.pollCloseAt) {
      to = "poll_closed";
    } else if (
      election.status === "declared" &&
      election.timetable.challengeWindowClosesAt != null &&
      nowMillis >= millisOf(election.timetable.challengeWindowClosesAt)
    ) {
      to = "closed";
    }

    if (to) {
      await updateElectionDoc(
        db,
        election.id,
        {
          status: to,
          updatedAt: serverTimestamp(),
        },
        nowMillis,
      );
      await writeElectionAudit(db, {
        action: "election.lifecycle_sweep",
        actorUid: "system:cron",
        targetUidOrResource: `election:${election.id}`,
        payload: { from: election.status, to, at: nowMillis },
      });
      transitioned.push({ electionId: election.id, to });
    }

    // Vetting-deadline overdue flag (Sec 7.4: RO verifies within 3 days
    // of nominations close). Flag only; never auto-decides a nomination.
    if (
      election.status === "nominations_closed" &&
      nowMillis > tm.vettingDeadlineAt &&
      !(election as unknown as Record<string, unknown>).vettingOverdue
    ) {
      // Only the pending count is used (emptiness gate + audit payload),
      // so a count() aggregation replaces the full nominations fetch;
      // pendingCount is exactly the old snapshot's size. The seam serves
      // the same count from fs_group_nominations when active; null means
      // fall back to the Firestore count() aggregation below.
      const supaCount = await countPendingNominationsViaSupa(election.id);
      const pendingCount =
        supaCount ??
        (
          await db
            .collection("elections")
            .doc(election.id)
            .collection("nominations")
            .where("status", "in", ["submitted", "under_review"])
            .count()
            .get()
        ).data().count;
      if (pendingCount > 0) {
        await updateElectionDoc(
          db,
          election.id,
          { vettingOverdue: true },
          nowMillis,
        );
        await writeElectionAudit(db, {
          action: "election.vetting_overdue",
          actorUid: "system:cron",
          targetUidOrResource: `election:${election.id}`,
          payload: { pendingNominations: pendingCount, at: nowMillis },
        });
      }
    }
  }
  return { transitioned };
}
