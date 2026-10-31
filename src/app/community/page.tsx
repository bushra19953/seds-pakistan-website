"use client";

import dynamic from 'next/dynamic';
import React, { Suspense } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Rocket } from 'lucide-react';
import PageHero from '@/components/ui/page-hero';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

// ── Critical path: defer heavy components off the main thread ──
const Leaderboard = dynamic(() => import('@/components/community/leaderboard'), {
  ssr: false,
  loading: () => (
    <div className="space-y-3 py-6" aria-busy="true" aria-label="Loading leaderboard…">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="h-10 w-full rounded-md bg-card/60 animate-pulse" />
      ))}
    </div>
  ),
});

const Footer = dynamic(() => import('@/components/layout/footer'), { ssr: false });

// Hero background — preload hint injected via <head> in PageHero
const HERO_IMAGE =
  'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1600&q=80';

export default function CommunityPage() {
  const router = useRouter();
  const [verifyCode, setVerifyCode] = useState('');

  // PERF: this page used to enumerate IndexedDB on every mount and
  // delete every Firestore database on the origin. That forced the
  // Firestore SDK to rebuild its local state on each visit (slower
  // repeat loads for this page's own chapters/settings reads and for
  // every other Firestore surface), for no functional gain — the SDK
  // manages its own cache lifecycle. Removed.

  const goVerify = (e?: React.FormEvent) => {
    e?.preventDefault();
    const c = verifyCode.trim();
    if (!c) {
      router.push('/verify');
      return;
    }
    router.push(`/verify/${encodeURIComponent(c)}`);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Background handled globally by app layout (Vanta) */}

      {/* Hero header — passes preload flag so PageHero injects <link rel="preload"> */}
      <PageHero
        title="Community Leaderboard"
        subtitle="Recognize top contributors across chapters and projects."
        backgroundImageUrl={HERO_IMAGE}
        preload
      />

      <main className="flex-1 container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          {/* Right-aligned Verify Certificate quick form */}
          <form onSubmit={goVerify} className="flex justify-end mb-4 gap-2">
            <Input
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              placeholder="Certificate code"
              className="w-56"
              aria-label="Certificate code"
            />
            <Button type="submit" variant="secondary">Verify Certificate</Button>
          </form>

          {/* How to Earn Points */}
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 mb-8">
            <CardHeader>
              <CardTitle className="text-lg">How to Earn Points</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-muted-foreground">
                <li className="flex items-start gap-2">
                  <Rocket className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <span>Complete assigned tasks to earn points based on task difficulty.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Rocket className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <span>Contribute to projects and workshops.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Rocket className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <span>Participate in SEDS Pakistan events and activities.</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Warning Registry — the public register. It lived at
              /warning-registry with no link pointing to it from anywhere
              on the site until 2026-10-28; this card (and the header
              Community menu) are its doors. */}
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 mb-8">
            <CardHeader>
              <CardTitle className="text-lg">Warning Registry</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-muted-foreground">
                The public register of members currently on warning or probation. Names, chapters, status, warning counts and dates. Facts only.
              </p>
              <Button asChild variant="secondary">
                <Link href="/warning-registry">View the registry</Link>
              </Button>
            </CardContent>
          </Card>

          {/* Hierarchy — the public org chart (founder order
              2026-10-30). It lived only in the admin console until
              now; this card and the header Community menu are its
              doors, the same treatment the Warning Registry got. */}
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 mb-8">
            <CardHeader>
              <CardTitle className="text-lg">Hierarchy</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-muted-foreground">
                Who leads SEDS Pakistan, chapter by chapter: each chapter&apos;s officers and role-holders, with a link to every member&apos;s public profile.
              </p>
              <Button asChild variant="secondary">
                <Link href="/hierarchy">View the hierarchy</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 mb-8">
            <CardHeader>
              <CardTitle className="text-lg">Store</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-muted-foreground">
                Parts and tools for your builds, sold through the SEDS Pakistan store. Prices are in PKR.
              </p>
              <Button asChild variant="secondary">
                <Link href="/store">Visit the store</Link>
              </Button>
            </CardContent>
          </Card>

          {/* Integrated Leaderboard — deferred via dynamic import */}
          <Suspense fallback={
            <div className="space-y-3 py-6">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-10 w-full rounded-md bg-card/60 animate-pulse" />
              ))}
            </div>
          }>
            <Leaderboard />
          </Suspense>
        </div>
      </main>

      <Footer />
    </div>
  );
}
