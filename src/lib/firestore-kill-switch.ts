/**
 * FIRESTORE DATA KILL-SWITCH (W5 decommission, OPTION A cutover).
 *
 * A single env-gated hard disable for Firestore DATA paths. It exists to
 * PROVE which surfaces still depend on Firestore: flip it on in a test /
 * staging environment and every remaining Firestore data read or write
 * fails loudly with a named error, while genuinely Supa-only surfaces
 * keep working untouched. It is NOT a production convenience switch —
 * flipping it in production before the burn-down census in
 * `cutover-sections/w5-decommission.md` reaches zero non-exempt,
 * non-inverted references will break those surfaces, by design.
 *
 * Flag:
 *   FIRESTORE_DATA_DISABLED=1            (server)
 *   NEXT_PUBLIC_FIRESTORE_DATA_DISABLED=1 (client twin; must be baked
 *                                          at build time, like every
 *                                          other NEXT_PUBLIC_* twin in
 *                                          this program)
 *
 * Accepted ON values (case-insensitive, trimmed): 1, true, yes, on.
 * Anything else — including unset and empty — is OFF.
 *
 * OFF IS BYTE-IDENTICAL: with the flag unset, `isFirestoreDataDisabled()`
 * is false, `assertFirestoreDataEnabled()` is a no-op, and every gated
 * boundary returns / uses the exact object it used before this module
 * existed. No behaviour, timing, or error shape changes on the OFF path.
 *
 * EXEMPT BY DESIGN (never gated, in either state):
 *   - Firebase Auth, client and Admin (`getAuth`, `admin.auth()`,
 *     `verifyIdToken`, `__session` handling, custom claims). Auth stays
 *     fully live; the cutover is a DATA cutover only.
 *   - Firebase Storage (`getStorage`, `admin.storage()`) — not a
 *     Firestore data path.
 *   - Firebase Functions / Analytics / Performance handles in
 *     `src/firebase/core.ts` — not Firestore data paths.
 *   - `getAdminDiagnostics()` — read-only init metadata, no data access.
 *
 * Gated boundaries (the census's kill-switch points):
 *   - Server: `getDb()` and `ensureAdminInitialized()` in
 *     `src/lib/server/firebase-admin.ts` (235 importers at census time)
 *     throw `FirestoreDataDisabledError` instead of returning a db.
 *   - Client: `src/firebase/core.ts` exports a throwing proxy in place
 *     of the Firestore instance, and the write wrappers in
 *     `src/lib/client/firestore-wrapper.ts` (72 importers at census
 *     time) assert the gate at call time.
 *
 * Direct SDK users that bypass both boundaries (a component importing
 * `firebase/firestore` and a self-made reference) are exactly the
 * residue the burn-down census names; the switch does not pretend to
 * intercept them — it proves them by the surfaces that break.
 */

export const FIRESTORE_DATA_DISABLED_CODE = 'firestore-data-disabled';

const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);

function envFlagOn(raw: string | undefined): boolean {
  if (!raw) return false;
  return ON_VALUES.has(raw.trim().toLowerCase());
}

/**
 * True when Firestore data access is disabled. Reads, in order, the
 * server var `FIRESTORE_DATA_DISABLED` and the client twin
 * `NEXT_PUBLIC_FIRESTORE_DATA_DISABLED`; either one being ON disables.
 * On the client bundle only the NEXT_PUBLIC_ var is inlined (the server
 * var reads as undefined there); on the server both are visible.
 * `env` is injectable for contracts.
 */
export function isFirestoreDataDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    envFlagOn(env.FIRESTORE_DATA_DISABLED) ||
    envFlagOn(env.NEXT_PUBLIC_FIRESTORE_DATA_DISABLED)
  );
}

/** Loud, named error thrown by every gated Firestore data boundary. */
export class FirestoreDataDisabledError extends Error {
  readonly code = FIRESTORE_DATA_DISABLED_CODE;
  readonly operation: string;

  constructor(operation = 'firestore-data') {
    super(
      `Firestore data access is disabled (FIRESTORE_DATA_DISABLED is set): ` +
        `blocked operation "${operation}". This surface still depends on ` +
        `Firestore; a Supa-only surface would not reach this boundary. ` +
        `Firebase Auth is unaffected.`,
    );
    this.name = 'FirestoreDataDisabledError';
    this.operation = operation;
  }
}

/** No-op when OFF; throws `FirestoreDataDisabledError` when ON. */
export function assertFirestoreDataEnabled(operation = 'firestore-data'): void {
  if (isFirestoreDataDisabled()) {
    throw new FirestoreDataDisabledError(operation);
  }
}

/** Type guard for the kill-switch error (works across realms/copies). */
export function isFirestoreDataDisabledError(error: unknown): boolean {
  return (
    error instanceof FirestoreDataDisabledError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'FirestoreDataDisabledError' &&
      (error as { code?: unknown }).code === FIRESTORE_DATA_DISABLED_CODE)
  );
}

/**
 * A stand-in for the client Firestore instance when the switch is ON:
 * any property access or call throws `FirestoreDataDisabledError`, so a
 * data path fails at its first touch — never silently, never with an
 * empty result. Symbol access (inspection, promise checks) does not
 * throw, so the proxy can sit in contexts / props without breaking
 * unrelated machinery before a data path actually uses it.
 */
export function createDisabledFirestoreProxy<T extends object = object>(
  operation = 'client:firestore-instance',
): T {
  const throwDisabled = (): never => {
    throw new FirestoreDataDisabledError(operation);
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') {
          return prop === Symbol.toStringTag ? 'FirestoreDataDisabled' : undefined;
        }
        if (prop === 'then') return undefined; // not a thenable
        return throwDisabled();
      },
      set: throwDisabled,
      deleteProperty: throwDisabled,
      apply: throwDisabled,
      construct: throwDisabled,
      has: throwDisabled,
      ownKeys: throwDisabled,
      getOwnPropertyDescriptor: throwDisabled,
    },
  ) as T;
}
