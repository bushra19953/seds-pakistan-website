/**
 * DEFECT 3 regression suite: event settlement sales computation.
 *
 * Proven live fact (2026-10-26 founder retest): the EV2 PAID TEST event
 * has a confirmed, payment-verified registration of PKR 500, yet the
 * Settlement tab ("25/75 Venue Profit Split Ledger") showed all zeros
 * and manual entry fields — the stored profitSettlement doc is only
 * ever written from the panel's own manual inputs, and nothing ever
 * computed figures from actual sales.
 *
 * These tests pin the computation that fixes it:
 *  - A "sale" is a registration in events/{id}/registrations with
 *    status 'confirmed' AND paymentStatus 'verified' — the same pair
 *    the attendees panel requires before it will issue a ticket.
 *  - Gross revenue is the SUM of actual sale amounts: the
 *    registration's own `amount` (paid route), else the linked store
 *    order's total (orderTotalPkr, resolved by the caller from the
 *    registration's orderId — the store checkout mirror writes no
 *    amount on the registration), else the event's base ticket price.
 *  - Base price comes from the event doc (paymentDetails.amount);
 *    capacity from the event doc (capacity, falling back to
 *    max_attendees, as the event detail page reads it).
 *
 * On base f7885fa0 this module does not exist, so the suite fails.
 */

import {
  isVerifiedSale,
  registrationSaleAmount,
  computeSettlementSales,
  eventBaseTicketPrice,
  eventCapacity,
} from '../settlement-sales';
import { venueShare, sedsSurplus } from '../venue-calculator';

describe('isVerifiedSale: confirmed + payment-verified only', () => {
  it('accepts the EV2 shape: confirmed seat, verified payment', () => {
    expect(isVerifiedSale({ status: 'confirmed', paymentStatus: 'verified' })).toBe(true);
  });

  it.each([
    [{ status: 'pending', paymentStatus: 'verified' }, 'seat not confirmed'],
    [{ status: 'under_review', paymentStatus: 'pending' }, 'paid route initial state'],
    [{ status: 'confirmed', paymentStatus: 'unpaid' }, 'payment not verified'],
    [{ status: 'confirmed', paymentStatus: 'pending' }, 'payment awaiting verification'],
    [{ status: 'confirmed', paymentStatus: 'refunded' }, 'refunded'],
    [{ status: 'cancelled', paymentStatus: 'verified' }, 'cancelled'],
    [{}, 'missing fields'],
    [null, 'null registration'],
  ])('rejects %o (%s)', (reg, _why) => {
    expect(isVerifiedSale(reg as any)).toBe(false);
  });
});

describe('computeSettlementSales', () => {
  it('EV2 PAID TEST fixture: one confirmed+verified PKR 500 sale is no longer zero', () => {
    // The store checkout mirror writes this registration shape: no
    // amount on the registration; the amount lives on the linked
    // order, resolved by the caller into orderTotalPkr.
    const sales = computeSettlementSales(
      [{ status: 'confirmed', paymentStatus: 'verified', orderId: 'ord-1', orderTotalPkr: 500 }],
      500,
    );
    expect(sales.grossTicketCount).toBe(1);
    expect(sales.grossRevenue).toBe(500);
    // The 25/75 split inputs stop being zero.
    expect(venueShare(sales.grossRevenue)).toBe(125);
    expect(sedsSurplus(sales.grossRevenue)).toBe(375);
  });

  it('sums actual amounts across sales and excludes every non-sale', () => {
    const sales = computeSettlementSales(
      [
        { status: 'confirmed', paymentStatus: 'verified', amount: 500 },
        { status: 'confirmed', paymentStatus: 'verified', amount: 750 },
        { status: 'pending', paymentStatus: 'verified', amount: 500 },
        { status: 'confirmed', paymentStatus: 'unpaid', amount: 500 },
        { status: 'cancelled', paymentStatus: 'verified', amount: 500 },
        { status: 'under_review', paymentStatus: 'pending', amount: 500 },
      ],
      500,
    );
    expect(sales.grossTicketCount).toBe(2);
    expect(sales.grossRevenue).toBe(1250);
  });

  it('falls back to the event base price when a sale carries no amount anywhere', () => {
    const sales = computeSettlementSales(
      [{ status: 'confirmed', paymentStatus: 'verified' }],
      800,
    );
    expect(sales.grossTicketCount).toBe(1);
    expect(sales.grossRevenue).toBe(800);
  });

  it('no sales means zero, not the old manual defaults leaking through', () => {
    expect(computeSettlementSales([], 500)).toEqual({ grossTicketCount: 0, grossRevenue: 0 });
    expect(computeSettlementSales(undefined, 500)).toEqual({ grossTicketCount: 0, grossRevenue: 0 });
  });

  it('registrationSaleAmount prefers the registration amount, then the order total, then base price', () => {
    expect(registrationSaleAmount({ amount: 600, orderTotalPkr: 500 }, 500)).toBe(600);
    expect(registrationSaleAmount({ orderTotalPkr: 550 }, 500)).toBe(550);
    expect(registrationSaleAmount({ totalPkr: 525 }, 500)).toBe(525);
    expect(registrationSaleAmount({ amount: 'abc' }, 500)).toBe(500);
    expect(registrationSaleAmount({}, 500)).toBe(500);
    expect(registrationSaleAmount({}, 0)).toBe(0);
  });
});

describe('event doc derivations', () => {
  it('base price comes from paymentDetails.amount (the field the event form and detail page use)', () => {
    expect(eventBaseTicketPrice({ paymentDetails: { isPaid: true, amount: 500 } })).toBe(500);
    expect(eventBaseTicketPrice({ paymentDetails: { isPaid: true, amount: 0 } })).toBe(0);
    expect(eventBaseTicketPrice({})).toBe(0);
    expect(eventBaseTicketPrice(null)).toBe(0);
  });

  it('capacity comes from capacity, falling back to max_attendees (detail page rule)', () => {
    expect(eventCapacity({ capacity: 100 })).toBe(100);
    expect(eventCapacity({ max_attendees: 250 })).toBe(250);
    expect(eventCapacity({ capacity: 100, max_attendees: 250 })).toBe(100);
    expect(eventCapacity({})).toBe(0);
  });
});
