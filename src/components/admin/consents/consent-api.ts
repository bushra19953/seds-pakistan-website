// Shared client helpers for the Founder Consent admin UI.
// All data flows through the Section A.7 APIs (never direct client
// Firestore reads), authenticated with the Firebase ID token.

export async function consentApi<T = any>(
  getToken: () => Promise<string>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`) as Error & {
      code?: string;
      status?: number;
      fields?: Record<string, string>;
    };
    err.code = data?.code;
    err.status = res.status;
    err.fields = data?.fields;
    throw err;
  }
  return data as T;
}

// Dates arrive from the API as ISO strings or Firestore Timestamp JSON
// ({ _seconds, _nanoseconds } / { seconds, nanoseconds }).
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const v = value as Record<string, unknown>;
  const seconds =
    (typeof v._seconds === 'number' ? v._seconds : undefined) ??
    (typeof v.seconds === 'number' ? v.seconds : undefined);
  if (typeof seconds === 'number') return new Date(seconds * 1000);
  return null;
}

export function fmtDate(value: unknown): string {
  const d = toDate(value);
  if (!d) return '-';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function daysLeft(value: unknown, now = new Date()): number | null {
  const d = toDate(value);
  if (!d) return null;
  return Math.ceil((d.getTime() - now.getTime()) / (24 * 3600 * 1000));
}

// ---------------------------------------------------------------------------
// Detail-view shape normalization.
//
// The stored/API record shape is FLAT: `decision` is the decision string
// itself ('consent_given' | 'consent_refused' | 'conditional_consent'), and
// decisionDate / conditions / consentedScope / refusedScope / decisionNote /
// founderSignatureMarker sit beside it at the top level. History entries are
// stored as { event, actorUid, actorRoleKey, fromStatus, toStatus, note,
// createdAt }. The detail page was written against a nested-decision /
// { action, at, actorName } shape that no writer produces: reading
// record.decision.decision silently rendered blanks, and calling
// h.action.replace(...) on a real history entry threw during render and
// crashed the page into the error boundary for every consent. These
// normalizers accept the real flat shape (and a nested decision object, if
// one ever appears) and never throw on a missing field.
// ---------------------------------------------------------------------------

export interface ConsentDecisionView {
  decision: string;
  decisionDate: unknown;
  conditions: string | null;
  consentedScope: string | null;
  refusedScope: string | null;
  decisionNote: string | null;
  founderSignatureMarker: string | null;
}

export function consentDecisionOf(record: any): ConsentDecisionView | null {
  if (!record) return null;
  const d = record.decision;
  if (d && typeof d === 'object') {
    return {
      decision: typeof d.decision === 'string' ? d.decision : '',
      decisionDate: d.decisionDate ?? null,
      conditions: d.conditions ?? null,
      consentedScope: d.consentedScope ?? null,
      refusedScope: d.refusedScope ?? null,
      decisionNote: d.decisionNote ?? null,
      founderSignatureMarker: d.founderSignatureMarker ?? null,
    };
  }
  if (typeof d === 'string' && d) {
    return {
      decision: d,
      decisionDate: record.decisionDate ?? null,
      conditions: record.conditions ?? null,
      consentedScope: record.consentedScope ?? null,
      refusedScope: record.refusedScope ?? null,
      decisionNote: record.decisionNote ?? null,
      founderSignatureMarker: record.founderSignatureMarker ?? null,
    };
  }
  return null;
}

export interface ConsentHistoryView {
  label: string;
  at: unknown;
  actor: string | null;
  note: string | null;
}

export function consentHistoryOf(record: any): ConsentHistoryView[] {
  const raw = Array.isArray(record?.history) ? record.history : [];
  return raw.map((h: any) => ({
    label: String(h?.event ?? h?.action ?? '').replace(/_/g, ' '),
    at: h?.createdAt ?? h?.at ?? null,
    actor: (h?.actorName ?? h?.actorUid) ?? null,
    note: typeof h?.note === 'string' ? h.note : null,
  }));
}

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending: 'Pending',
  further_information_requested: 'Further information requested',
  consented: 'Consented',
  refused: 'Refused',
  conditional: 'Conditional consent',
  waived: 'Waived',
  deemed_withheld: 'Deemed withheld',
  executed: 'Executed',
  cancelled: 'Cancelled',
};
