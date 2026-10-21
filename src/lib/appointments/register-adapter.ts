/**
 * Adapters to the Phase 1 / Phase 2 governance substrate (Workstream G).
 *
 * Phase 1 (registers, taxonomy) and Phase 2 (lifecycle) are parallel
 * builds. G consumes them through these providers ONLY, so when their
 * final stores land, the swap happens here and nowhere else in G.
 *
 * ADAPTER notes (each is a deliberate seam, listed in the crew report):
 * - ADAPTER (D-G2/D-G3): register records are read from the
 *   `roleHistory` collection as it exists today (the collection named
 *   in firestore.rules) and normalized: userId -> appointeeUid,
 *   role -> roleKey, startDate -> effectiveFrom, positions metadata
 *   display names -> snapshot name fields. When Phase 1 ships its
 *   authoritative Register of Roles store, point this reader at it.
 * - ADAPTER (D-G4): taxonomy entries are read from `role_taxonomy`
 *   docs ({ displayName, category, authorityReference,
 *   ratificationRequired, catalogReference, termEndsAt }). Until Phase
 *   1 populates that collection, every lookup misses and letter issue
 *   blocks with 422 role_not_in_taxonomy: G hard-codes NO role list.
 * - ADAPTER (D-G5 / F-G2 option b): no Phase 2 event hook exists yet,
 *   so lifecycle state is a read model: a stored `appointment_lifecycle`
 *   doc wins when present; otherwise the state is derived from the
 *   taxonomy flag (pending_ratification with the specced
 *   appointedAt + 30 days deadline, or not_required). G never flips
 *   states itself; instruments list/read paths refresh the mirror
 *   lazily (read-repair) from this provider.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type {
  LifecycleState,
  RegisterRecord,
  RoleTaxonomyEntry,
} from '@/types/appointment-instrument';

export const ROLE_HISTORY_COLLECTION = 'roleHistory';
export const ROLE_TAXONOMY_COLLECTION = 'role_taxonomy';
export const APPOINTMENT_LIFECYCLE_COLLECTION = 'appointment_lifecycle';

const RATIFICATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Timestamp-like -> epoch ms; 0 when unparseable. Local copy so this
 * workstream does not couple to another workstream's module. */
function toMs(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val === 'object') {
    const obj = val as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof obj.toMillis === 'function') {
      try {
        const ms = obj.toMillis();
        return Number.isFinite(ms) ? ms : 0;
      } catch {
        return 0;
      }
    }
    if (typeof obj.toDate === 'function') {
      try {
        const ms = obj.toDate().getTime();
        return Number.isFinite(ms) ? ms : 0;
      } catch {
        return 0;
      }
    }
    if (typeof obj.seconds === 'number') {
      return obj.seconds * 1000 + (obj.nanoseconds || 0) / 1000000;
    }
  }
  return 0;
}

function str(val: unknown): string | null {
  return typeof val === 'string' && val.trim() ? val : null;
}

export const registerRecordProvider = {
  /**
   * Load and normalize one register (role_history) record, or null when
   * it does not exist. Provenance fields are copied verbatim; this
   * provider never invents a missing value (the issue route blocks on
   * nulls with a named 422).
   */
  async getRegisterRecord(
    db: Firestore,
    roleHistoryId: string,
  ): Promise<RegisterRecord | null> {
    const snap = await db
      .collection(ROLE_HISTORY_COLLECTION)
      .doc(roleHistoryId)
      .get();
    if (!snap.exists) return null;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;

    const appointedAtMs = toMs(data.appointedAt ?? data.createdAt);
    const effectiveFromMs =
      toMs(data.effectiveFrom ?? data.startDate) || appointedAtMs;

    return {
      roleHistoryId,
      positionId: str(data.positionId) ?? str(data.position_id),
      appointeeUid: str(data.appointeeUid) ?? str(data.userId) ?? '',
      appointeeDisplayName:
        str(data.appointeeDisplayName) ??
        str(data.userDisplayName) ??
        str(metadata.userDisplayName),
      roleKey: str(data.roleKey) ?? str(data.role) ?? '',
      chapterId: str(data.chapterId),
      chapterName: str(data.chapterName) ?? str(metadata.chapterName),
      appointedByUid: str(data.appointedByUid) ?? str(data.appointedBy),
      appointedByDisplayName:
        str(data.appointedByDisplayName) ??
        str(metadata.appointedByDisplayName),
      appointedByOffice: str(data.appointedByOffice),
      authorityReference: str(data.authorityReference),
      appointedAtMs,
      effectiveFromMs,
      backdateReason: str(data.backdateReason),
    };
  },
};

export const taxonomyProvider = {
  /** ADAPTER (D-G4): read one taxonomy entry, or null when absent. */
  async getRoleTaxonomy(
    db: Firestore,
    roleKey: string,
  ): Promise<RoleTaxonomyEntry | null> {
    if (!roleKey) return null;
    const snap = await db
      .collection(ROLE_TAXONOMY_COLLECTION)
      .doc(roleKey)
      .get();
    if (!snap.exists) return null;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    return {
      roleKey,
      displayName: str(data.displayName) ?? roleKey,
      category: str(data.category) ?? 'D',
      appointedByOffice: str(data.appointedByOffice),
      authorityReference: str(data.authorityReference),
      ratificationRequired: data.ratificationRequired === true,
      catalogReference: str(data.catalogReference),
      termEndsAtMs: toMs(data.termEndsAt) || null,
    };
  },
};

export const lifecycleStateProvider = {
  /**
   * ADAPTER (D-G5 / F-G2 option b): the ratification read model.
   * A stored lifecycle doc wins; otherwise derive from the taxonomy
   * flag exactly as G.3.1 mirrors it (deadline = appointedAt + 30d).
   * This provider never writes anything.
   */
  async getLifecycleState(
    db: Firestore,
    input: {
      roleHistoryId: string;
      ratificationRequired: boolean;
      appointedAtMs: number;
    },
  ): Promise<LifecycleState> {
    try {
      const snap = await db
        .collection(APPOINTMENT_LIFECYCLE_COLLECTION)
        .doc(input.roleHistoryId)
        .get();
      if (snap.exists) {
        const data = (snap.data() ?? {}) as Record<string, unknown>;
        const rawState = str(data.state) ?? str(data.status);
        const known = [
          'not_required',
          'pending_ratification',
          'ratified',
          'deemed_ratified',
          'refused',
        ];
        if (rawState && known.includes(rawState)) {
          return {
            state: rawState as LifecycleState['state'],
            deadlineMs: toMs(data.deadline ?? data.ratificationDeadline) || null,
            decisionId: str(data.decisionId ?? data.ratificationDecisionId),
          };
        }
      }
    } catch {
      // Fall through to the derived model; a missing lifecycle store
      // must not break letter issue or list rendering.
    }
    if (!input.ratificationRequired) {
      return { state: 'not_required', deadlineMs: null, decisionId: null };
    }
    return {
      state: 'pending_ratification',
      deadlineMs: input.appointedAtMs
        ? input.appointedAtMs + RATIFICATION_WINDOW_MS
        : null,
      decisionId: null,
    };
  },
};
