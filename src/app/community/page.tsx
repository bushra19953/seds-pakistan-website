"use client";

import dynamic from 'next/dynamic';
import { Suspense, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Rocket } from 'lucide-react';
import PageHero from '@/components/ui/page-hero';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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

  // ── IndexedDB cache-bust on first visit (fixes Lighthouse warning) ──
  useEffect(() => {
    if (typeof indexedDB === 'undefined') return;
    try {
      const req = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
      req.then?.((dbs: IDBDatabaseInfo[]) => {
        dbs
          .filter((db) => db.name?.includes('firestore'))
          .forEach((db) => {
            if (db.name) indexedDB.deleteDatabase(db.name);
          });
      });
    } catch {
      // Non-fatal; ignore access errors
    }
  }, []);

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
