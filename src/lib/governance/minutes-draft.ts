/**
 * Minutes auto-draft builder (Phase 3, Workstream A slice: MINUTES).
 *
 * Source spec: ~/workspace/bylaws_incorporation/implementation/drafts/ws-a.md
 *   - section 1.1 A6 / section 3.7 (minutes/{minutesId} data model)
 *   - section 6.3 (minutes flow)
 *   - file list section 2.1: "src/lib/governance/minutes-draft.ts - pure
 *     builder: buildMinutesDraft(meeting, attendance, motions, consents,
 *     disclosures) returns the six sec 3.5 fields as structured data. No I/O."
 *
 * Procedure Manual sec 3.5 (as enumerated in ws-a section 3.7) has SIX
 * generated fields, (a)-(f). They are NEVER free-typed as the source and
 * NEVER overwritten by the editor (ws-a 3.7 / 4.6); the NGS may only add
 * supplementaryNotes and per-field corrections (see minutes-lifecycle.ts).
 *
 * This module is pure: no Firebase, no I/O. Timestamps are passed through
 * opaquely (Firestore Timestamp in production, Date/string in tests).
 */

/** Opaque timestamp value: passed through, never interpreted here. */
export type MinutesTimeValue = unknown;

/** ADAPTER: spec-shaped meeting input (ws-a section 3.3 subset). */
export interface MinutesMeetingInput {
  id: string;
  bodyId: string;
  bodyType: string;
  /** Consent linked to the meeting itself (ws-a 3.3 consentId), if any. */
  consentId?: string | null;
  quorumRequired: number;
  quorumVerifiedAt?: MinutesTimeValue;
  quorumVerifiedBy?: string | null;
  closedAt?: MinutesTimeValue;
}

/** ADAPTER: spec-shaped attendance input (ws-a section 3.4 subset). */
export interface MinutesAttendanceInput {
  uid: string;
  displayName: string;
  mode: "in_person" | "electronic" | "absent";
  isPresent: boolean;
}

/** ADAPTER: spec-shaped motion input (ws-a section 3.5 subset). */
export interface MinutesMotionInput {
  id: string;
  text: string;
  decisionClassId: string;
  proposerUid: string;
  method: "show_of_hands" | "electronic_poll" | "secret_ballot";
  status: string;
  consentId?: string | null;
  result?: {
    votesFor: number;
    votesAgainst: number;
    abstentions: number;
    castingVoteUsed?: boolean;
  } | null;
}

/**
 * ADAPTER: spec-shaped traceable ballot input (ws-a section 3.6 subset).
 * Secret-ballot choices are NEVER passed in this shape: the secret store
 * carries no uid and no per-voter choice that may reach minutes. Secret
 * totals arrive only via MinutesSecretTotalsInput below.
 */
export interface MinutesBallotInput {
  motionId: string;
  voterUid: string;
  choice: "for" | "against" | "abstain";
  isCastingVote?: boolean;
  interestDisclosure?: {
    hasInterest: boolean;
    description: string;
    relatedPartyName: string | null;
  } | null;
}

/** Totals-only input for a secret ballot (ws-a 3.6 / 3.7 field (e)). */
export interface MinutesSecretTotalsInput {
  motionId: string;
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  castingVoteUsed?: boolean;
  castingChoice?: "for" | "against" | "abstain" | null;
}

/** ADAPTER: spec-shaped consent input (ws-a section 3.9 subset). */
export interface MinutesConsentInput {
  consentId: string;
  matter: string;
  /** ws-a 3.7 field (f) outcome enum; Phase 2 status maps onto this. */
  outcome: "granted" | "refused" | "conditional";
  decidedAt?: MinutesTimeValue;
}

/**
 * Optional quorum evaluation produced by the shared quorum engine
 * (ws-a section 6.2, src/lib/governance/quorum-engine.ts, sibling slice).
 * ADAPTER: when the engine module is present the caller passes its result;
 * when absent, the builder falls back to presentCount >= quorumRequired and
 * says so via quorumSource.
 */
export interface MinutesQuorumEvaluationInput {
  met: boolean;
  presentCount: number;
  required: number;
}

export interface BuildMinutesDraftInput {
  meeting: MinutesMeetingInput;
  attendance: MinutesAttendanceInput[];
  motions: MinutesMotionInput[];
  ballots?: MinutesBallotInput[];
  secretTotals?: MinutesSecretTotalsInput[];
  consents?: MinutesConsentInput[];
  quorumEvaluation?: MinutesQuorumEvaluationInput | null;
}

// ---------------------------------------------------------------------------
// Sec 3.5 field checklist (EXPLICIT, derived from ws-a section 3.7)
// ---------------------------------------------------------------------------

export interface Sec35ChecklistEntry {
  /** Generated field key on the minutes document. */
  field: string;
  /** ws-a section 3.7 letter, (a)-(f). */
  specLetter: "a" | "b" | "c" | "d" | "e" | "f";
  /** What the field must contain, per ws-a section 3.7. */
  specText: string;
  /** Sub-keys that must all be present for the field to be complete. */
  requiredSubKeys: string[];
}

/**
 * The six Doc 07 sec 3.5 fields, verbatim from ws-a section 3.7:
 *  (a) fieldAttendees  - present / absent / electronic attendee lists
 *  (b) fieldQuorum     - quorum verification record
 *  (c) fieldDisclosures - interest disclosures (from ballots)
 *  (d) fieldMotions    - motion texts
 *  (e) fieldVoting     - voting record (secret ballots: TOTALS ONLY)
 *  (f) fieldConsents   - Consents referenced
 */
export const MINUTES_SEC_3_5_CHECKLIST: readonly Sec35ChecklistEntry[] = [
  {
    field: "fieldAttendees",
    specLetter: "a",
    specText:
      "attendees: present (each { uid, displayName, mode }), absent (each { uid, displayName }), electronic (each { uid, displayName })",
    requiredSubKeys: ["present", "absent", "electronic"],
  },
  {
    field: "fieldQuorum",
    specLetter: "b",
    specText:
      "quorum verification record: { quorumRequired, presentCount, verifiedAt, verifiedBy, met }",
    requiredSubKeys: [
      "quorumRequired",
      "presentCount",
      "verifiedAt",
      "verifiedBy",
      "met",
    ],
  },
  {
    field: "fieldDisclosures",
    specLetter: "c",
    specText:
      "interest disclosures, generated from ballots.interestDisclosure: each { uid, displayName, motionId, description, relatedPartyName }",
    requiredSubKeys: [],
  },
  {
    field: "fieldMotions",
    specLetter: "d",
    specText:
      "motion texts: each { motionId, text, decisionClassId, proposerUid } (text is the exact motion string)",
    requiredSubKeys: [],
  },
  {
    field: "fieldVoting",
    specLetter: "e",
    specText:
      "voting record: each { motionId, votesFor, votesAgainst, abstentions, method, castingVoteUsed, castingChoice }; for secret ballots TOTALS ONLY, never per-voter choices",
    requiredSubKeys: [],
  },
  {
    field: "fieldConsents",
    specLetter: "f",
    specText:
      "Consents referenced, from consent_requests linked to the meeting and its motions: each { consentId, matter, outcome (granted | refused | conditional), decidedAt }",
    requiredSubKeys: [],
  },
] as const;

export const MINUTES_SEC_3_5_FIELDS: readonly string[] =
  MINUTES_SEC_3_5_CHECKLIST.map((e) => e.field);

// ---------------------------------------------------------------------------
// Generated field shapes (ws-a section 3.7)
// ---------------------------------------------------------------------------

export interface MinutesFieldAttendees {
  present: Array<{ uid: string; displayName: string; mode: string }>;
  absent: Array<{ uid: string; displayName: string }>;
  electronic: Array<{ uid: string; displayName: string }>;
}

export interface MinutesFieldQuorum {
  quorumRequired: number;
  presentCount: number;
  verifiedAt: MinutesTimeValue;
  verifiedBy: string | null;
  met: boolean;
  /** "quorum_engine" when an evaluation was supplied, else "fallback_count". */
  quorumSource: "quorum_engine" | "fallback_count";
}

export interface MinutesFieldDisclosure {
  uid: string;
  displayName: string;
  motionId: string;
  description: string;
  relatedPartyName: string | null;
}

export interface MinutesFieldMotion {
  motionId: string;
  text: string;
  decisionClassId: string;
  proposerUid: string;
}

export interface MinutesFieldVoting {
  motionId: string;
  votesFor: number;
  votesAgainst: number;
  abstentions: number;
  method: string;
  castingVoteUsed: boolean;
  castingChoice: string | null;
}

export interface MinutesFieldConsent {
  consentId: string;
  matter: string;
  outcome: "granted" | "refused" | "conditional";
  decidedAt: MinutesTimeValue;
}

export interface MinutesDraftFields {
  fieldAttendees: MinutesFieldAttendees;
  fieldQuorum: MinutesFieldQuorum;
  fieldDisclosures: MinutesFieldDisclosure[];
  fieldMotions: MinutesFieldMotion[];
  fieldVoting: MinutesFieldVoting[];
  fieldConsents: MinutesFieldConsent[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Assemble the six sec 3.5 fields from records. Pure; no hand-typed input
 * is accepted as the source of any generated field.
 */
export function buildMinutesDraft(
  input: BuildMinutesDraftInput,
): MinutesDraftFields {
  const { meeting, attendance, motions } = input;
  const ballots = input.ballots ?? [];
  const secretTotals = input.secretTotals ?? [];
  const consents = input.consents ?? [];

  // (a) Attendees: present split by mode; electronic is the electronic
  // subset of present (ws-a 3.7(a)); absent is everyone not present
  // (attendance docs are pre-created absent per member, ws-a 3.4).
  const present = attendance
    .filter((a) => a.isPresent && a.mode !== "absent")
    .map((a) => ({ uid: a.uid, displayName: a.displayName, mode: a.mode }));
  const electronic = attendance
    .filter((a) => a.isPresent && a.mode === "electronic")
    .map((a) => ({ uid: a.uid, displayName: a.displayName }));
  const absent = attendance
    .filter((a) => !a.isPresent || a.mode === "absent")
    .map((a) => ({ uid: a.uid, displayName: a.displayName }));
  const fieldAttendees: MinutesFieldAttendees = { present, absent, electronic };

  // (b) Quorum verification record.
  const presentCount = present.length;
  const evaluation = input.quorumEvaluation ?? null;
  const fieldQuorum: MinutesFieldQuorum = {
    quorumRequired: evaluation ? evaluation.required : meeting.quorumRequired,
    presentCount: evaluation ? evaluation.presentCount : presentCount,
    verifiedAt: meeting.quorumVerifiedAt ?? null,
    verifiedBy: meeting.quorumVerifiedBy ?? null,
    met: evaluation
      ? evaluation.met
      : presentCount >= meeting.quorumRequired,
    quorumSource: evaluation ? "quorum_engine" : "fallback_count",
  };

  // (c) Interest disclosures, from traceable ballots only. A disclosure is
  // recorded and nothing more: it never blocks or excludes the ballot
  // (ws-a non-goal N1).
  const nameByUid = new Map(attendance.map((a) => [a.uid, a.displayName]));
  const fieldDisclosures: MinutesFieldDisclosure[] = ballots
    .filter((b) => b.interestDisclosure && b.interestDisclosure.hasInterest)
    .map((b) => ({
      uid: b.voterUid,
      displayName: nameByUid.get(b.voterUid) ?? b.voterUid,
      motionId: b.motionId,
      description: b.interestDisclosure!.description,
      relatedPartyName: b.interestDisclosure!.relatedPartyName ?? null,
    }));

  // (d) Motion texts: the exact motion strings (ws-a 3.5).
  const fieldMotions: MinutesFieldMotion[] = motions.map((m) => ({
    motionId: m.id,
    text: m.text,
    decisionClassId: m.decisionClassId,
    proposerUid: m.proposerUid,
  }));

  // (e) Voting record. Secret ballots: TOTALS ONLY - the row is built
  // exclusively from the totals input (or the motion result totals); no
  // per-voter choice is read or copied for a secret motion, even if a
  // stray ballot-shaped object is handed in. Traceable ballots: totals are
  // counted from ballots, with the Founder casting ballot counted
  // separately (castingVoteUsed / castingChoice), never merged into the
  // totals before the tie check (ws-a 3.6 / 4.5).
  const fieldVoting: MinutesFieldVoting[] = motions.map((m) => {
    if (m.method === "secret_ballot") {
      const totals =
        secretTotals.find((t) => t.motionId === m.id) ?? null;
      return {
        motionId: m.id,
        votesFor: totals ? totals.votesFor : m.result?.votesFor ?? 0,
        votesAgainst: totals
          ? totals.votesAgainst
          : m.result?.votesAgainst ?? 0,
        abstentions: totals
          ? totals.abstentions
          : m.result?.abstentions ?? 0,
        method: m.method,
        castingVoteUsed: totals
          ? totals.castingVoteUsed ?? false
          : m.result?.castingVoteUsed ?? false,
        castingChoice: totals ? totals.castingChoice ?? null : null,
      };
    }
    const motionBallots = ballots.filter((b) => b.motionId === m.id);
    const casting = motionBallots.find((b) => b.isCastingVote);
    const counted = motionBallots.filter((b) => !b.isCastingVote);
    return {
      motionId: m.id,
      votesFor: counted.filter((b) => b.choice === "for").length,
      votesAgainst: counted.filter((b) => b.choice === "against").length,
      abstentions: counted.filter((b) => b.choice === "abstain").length,
      method: m.method,
      castingVoteUsed: Boolean(casting),
      castingChoice: casting ? casting.choice : null,
    };
  });

  // (f) Consents referenced: consents linked to the meeting and its motions
  // (ws-a 3.7(f)). The caller supplies the linked consent records via the
  // consents ADAPTER; ids referenced on the meeting/motions but not supplied
  // are not invented here - the validator flags a referenced-but-unresolved
  // consent as missing at the service layer (see minutes.ts).
  const referencedIds = new Set<string>();
  if (meeting.consentId) referencedIds.add(meeting.consentId);
  for (const m of motions) if (m.consentId) referencedIds.add(m.consentId);
  const fieldConsents: MinutesFieldConsent[] = consents
    .filter((c) => referencedIds.size === 0 || referencedIds.has(c.consentId))
    .map((c) => ({
      consentId: c.consentId,
      matter: c.matter,
      outcome: c.outcome,
      decidedAt: c.decidedAt ?? null,
    }));

  return {
    fieldAttendees,
    fieldQuorum,
    fieldDisclosures,
    fieldMotions,
    fieldVoting,
    fieldConsents,
  };
}

// ---------------------------------------------------------------------------
// Completeness validator
// ---------------------------------------------------------------------------

export interface MinutesCompletenessResult {
  complete: boolean;
  /** Dotted paths of missing fields, e.g. "fieldQuorum.verifiedAt". */
  missing: string[];
}

/**
 * Given a minutes document (or candidate fields object), return every
 * missing sec 3.5 field. A field is missing when it is absent, null, or the
 * wrong shape; for the quorum verification record, verifiedAt / verifiedBy
 * must be non-null - an unverified quorum is not a verification record.
 * Array fields (c)-(f) are complete when present as arrays (a meeting may
 * legitimately have zero disclosures, motions, or consents).
 */
export function validateMinutesCompleteness(
  minutes: Partial<Record<string, unknown>> | null | undefined,
): MinutesCompletenessResult {
  const missing: string[] = [];
  if (!minutes || typeof minutes !== "object") {
    return { complete: false, missing: [...MINUTES_SEC_3_5_FIELDS] };
  }
  for (const entry of MINUTES_SEC_3_5_CHECKLIST) {
    const value = minutes[entry.field];
    if (value === undefined || value === null) {
      missing.push(entry.field);
      continue;
    }
    if (entry.requiredSubKeys.length > 0) {
      if (typeof value !== "object" || Array.isArray(value)) {
        missing.push(entry.field);
        continue;
      }
      const record = value as Record<string, unknown>;
      for (const sub of entry.requiredSubKeys) {
        const subValue = record[sub];
        if (subValue === undefined || subValue === null) {
          missing.push(`${entry.field}.${sub}`);
        }
      }
    } else if (!Array.isArray(value)) {
      missing.push(entry.field);
    }
  }
  return { complete: missing.length === 0, missing };
}

/** True when the minutes carry every sec 3.5 field. */
export function isMinutesComplete(
  minutes: Partial<Record<string, unknown>> | null | undefined,
): boolean {
  return validateMinutesCompleteness(minutes).complete;
}
