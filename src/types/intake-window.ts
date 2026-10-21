import type { Timestamp } from 'firebase/firestore';

/**
 * Intake windows as data (Workstream E, spec sections 4.1-4.4).
 *
 * Storage shapes use Firestore Timestamp fields. The plain serialisable
 * IntakeWindowLike shape is what the pure resolver in
 * src/lib/intake-windows/resolve.ts operates on, so client, server, and
 * tests share one implementation with no Firebase imports.
 */

export type IntakeWindowKind =
  | 'induction'
  | 'chapter_application'
  | 'drive'
  | 'other';

/**
 * Derived window state. 'cancelled' comes from storedStatus; every other
 * state is derived from the clock (spec 4.3). 'none' is the resolution
 * result when no window of a kind resolves (fail-safe case, spec 6.3);
 * it is never the state of an individual window.
 */
export type DerivedWindowState =
  | 'cancelled'
  | 'scheduled'
  | 'open'
  | 'closed'
  | 'none';

/** State mirrored into intake_config/current: never 'cancelled'. */
export type MirroredWindowState = 'open' | 'scheduled' | 'closed' | 'none';

export type IntakeWindowSource = 'manual' | 'recurrence';

/** Spec 4.1: one doc per window in collection intake_windows. */
export interface IntakeWindow {
  /** Equals the doc id. Duplicated inside the doc for queries/exports. */
  windowId: string;
  /** Display name, required, 3 to 120 chars. */
  label: string;
  kind: IntakeWindowKind;
  /** UTC instant stored as a Firestore Timestamp. */
  opensAt: Timestamp;
  /** UTC instant stored as a Firestore Timestamp. Must be after opensAt. */
  closesAt: Timestamp;
  /** Must equal the literal 'Asia/Karachi' in v1. */
  timezone: string;
  /** Optional financial year tag, e.g. '2026-27'. */
  fyLabel?: string;
  /** Explicit override flag. At most one non-cancelled window per kind. */
  isDefault: boolean;
  /** ONLY 'cancelled' is ever stored. Absent/null means not cancelled. */
  storedStatus?: 'cancelled' | null;
  /** Required when storedStatus is 'cancelled'. */
  cancelReason?: string;
  cancelledBy?: string;
  cancelledAt?: Timestamp;
  source: IntakeWindowSource;
  /** Set when source is 'recurrence' (spec 4.4); null for manual windows. */
  templateId: string | null;
  /** Admin-only context, max 1000 chars. Never returned publicly. */
  notes?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Spec 4.2: singleton doc intake_config/current. */
export interface IntakeConfig {
  /** windowId of the resolved kind=induction window at mirror time. */
  currentInductionWindowId: string | null;
  currentInductionOpensAt: Timestamp | null;
  /** The field the rules predicate compares request.time against. */
  currentInductionClosesAt: Timestamp | null;
  /** Diagnostic only; rules never trust it, they compare times. */
  currentInductionState: MirroredWindowState;
  /** Server-side enforcement toggle. OFF at launch; preserved by mirrors. */
  enforcementEnabled: boolean;
  /** Server timestamp of the last mirror write. */
  mirrorUpdatedAt: Timestamp;
  /** uid of the admin whose write triggered the mirror, or 'system'. */
  mirrorUpdatedBy: string;
  /** The resolved window's updatedAt at mirror time (mirror health). */
  mirrorSourceUpdatedAt: Timestamp | null;
  /** Increments on every mirror write. */
  mirrorVersion: number;
}

/**
 * How a template's fyLabel is derived: the FY containing the opens date
 * (1 Aug 2027 sits in FY 2027-28).
 */
export type IntakeTemplateFyLabelMode = 'opens-year';

/** Spec 4.4: one doc per recurring shape in intake_window_templates. */
export interface IntakeWindowTemplate {
  /** Doc id, e.g. 'drive-annual-august'. */
  templateId: string;
  kind: IntakeWindowKind;
  /** e.g. "Annual Intake Drive, {fy}". */
  labelTemplate: string;
  /** 'MM-DD', e.g. '08-01' for the 1 August annual drive. */
  opensMonthDay: string;
  /** int, 1 to 120. closesAt = opensAt + durationDays days. */
  durationDays: number;
  timezone: string;
  fyLabelMode: IntakeTemplateFyLabelMode;
  /** Inert until activated. Creating a template creates no window. */
  active: boolean;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Plain serialisable window shape used by the pure resolver.
 * Times are epoch milliseconds. `label` is optional so resolver inputs
 * built from minimal fixtures stay valid; toPublicWindow falls back to
 * null when it is absent.
 */
export interface IntakeWindowLike {
  windowId: string;
  kind: IntakeWindowKind;
  opensAtMs: number;
  closesAtMs: number;
  isDefault: boolean;
  storedStatus?: 'cancelled' | string | null;
  createdAtMs: number;
  label?: string | null;
}

/** A resolved window: the picked IntakeWindowLike plus its derived state. */
export type ResolvedIntakeWindow = IntakeWindowLike & {
  state: DerivedWindowState;
};

/**
 * Public projection returned by GET /api/public/intake-window (spec 5.3).
 * All instants are ISO strings. Null fields carry the no-window payload:
 * the route returns state 'closed' with windowId null in that case.
 */
export interface PublicIntakeWindow {
  windowId: string | null;
  label: string | null;
  kind: IntakeWindowKind;
  opensAt: string | null;
  closesAt: string | null;
  state: DerivedWindowState;
  isDefault: boolean;
  serverNow: string;
}
