/**
 * @jest-environment node
 *
 * GE checkout pins (PLAN-ge 11.4): static source pins in the house
 * pattern of checkout-idempotency.test.ts. The live behaviour is
 * proven by the writer suites; these pins stop a later edit from
 * silently un-scoping the vendor treatment.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../page.tsx'), 'utf8');
const settingsSrc = readFileSync(
  join(__dirname, '../../admin/store/components/certificate-settings.tsx'),
  'utf8',
);

describe('checkout vendor treatment (GE)', () => {
  it('vendor totals: Subtotal, Delivery and Store credit lines; submit claims goods + delivery', () => {
    expect(src).toContain('Subtotal');
    expect(src).toContain('Delivery');
    expect(src).toContain('Store credit');
    expect(src).toContain('-PKR {creditAppliedPkr.toLocaleString()}');
    expect(src).toContain('total: isVendorProduct ? orderTotalPkr : total');
    expect(src).toContain('const transferDuePkr = orderTotalPkr - creditAppliedPkr');
  });

  it('payment scoping: vendor branch filters by shopMethodKey and fails loud when unset', () => {
    expect(src).toContain('shopMethodKey');
    expect(src).toContain('enabledMethods.filter(m => m.key === methodSettings.shopMethodKey)');
    expect(src).toContain('Shop payments are not open yet');
    expect(src).toContain('We cannot take shop orders right now because the shop payment account is not set up. Please try again later.');
    expect(src).toContain('disabled={isSubmitting || !receipt || vendorPaymentBlocked}');
  });

  it('admin control: the payment-methods settings UI can set and clear shopMethodKey (R-4)', () => {
    expect(settingsSrc).toContain('shopMethodKey: string | null');
    expect(settingsSrc).toContain('shopMethodKey: null');
    expect(settingsSrc).toContain('Shop checkout payment method');
    expect(settingsSrc).toContain('Not configured');
  });

  it('O1 pin: the receipt requirement is unchanged, vendor branch included', () => {
    expect(src).toContain("if (!receipt) return 'Please upload your payment receipt screenshot.'");
    expect(src).toContain('disabled={isSubmitting || !receipt || vendorPaymentBlocked}');
  });

  it('stock: a vendor product at stock 0 swaps the payment and submit cards for the stock alert', () => {
    expect(src).toContain('This product is out of stock.');
    expect(src).toContain('vendorOutOfStock');
  });

  it('carry: groupBuyId is read from the URL and sent in the order input', () => {
    expect(src).toContain("searchParams.get('groupBuyId')");
    expect(src).toContain('groupBuyId: isVendorProduct ? (groupBuyIdParam || undefined) : undefined');
  });

  it('confirmation: the not-found question is verbatim, stored via the action, and pauses the countdown', () => {
    expect(src).toContain('What did you come here to buy that you did not find?');
    expect(src).toContain('Tell us what you were looking for.');
    expect(src).toContain('Thanks. We will look into stocking it.');
    expect(src).toContain('submitNotFoundText({ orderId, userId: userId || \'\', text: notFoundText })');
    expect(src).toContain('if (notFoundPause) return;');
    expect(src).toContain('/store/returns');
  });

  it('analytics: checkout_start and order_created fire through the GC helper, vendor only', () => {
    expect(src).toContain("from '@/lib/client/commerce-analytics'");
    expect(src).toContain("trackCommerceEvent('checkout_start', product.id)");
    expect(src).toContain("trackCommerceEvent('order_created', product.id)");
  });
});
