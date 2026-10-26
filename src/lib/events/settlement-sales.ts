/**
 * Settlement sales computation (DEFECT 3 fix).
 *
 * The 25/75 venue profit-split ledger used to take every figure from
 * the stored `profitSettlement` doc on the event — a doc that ONLY
 * the settlement panel's own manual form ever writes. Nothing in the
 * sales flow (registration, checkout, payment verification) touches
 * it, so a real sale never appeared in the ledger and the tab showed
 * zeros/manual fields forever.
 *
 * This module is the one definition of what the ledger's figures are
 * computed FROM. Pure functions only: no I/O. Callers (the computed
 * route) resolve linked records and pass plain data in.
 *
 * What counts as a sale: a registration in events/{id}/registrations
 * with status 'confirmed' AND paymentStatus 'verified'. Those are
 * the two fields the attendees panel maintains (Confirm Seat /
 * Verify Payment), and the same pair that gates ticket issuance
 * there — a registration that can be issued a ticket is a sale; one
 * that is pending, unpaid, refunded or cancelled is not.
 *
 * Sale amount, in priority order:
 *  1. the registration's own `amount` (written by the paid
 *     registration route);
 *  2. the linked store order's total (`totalPkr`, then `total`) —
 *     either carried on the registration or resolved by the caller
 *     from the registration's `orderId` into `orderTotalPkr` (the
 *     store checkout mirror writes an orderId but no amount);
 *  3. the event's base ticket price (single-price events: the sale
 *     price IS the base price).
 */

export interface SettlementRegistrationLike {
  status?: unknown;
  paymentStatus?: unknown;
  amount?: unknown;
  totalPkr?: unknown;
  total?: unknown;
  /** Linked store order total, resolved by the caller from orderId. */
  orderTotalPkr?: unknown;
  /** Linked store order id (written by the store checkout mirror). */
  orderId?: unknown;
}

export interface EventFiguresLike {
  capacity?: unknown;
  max_attendees?: unknown;
  paymentDetails?: { amount?: unknown; isPaid?: unknown } | null;
}

function positiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function nonNegativeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** True when a registration is a confirmed, payment-verified sale. */
export function isVerifiedSale(reg: SettlementRegistrationLike | null | undefined): boolean {
  if (!reg) return false;
  return reg.status === 'confirmed' && reg.paymentStatus === 'verified';
}

/** The amount one sale contributes to gross revenue (see header). */
export function registrationSaleAmount(
  reg: SettlementRegistrationLike | null | undefined,
  basePrice: number,
): number {
  if (!reg) return nonNegativeNumber(basePrice);
  return (
    positiveNumber(reg.amount) ||
    positiveNumber(reg.orderTotalPkr) ||
    positiveNumber(reg.totalPkr) ||
    positiveNumber(reg.total) ||
    nonNegativeNumber(basePrice)
  );
}

export interface SettlementSales {
  grossTicketCount: number;
  grossRevenue: number;
}

/** Count and revenue over exactly the verified sales in `registrations`. */
export function computeSettlementSales(
  registrations: readonly SettlementRegistrationLike[] | null | undefined,
  basePrice: number,
): SettlementSales {
  const sales = (registrations || []).filter(isVerifiedSale);
  return {
    grossTicketCount: sales.length,
    grossRevenue: sales.reduce((sum, reg) => sum + registrationSaleAmount(reg, basePrice), 0),
  };
}

/**
 * The event's base ticket price: paymentDetails.amount, the field the
 * event form writes and the event detail page displays. (The computed
 * route falls back to the linked store product's price when this is
 * 0; that needs an I/O read, so it does not live here.)
 */
export function eventBaseTicketPrice(event: EventFiguresLike | null | undefined): number {
  return positiveNumber(event?.paymentDetails?.amount);
}

/** Venue capacity from the event doc: capacity, else max_attendees —
 * the same fallback the event detail page applies. */
export function eventCapacity(event: EventFiguresLike | null | undefined): number {
  return nonNegativeNumber(event?.capacity) || nonNegativeNumber(event?.max_attendees);
}
