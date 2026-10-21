/**
 * Consents reader (ws-a §3.9; Meetings Core contract §6) — server only.
 *
 * READ-ONLY accessor for the Phase 2 Founder Consent system
 * (`consent_requests`). This workstream never creates, decides, or expires a
 * Consent (non-goal N4). The Board emergency-meeting gate and the circular
 * pre-circulation gate both depend on `isDecidedConsent`: true ONLY for
 * status granted or conditional. A pending, refused, or expired Consent never
 * satisfies any gate.
 *
 * ADAPTER (store): persistence goes through the `ConsentsClient` interface.
 * `InMemoryConsentsClient` implements it for local tests. A Firestore
 * implementation maps getConsent -> doc get on `consent_requests`,
 * listConsentsForMeeting -> a query on the meeting link field.
 */

export type ConsentStatus = "pending" | "granted" | "refused" | "conditional" | "expired";

/** Read view of a consent_requests doc — the fields Workstream A relies on. */
export interface ConsentView {
  id: string;
  status: ConsentStatus;
  matter: string;
  proposedAct: string;
  decidedAt: Date | null;
  decidedBy: string;
  /**
   * ADAPTER: the meeting link used by listConsentsForMeeting. ws-a §3.9 does
   * not name the field on consent_requests; if Phase 2 links consents to
   * meetings differently (e.g. via the meeting's consentId only), this field
   * is dropped and listConsentsForMeeting is re-pointed at the meeting doc.
   */
  meetingId?: string | null;
}

/** True ONLY for granted and conditional (ws-a §3.9). Pure. */
export function isDecidedConsentStatus(status: ConsentStatus): boolean {
  return status === "granted" || status === "conditional";
}

export interface ConsentsClient {
  getConsent(id: string): Promise<ConsentView | null>;
  /** True only when the consent exists AND is granted or conditional. */
  isDecidedConsent(id: string): Promise<boolean>;
  listConsentsForMeeting(meetingId: string): Promise<ConsentView[]>;
}

/** In-memory implementation for local tests. */
export class InMemoryConsentsClient implements ConsentsClient {
  constructor(private consents: ConsentView[] = []) {}

  add(consent: ConsentView): void {
    this.consents.push(consent);
  }

  async getConsent(id: string): Promise<ConsentView | null> {
    return this.consents.find((c) => c.id === id) ?? null;
  }

  async isDecidedConsent(id: string): Promise<boolean> {
    const consent = await this.getConsent(id);
    return consent !== null && isDecidedConsentStatus(consent.status);
  }

  async listConsentsForMeeting(meetingId: string): Promise<ConsentView[]> {
    return this.consents.filter((c) => c.meetingId === meetingId);
  }
}
