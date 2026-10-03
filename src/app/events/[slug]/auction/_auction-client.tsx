'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useUser } from '@/firebase';
import { ShieldCheck, Factory, Gavel, ExternalLink } from 'lucide-react';
import { AUCTION_LOTS, type AuctionLot } from '@/types/auction';

/** Format a reserve price for display. */
function formatPrice(amount: number, currency: 'PKR' | 'USD'): string {
  return `${currency} ${amount.toLocaleString('en-US')}`;
}

/** Bid form for a single lot. Sign-in required to bid. */
function LotBidForm({ lot, eventId }: { lot: AuctionLot; eventId: string }) {
  const { user } = useUser();
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  async function onBid(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      toast({
        title: 'Sign in required',
        description: 'Please sign in before placing a bid.',
        variant: 'destructive',
      });
      return;
    }
    const bidAmount = Number(amount);
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      toast({ title: 'Invalid bid', description: 'Enter a positive bid amount.', variant: 'destructive' });
      return;
    }
    // Client-side guard: the server re-enforces the reserve floor.
    if (bidAmount < lot.reservePrice) {
      toast({
        title: 'Below reserve floor',
        description: `Bids must be at least ${formatPrice(lot.reservePrice, lot.currency)}.`,
        variant: 'destructive',
      });
      return;
    }
    setSubmitting(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/events/auction/bid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          eventId,
          lotId: lot.id,
          amount: bidAmount,
          bidderName: user.displayName || user.email || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          title: res.status === 400 ? 'Bid rejected' : 'Bid failed',
          description: data.error || 'Could not place your bid. Please try again.',
          variant: 'destructive',
        });
        return;
      }
      setAccepted(true);
      toast({
        title: 'Bid accepted',
        description: `Your bid of ${formatPrice(bidAmount, lot.currency)} was recorded (bid ${data.bidId}).`,
      });
    } catch {
      toast({ title: 'Bid failed', description: 'Network error. Please try again.', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  if (accepted) {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
        Bid recorded. Thank you for supporting collegiate rocketry.
      </div>
    );
  }

  return (
    <form onSubmit={onBid} className="flex items-end gap-2">
      <div className="flex-1">
        <label htmlFor={`bid-${lot.id}`} className="mb-1 block text-xs text-muted-foreground">
          Your bid (min {formatPrice(lot.reservePrice, lot.currency)})
        </label>
        <Input
          id={`bid-${lot.id}`}
          type="number"
          min={lot.reservePrice}
          step="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={String(lot.reservePrice)}
          className="bg-slate-900"
        />
      </div>
      <Button type="submit" disabled={submitting} className="shrink-0">
        <Gavel className="mr-2 h-4 w-4" />
        {submitting ? 'Placing...' : 'Place Bid'}
      </Button>
    </form>
  );
}

/** Catalog card for one donated lot. */
function LotCard({ lot, eventId }: { lot: AuctionLot; eventId: string }) {
  return (
    <Card className="flex flex-col border-slate-800 bg-slate-950">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg text-slate-100">{lot.title}</CardTitle>
          {lot.supplierBadge && (
            <Badge variant="secondary" className="shrink-0 border-sky-500/40 bg-sky-500/10 text-sky-300">
              <ShieldCheck className="mr-1 h-3 w-3" />
              Verified Supplier
            </Badge>
          )}
        </div>
        <CardDescription className="text-muted-foreground">{lot.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Factory className="h-4 w-4 text-muted-foreground" />
          <span>
            Donated by <span className="font-medium text-slate-100">{lot.donorFactory}</span>
            <span className="text-muted-foreground"> ({lot.donorLocation})</span>
          </span>
        </div>
        <div className="flex items-center justify-between rounded-md bg-slate-900 px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Reserve floor</span>
          <span className="font-semibold text-amber-300">{formatPrice(lot.reservePrice, lot.currency)}</span>
        </div>
        <Link
          href={lot.sourcingBridgeUrl}
          className="inline-flex items-center gap-1 text-sm text-sky-400 hover:text-sky-300"
        >
          View donor on SEDS Sourcing Bridge
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
        <div className="mt-auto border-t border-slate-800 pt-4">
          <LotBidForm lot={lot} eventId={eventId} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Hardware charity auction catalog for an event.
 * $0 COGS fiscal engine: every lot is donated, so accepted bids are
 * 100 percent net operating margin for SEDS Pakistan.
 */
export default function AuctionClient({ eventId }: { eventId: string }) {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-10 text-slate-200">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <Badge className="mb-3 border-amber-500/40 bg-amber-500/10 text-amber-300">
            <Gavel className="mr-1 h-3 w-3" />
            Charity Auction
          </Badge>
          <h1 className="text-3xl font-bold text-white sm:text-4xl">Hardware Charity Auction</h1>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            Bid on donated precision aerospace hardware. Every lot was donated at $0 cost, so
            100 percent of proceeds directly fund collegiate rocketry grants and the SEDS
            Pakistan operational reserve.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {AUCTION_LOTS.map((lot) => (
            <LotCard key={lot.id} lot={lot} eventId={eventId} />
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Bids below a lot&apos;s reserve price floor are automatically rejected. Sign in to bid.
        </p>
      </div>
    </div>
  );
}
