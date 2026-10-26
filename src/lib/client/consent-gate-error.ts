/**
 * Client-side consent-gate error contract (Phase 2, Workstream B - spec
 * B.2.4 / B.6). Every surface handles a gate 409 identically through these
 * helpers: routes return the 409 body, client data functions throw
 * ConsentGateBlocked, pages open ConsentRequiredDialog with err.body.
 */

export interface ConsentGateErrorBody {
  error: 'CONSENT_REQUIRED';
  code: 'CONSENT_REQUIRED';
  matter: string;
  reason: string;
  subject: unknown;
  consentRequestId: string | null;
  fileRequestUrl: string;
}

export class ConsentGateBlocked extends Error {
  body: ConsentGateErrorBody;

  constructor(body: ConsentGateErrorBody) {
    super(`Founder Consent required (${body.matter}: ${body.reason})`);
    this.name = 'ConsentGateBlocked';
    this.body = body;
  }
}

/**
 * Throws ConsentGateBlocked when the response is a consent-gate 409; returns
 * normally for any other status so callers can continue their usual handling.
 */
export async function parseConsentGateResponse(res: Response): Promise<void> {
  if (res.status !== 409) return;
  let body: ConsentGateErrorBody | null = null;
  try {
    body = (await res.clone().json()) as ConsentGateErrorBody;
  } catch {
    body = null;
  }
  if (body && body.code === 'CONSENT_REQUIRED') {
    throw new ConsentGateBlocked(body);
  }
  // A 409 that is not a consent-gate body is some other conflict; surface it
  // as a ConsentGateBlocked with a generic body so the dialog can still open.
  throw new ConsentGateBlocked({
    error: 'CONSENT_REQUIRED',
    code: 'CONSENT_REQUIRED',
    matter: 'unknown',
    reason: 'missing',
    subject: null,
    consentRequestId: null,
    fileRequestUrl: '/admin/consents/new',
  });
}

export function isConsentGateBlocked(e: unknown): e is ConsentGateBlocked {
  return e instanceof ConsentGateBlocked;
}
