// Venue profit split calculator (Section 7.2.1: 25/75 venue economics).
// Pure functions only: no I/O, no Firestore, safe to use in any context.

export const VENUE_SHARE_RATIO = 0.25;
export const SEDS_RETAINED_RATIO = 0.75;
export const COMPLIMENTARY_CAP_RATIO = 0.1;

export interface VenueEconomicsInput {
  grossTicketCount: number;
  ticketPrice: number;
  capacity: number;
  complimentaryCount: number;
}

export interface VenueEconomicsResult {
  grossRevenue: number;
  venueShare: number;
  sedsSurplus: number;
  complimentaryCapExceeded: boolean;
  maxComplimentaryAllowed: number;
}

// Gross Revenue = grossTicketCount * ticketPrice
export function grossRevenue(grossTicketCount: number, ticketPrice: number): number {
  if (!Number.isFinite(grossTicketCount) || !Number.isFinite(ticketPrice)) return 0;
  if (grossTicketCount < 0 || ticketPrice < 0) return 0;
  return grossTicketCount * ticketPrice;
}

// Venue 25% Share: facility cost bundle (AV, staging, banquet dining,
// security, setup/teardown, parking).
export function venueShare(revenue: number): number {
  if (!Number.isFinite(revenue) || revenue < 0) return 0;
  return revenue * VENUE_SHARE_RATIO;
}

// SEDS 75% Retained Surplus: collegiate rocketry grants and operational reserve.
export function sedsSurplus(revenue: number): number {
  if (!Number.isFinite(revenue) || revenue < 0) return 0;
  return revenue * SEDS_RETAINED_RATIO;
}

// Flag error when complimentary passes exceed 10% of total venue capacity.
export function complimentaryCapCheck(complimentaryCount: number, capacity: number): boolean {
  if (!Number.isFinite(complimentaryCount) || !Number.isFinite(capacity)) return false;
  if (capacity <= 0) return complimentaryCount > 0;
  return complimentaryCount > capacity * COMPLIMENTARY_CAP_RATIO;
}

export function maxComplimentaryAllowed(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  return Math.floor(capacity * COMPLIMENTARY_CAP_RATIO);
}

export function computeVenueEconomics(input: VenueEconomicsInput): VenueEconomicsResult {
  const revenue = grossRevenue(input.grossTicketCount, input.ticketPrice);
  return {
    grossRevenue: revenue,
    venueShare: venueShare(revenue),
    sedsSurplus: sedsSurplus(revenue),
    complimentaryCapExceeded: complimentaryCapCheck(input.complimentaryCount, input.capacity),
    maxComplimentaryAllowed: maxComplimentaryAllowed(input.capacity),
  };
}

export function formatPKR(amount: number): string {
  return "PKR " + Math.round(amount).toLocaleString("en-PK");
}
