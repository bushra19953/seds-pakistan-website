// Returns policy page (PLAN-gd Section 9). Server Component.
// Reads per request: 1 vendors query (seller name) + 1 settings get
// (the optional public claims WhatsApp number). The seller name comes
// from the vendor record server side; when no vendor exists yet the
// generic wording renders. The vendor's admin-tier phone is never
// read for this page, and no number is ever invented: the claims
// number prints only when a founder has set
// settings/siteWide.storeClaimsWhatsapp.

import Link from 'next/link';
import { getDb } from '@/lib/server/firebase-admin';
import { getPilotSellerName } from '@/lib/server/store-catalogue';

export const dynamic = 'force-dynamic';

async function loadClaimsWhatsapp(): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const snap = await db.collection('settings').doc('siteWide').get();
  const value = snap.data()?.storeClaimsWhatsapp;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export default async function ReturnsPage() {
  const db = getDb();
  const sellerName = db ? await getPilotSellerName(db) : null;
  const claimsWhatsapp = await loadClaimsWhatsapp();
  const claimsDigits = claimsWhatsapp ? claimsWhatsapp.replace(/\D/g, '') : null;

  return (
    <main className="container mx-auto max-w-3xl px-4 py-10 md:px-6">
      <h1 className="text-3xl font-bold">Returns policy</h1>
      <p className="mt-4 text-muted-foreground">
        This page states the returns rules for the SEDS Pakistan store pilot.
      </p>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Who you buy from</h2>
        <p className="mt-2 text-muted-foreground">
          {sellerName
            ? `The seller is ${sellerName}. SEDS Pakistan runs the store and passes every claim to the seller.`
            : 'The seller is the business named on each product page. SEDS Pakistan runs the store and passes every claim to the seller.'}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Defective or wrong item</h2>
        <p className="mt-2 text-muted-foreground">
          If an item arrives defective, or the item you receive is not the item you
          ordered, the seller will replace it or refund you in full within 7 days of
          your claim. The seller pays the cost of the return courier.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Change of mind</h2>
        <p className="mt-2 text-muted-foreground">
          Returns for a change of mind are not accepted during this pilot.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">How to make a claim</h2>
        <p className="mt-2 text-muted-foreground">
          {claimsWhatsapp && claimsDigits ? (
            <>
              Send a WhatsApp message to{' '}
              <a href={`https://wa.me/${claimsDigits}`} className="underline">
                {claimsWhatsapp}
              </a>{' '}
              and quote your order id. Claims are handled through the platform refund
              approval process.
            </>
          ) : (
            'Send a WhatsApp message to the store team on the number printed on your order confirmation, and quote your order id. Claims are handled through the platform refund approval process.'
          )}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Group buys</h2>
        <p className="mt-2 text-muted-foreground">
          If a group buy team does not complete within its time window, every paid
          member is refunded in full.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Late delivery on group buys</h2>
        <p className="mt-2 text-muted-foreground">
          If a group buy order arrives after its promised delivery date, the buyer
          earns store credit. The credit amount follows the pilot store credit rule
          and appears at the buyer&apos;s next checkout.
        </p>
      </section>

      <p className="mt-12 text-sm">
        <Link href="/store" className="underline">
          Back to the store
        </Link>
      </p>
    </main>
  );
}
