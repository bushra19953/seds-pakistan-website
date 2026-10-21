'use client';

/**
 * Profile nav entry for office obligations (phase2_spec.md G.7): shown
 * ONLY when the caller holds an office that has compliance instances -
 * everyone else never sees the entry. Data comes from /api/compliance/
 * mine, which resolves the caller's office server-side.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { ShieldCheck } from 'lucide-react';

export function OfficeObligationsLink() {
  const { user } = useUser();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/compliance/mine', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setCount(Array.isArray(body.obligations) ? body.obligations.length : 0);
      } catch {
        // The entry simply stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || count === 0) return null;
  return (
    <Link href="/profile/compliance">
      <Button variant="outline" size="sm" className="gap-1.5 w-full">
        <ShieldCheck className="h-3.5 w-3.5" /> Office obligations ({count})
      </Button>
    </Link>
  );
}
