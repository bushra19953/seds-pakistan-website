/**
 * Returns page tests (PLAN-gd Section 12, file C26): spec test C6.
 * The real server helper runs against the fake Firestore; only the
 * Admin SDK boundary is mocked.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { createFakeFirestore, type FakeFirestore } from '@/lib/finance/__tests__/fake-firestore';

const holder: { db: FakeFirestore | null } = { db: null };

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'unused' }) }),
    firestore: { FieldValue: { serverTimestamp: () => new Date() } },
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => holder.db,
}));

import ReturnsPage from '@/app/store/returns/page';

async function renderReturns() {
  const ui = await ReturnsPage();
  return render(ui as React.ReactElement);
}

describe('/store/returns page (GD)', () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = createFakeFirestore() as never;
    holder.db = db;
  });

  it('C6: names the active vendor as the seller', async () => {
    db.__seed('vendors', 'vendor-1', {
      businessName: 'Test Seller',
      status: 'active',
      agreementStatus: 'signed',
    });
    const { container } = await renderReturns();
    expect(container.textContent).toContain('The seller is Test Seller.');
  });

  it('C6: states the 7 day defective or wrong item rule with seller paid return courier', async () => {
    const { container } = await renderReturns();
    expect(container.textContent).toContain('within 7 days of your claim');
    expect(container.textContent).toContain('seller pays the cost of the return courier');
    expect(container.textContent).toContain('replace it or refund you in full');
  });

  it('C6: states that change of mind returns are not accepted', async () => {
    const { container } = await renderReturns();
    expect(container.textContent).toContain(
      'Returns for a change of mind are not accepted during this pilot.',
    );
  });

  it('C6: states the full refund rule for a group buy team that does not complete', async () => {
    const { container } = await renderReturns();
    expect(container.textContent).toContain(
      'If a group buy team does not complete within its time window, every paid member is refunded in full.',
    );
  });

  it('C6: states the store credit rule for late group delivery', async () => {
    const { container } = await renderReturns();
    expect(container.textContent).toContain(
      'If a group buy order arrives after its promised delivery date, the buyer earns store credit.',
    );
  });

  it('C6: with no vendor record it uses the generic seller wording and still states all four rules', async () => {
    const { container } = await renderReturns();
    expect(container.textContent).toContain(
      'The seller is the business named on each product page.',
    );
    expect(container.textContent).toContain('within 7 days of your claim');
    expect(container.textContent).toContain('change of mind are not accepted');
    expect(container.textContent).toContain('every paid member is refunded in full');
    expect(container.textContent).toContain('the buyer earns store credit');
  });
});
