'use client';

// Product page group buy block. GD renders this for eligible
// products only and passes the frozen slot props below; everything
// inside (auth, the create POST, routing) is GH's (PLAN-gh 5.8,
// slot props as frozen by GD).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';

export interface GroupBuyBlockProps {
  productId: string;
  productName: string;
  unitPricePkr: number;
  teamSize: number;
  windowHours: number;
}

export function GroupBuyBlock({
  productId,
  productName,
  unitPricePkr,
  teamSize,
  windowHours,
}: GroupBuyBlockProps) {
  const { user } = useUser();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startTeam() {
    if (!user) {
      router.push(`/login?redirect=${encodeURIComponent(`/store/${productId}`)}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/store/group-buys', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: <redacted>
        },
        body: JSON.stringify({ productId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { groupBuyId?: string; error?: string }
        | null;
      if (!res.ok || !data?.groupBuyId) {
        setError(data?.error ?? 'Could not start a team. Please try again.');
        setBusy(false);
        return;
      }
      router.push(`/checkout?productId=${productId}&groupBuyId=${data.groupBuyId}`);
    } catch {
      setError('Could not start a team. Please try again.');
      setBusy(false);
    }
  }

  return (
    <section aria-label={`Group buy for ${productName}`}>
      <h2>Buy together</h2>
      <p>
        Start a team of {teamSize}. Everyone pays the locked price of PKR {unitPricePkr}. Fill
        every seat within {windowHours} hours. If the team does not complete, every paid member
        is refunded in full.
      </p>
      <button type="button" onClick={startTeam} disabled={busy}>
        {user ? 'Start a team' : 'Sign in to start a team'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
