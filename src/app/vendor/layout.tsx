'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { VendorNav } from './components/vendor-nav';
import { VENDOR_GATE_MESSAGE } from './components/use-vendor-api';

export default function VendorLayout({ children }: { children: ReactNode }) {
  const { user, isLoading: loading } = useUser();
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [gateBlocked, setGateBlocked] = useState(false);
  const [probeDone, setProbeDone] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await (user as { getIdToken: () => Promise<string> }).getIdToken();
        const res = await fetch('/api/vendor/balance', { headers: { Authorization: `Bearer ${token}` } });
        if (cancelled) return;
        if (res.status === 403) {
          setGateBlocked(true);
        } else if (res.ok) {
          const data = await res.json();
          setBusinessName(typeof data.businessName === 'string' ? data.businessName : null);
        }
      } catch {
        // Pages surface their own errors; the probe only drives the gate.
      } finally {
        if (!cancelled) setProbeDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading) {
    return <div className="container px-4 py-10 text-sm text-muted-foreground">Loading vendor account</div>;
  }

  if (!user) {
    return (
      <div className="container px-4 py-16 flex justify-center">
        <Card className="max-w-md w-full">
          <CardContent className="py-10 text-center space-y-4">
            <p className="font-semibold">Sign in to open your vendor account</p>
            <Button asChild>
              <Link href="/login?redirect=/vendor">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (gateBlocked) {
    return (
      <div className="container px-4 py-16 flex justify-center">
        <Card className="max-w-md w-full">
          <CardContent className="py-10 text-center">
            <p className="text-sm">{VENDOR_GATE_MESSAGE}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!probeDone) {
    return <div className="container px-4 py-10 text-sm text-muted-foreground">Loading vendor account</div>;
  }

  return (
    <div>
      <VendorNav businessName={businessName} />
      <main className="container px-4 md:px-6 py-6">{children}</main>
    </div>
  );
}
