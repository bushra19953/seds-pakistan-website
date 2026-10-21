/**
 * ADAPTER PORTS for Phase 3 Workstream B (Elections + AGM).
 *
 * =====================================================================
 * ADAPTER NOTICE: Phase 1 (role store, Full Member derivation, Register
 * of Members) and Phase 2 (Board of Governors, lifecycle engine,
 * compliance engine, discipline rebuild) and Workstream A (meetings /
 * decision register) are NOT on this branch. Every cross-phase
 * dependency of the elections suite is expressed as a port interface
 * here, with a local default implementation that is clearly a stub.
 * When the real modules land, only this file changes: swap the default
 * implementations for calls into the real ports. No elections server
 * module imports a Phase 1/2 module directly.
 * =====================================================================
 */

import { createHash } from "crypto";
import type { FsTimestamp } from "@/types/elections";

// ---------------------------------------------------------------------------
// Error + timestamp helpers shared by the elections server modules
// ---------------------------------------------------------------------------

export class ElectionError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "ElectionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function toMillis(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const v = value as { toMillis?: () => number; seconds?: number };
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Port: Full Member derivation + Register of Members (Phase 1)
// ---------------------------------------------------------------------------

export interface FullMemberRecord {
  uid: string;
  displayName: string;
  chapterId: string | null;
  membershipClass: string;
  fullMemberSinceMillis: number | null;
  registerEntryDateMillis: number | null;
  duesYear: string;
}

export interface FullMemberPort {
  listFullMembers(): Promise<FullMemberRecord[]>;
  getFullMember(uid: string): Promise<FullMemberRecord | null>;
  isFullMember(uid: string): Promise<boolean>;
}

/**
 * ADAPTER (Phase 1): default implementation reads users/{uid} docs and
 * treats a user as a Full Member only when the doc carries an explicit
 * fullMember flag or membershipClass of "full_member". Phase 1's derived
 * derivation replaces this wholesale; until then the failure mode is
 * closed (nobody is a Full Member unless the record says so).
 */
export function createDefaultFullMemberPort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): FullMemberPort {
  async function readUser(uid: string): Promise<FullMemberRecord | null> {
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() as Record<string, unknown>;
    const isFull =
      d.fullMember === true || d.membershipClass === "full_member";
    if (!isFull) return null;
    return {
      uid,
      displayName: String(d.displayName ?? d.name ?? uid),
      chapterId: (d.chapterId as string | null) ?? null,
      membershipClass: String(d.membershipClass ?? "full_member"),
      fullMemberSinceMillis:
        d.fullMemberSince != null ? toMillis(d.fullMemberSince) : null,
      registerEntryDateMillis:
        d.registerEntryDate != null ? toMillis(d.registerEntryDate) : null,
      duesYear: String(d.duesYear ?? ""),
    };
  }

  return {
    async listFullMembers() {
      const snap = await db.collection("users").get();
      const out: FullMemberRecord[] = [];
      for (const doc of snap.docs) {
        const rec = await readUser(doc.id);
        if (rec) out.push(rec);
      }
      out.sort((a, b) => (a.uid < b.uid ? -1 : 1));
      return out;
    },
    getFullMember: readUser,
    async isFullMember(uid: string) {
      return (await readUser(uid)) !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Port: discipline - active Strikes (Phase 2 discipline rebuild)
// ---------------------------------------------------------------------------

export interface StrikeCheckResult {
  /** Null means the port could not answer; the RO attestation fallback
   *  applies and the check is recorded as manual, never silently passed. */
  activeStrikes: number | null;
  source: "port" | "ro_attestation";
}

export interface DisciplinePort {
  activeStrikes(uid: string): Promise<StrikeCheckResult>;
}

/**
 * ADAPTER (Phase 2 discipline): the discipline port is not live on this
 * branch, so the default implementation reports the attestation
 * fallback. When the Phase 2 port lands it returns source "port".
 */
export const defaultDisciplinePort: DisciplinePort = {
  async activeStrikes() {
    return { activeStrikes: null, source: "ro_attestation" };
  },
};

// ---------------------------------------------------------------------------
// Port: Board of Governors / Register of Governors (Phase 2)
// ---------------------------------------------------------------------------

export interface BoardPort {
  readSeatsDue(input: { year: number }): Promise<{ seatsDue: boolean }>;
  writeMemberGovernor(input: {
    electionId: string;
    candidateUid: string;
    votes: number;
    termStartMillis: number;
  }): Promise<{ governorId: string; termEndMillis: number | null }>;
}

/**
 * ADAPTER (Phase 2 Board module): writes go to a local stub collection
 * `governor_register_writebacks` so the declaration flow is fully
 * testable; readSeatsDue defaults to seats due (v1 first election has
 * both seats due, spec Section 12.3 item 2). Swap for the real port
 * when Phase 2 lands; only election-count.ts consumes this port.
 */
export function createDefaultBoardPort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): BoardPort {
  return {
    async readSeatsDue() {
      return { seatsDue: true };
    },
    async writeMemberGovernor(input) {
      const ref = db.collection("governor_register_writebacks").doc();
      await ref.set({
        ...input,
        seatCategory: "member_elected",
        adapterStub: true,
        writtenAtMillis: Date.now(),
      });
      return { governorId: ref.id, termEndMillis: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Port: lifecycle / vacancy engine (Phase 2)
// ---------------------------------------------------------------------------

export interface LifecyclePort {
  notifySeatsFilled(input: {
    electionId: string;
    electedUids: string[];
    termStartMillis: number;
  }): Promise<void>;
}

/** ADAPTER (Phase 2 lifecycle): records the notification locally. */
export function createDefaultLifecyclePort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): LifecyclePort {
  return {
    async notifySeatsFilled(input) {
      await db.collection("lifecycle_notifications").add({
        ...input,
        kind: "election_seats_filled",
        adapterStub: true,
        sentAtMillis: Date.now(),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Port: compliance engine (Phase 2)
// ---------------------------------------------------------------------------

export interface CompliancePort {
  /**
   * Register an obligation instance. MUST be idempotent on `key`:
   * retries with the same key return the same obligation id and never
   * duplicate the instance.
   */
  registerObligation(input: {
    key: string;
    kind: string;
    title: string;
    dueAtMillis: number;
    ownerRole: string;
    electionId?: string;
    agmId?: string;
  }): Promise<{ obligationId: string }>;
}

/**
 * ADAPTER (Phase 2 compliance engine): deterministic doc id derived
 * from the idempotency key inside a local `compliance_obligations`
 * collection, which is what makes registration idempotent here. The
 * real engine port keeps the same contract.
 */
export function createDefaultCompliancePort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): CompliancePort {
  return {
    async registerObligation(input) {
      const id = `obl_${sha256Hex(input.key).slice(0, 32)}`;
      const ref = db.collection("compliance_obligations").doc(id);
      const existing = await ref.get();
      if (!existing.exists) {
        await ref.set({
          key: input.key,
          kind: input.kind,
          title: input.title,
          dueAtMillis: input.dueAtMillis,
          ownerRole: input.ownerRole,
          electionId: input.electionId ?? null,
          agmId: input.agmId ?? null,
          status: "pending",
          adapterStub: true,
          registeredAtMillis: Date.now(),
        });
      }
      return { obligationId: id };
    },
  };
}

// ---------------------------------------------------------------------------
// Port: decision register (Workstream A) + fallback record
// ---------------------------------------------------------------------------

export interface DecisionRegisterPort {
  recordDecision(input: {
    kind: string;
    title: string;
    payload: Record<string, unknown>;
  }): Promise<{ decisionRecordId: string }>;
}

/**
 * ADAPTER (Workstream A): fallback writes a local `decision_records`
 * doc with the same field shape A specifies; when A lands, the port
 * writes into A's register instead. Spec Section 11.3 fallback.
 */
export function createDefaultDecisionRegisterPort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): DecisionRegisterPort {
  return {
    async recordDecision(input) {
      const ref = db.collection("decision_records").doc();
      await ref.set({ ...input, adapterStub: true, recordedAtMillis: Date.now() });
      return { decisionRecordId: ref.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Port: role history (Phase 1 single write path)
// ---------------------------------------------------------------------------

export interface RoleHistoryPort {
  recordRoleEvent(input: {
    uid: string;
    roleKey: string;
    action: "grant" | "change" | "revoke" | "delete" | "revert" | "repair";
    previousRole: string | null;
    newRole: string | null;
    actorUid: string;
    reason: string;
    source: string;
  }): Promise<void>;
}

/**
 * ADAPTER (Phase 1 role-writes.ts): the authoritative writer is
 * src/lib/server/role-writes.ts, which is not on this branch. This
 * stub writes a roleHistory-shaped doc so the RO appointment record
 * exists; it is replaced by the real write path on integration.
 */
export function createDefaultRoleHistoryPort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): RoleHistoryPort {
  return {
    async recordRoleEvent(input) {
      await db.collection("roleHistory").add({
        uid: input.uid,
        roleKey: input.newRole ?? input.roleKey,
        action: input.action,
        previousRole: input.previousRole,
        newRole: input.newRole,
        previousAdditionalRoles: [],
        newAdditionalRoles: [],
        previousEffectiveRole: input.previousRole ?? "member",
        newEffectiveRole: input.newRole ?? "member",
        chapterId: null,
        grantedBy: input.actorUid,
        actorUid: input.actorUid,
        reason: input.reason,
        source: input.source,
        consentRequestId: null,
        idempotencyKey: null,
        adapterStub: true,
        createdAtMillis: Date.now(),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Port: notifications (platform notificationService)
// ---------------------------------------------------------------------------

export interface NotificationPort {
  notifyUser(input: {
    uid: string;
    type: string;
    title: string;
    message: string;
    electionId?: string;
    agmId?: string;
  }): Promise<{ inAppNotificationId: string | null; inApp: "created" | "failed"; email: "sent" | "failed" | "skipped"; push: "sent" | "failed" | "skipped" }>;
}

/**
 * ADAPTER (notificationService): writes an in-app notification doc in
 * the shape the platform feed reads and reports email/push as skipped.
 * The real adapter calls src/lib/server/notification-service.ts and
 * mirrors its deliveryStatus verbatim (spec Section 3.6 recipients).
 */
export function createDefaultNotificationPort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): NotificationPort {
  return {
    async notifyUser(input) {
      try {
        const ref = db.collection("notifications").doc();
        await ref.set({
          userId: input.uid,
          type: input.type,
          title: input.title,
          message: input.message,
          electionId: input.electionId ?? null,
          agmId: input.agmId ?? null,
          read: false,
          adapterStub: true,
          createdAtMillis: Date.now(),
        });
        return {
          inAppNotificationId: ref.id,
          inApp: "created",
          email: "skipped",
          push: "skipped",
        };
      } catch {
        return { inAppNotificationId: null, inApp: "failed", email: "skipped", push: "skipped" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Port: Drive storage for certificates (governance kind)
// ---------------------------------------------------------------------------

export interface DrivePort {
  storeElectionCertificate(input: {
    electionId: string;
    fileName: string;
    pdfBytes: Uint8Array;
    sha256: string;
  }): Promise<{ driveFileId: string; driveLink: string }>;
}

/**
 * ADAPTER (Drive governance kind): no Drive upload happens in unit
 * tests or before the governance folder exists; the default port
 * records the certificate metadata in a local stub collection and
 * returns a stub reference. The production adapter uploads through
 * src/lib/drive with UploadKind "governance" (added in this
 * workstream) and returns the real file id/link.
 */
export function createDefaultDrivePort(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): DrivePort {
  return {
    async storeElectionCertificate(input) {
      const ref = db.collection("election_certificate_files").doc();
      await ref.set({
        electionId: input.electionId,
        fileName: input.fileName,
        sha256: input.sha256,
        sizeBytes: input.pdfBytes.length,
        adapterStub: true,
        storedAtMillis: Date.now(),
      });
      return { driveFileId: ref.id, driveLink: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// Port: role reads (Phase 1 authoritative store)
// ---------------------------------------------------------------------------

export interface RolePort {
  holdsRole(uid: string, roleKey: string): Promise<boolean>;
  roleOf(uid: string): Promise<string | null>;
}

/**
 * ADAPTER (Phase 1): reads roles/{uid} (authoritative store shape from
 * the Phase 1 interface contract) and falls back to the users/{uid}
 * mirror. When Phase 1 lands, routes resolve through
 * resolveCanonicalRole in src/lib/server/permissions.ts and this port
 * is only used inside the elections modules.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDefaultRolePort(db: any): RolePort {
  async function roleOf(uid: string): Promise<string | null> {
    const roleSnap = await db.collection("roles").doc(uid).get();
    if (roleSnap.exists) {
      const d = roleSnap.data() as Record<string, unknown>;
      if (typeof d.role === "string") return d.role;
    }
    const userSnap = await db.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const d = userSnap.data() as Record<string, unknown>;
      if (typeof d.role === "string") return d.role;
    }
    return null;
  }
  async function holdsRole(uid: string, roleKey: string): Promise<boolean> {
    const roleSnap = await db.collection("roles").doc(uid).get();
    if (roleSnap.exists) {
      const d = roleSnap.data() as Record<string, unknown>;
      if (d.role === roleKey) return true;
      if (Array.isArray(d.additionalRoles) && d.additionalRoles.includes(roleKey)) {
        return true;
      }
    }
    return (await roleOf(uid)) === roleKey;
  }
  return { holdsRole, roleOf };
}

// ---------------------------------------------------------------------------
// Bundle passed to server functions (tests override individual ports)
// ---------------------------------------------------------------------------

export interface ElectionPorts {
  fullMembers: FullMemberPort;
  discipline: DisciplinePort;
  board: BoardPort;
  lifecycle: LifecyclePort;
  compliance: CompliancePort;
  decisions: DecisionRegisterPort;
  roleHistory: RoleHistoryPort;
  notifications: NotificationPort;
  drive: DrivePort;
  roles: RolePort;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDefaultPorts(db: any): ElectionPorts {
  return {
    fullMembers: createDefaultFullMemberPort(db),
    discipline: defaultDisciplinePort,
    board: createDefaultBoardPort(db),
    lifecycle: createDefaultLifecyclePort(db),
    compliance: createDefaultCompliancePort(db),
    decisions: createDefaultDecisionRegisterPort(db),
    roleHistory: createDefaultRoleHistoryPort(db),
    notifications: createDefaultNotificationPort(db),
    drive: createDefaultDrivePort(db),
    roles: createDefaultRolePort(db),
  };
}

export type { FsTimestamp };
