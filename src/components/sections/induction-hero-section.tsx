"use client";

import { Button } from '@/components/ui/button';
import { ArrowRight, Heart, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { OrbitingPartners, Partner } from '@/components/hero/orbiting-partners';
import { AuthGuardedButton } from '@/components/auth/auth-guarded-button';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useFirestore } from '@/firebase';
import { collection, query, orderBy, getDocs } from 'firebase/firestore';
import { motion, AnimatePresence } from 'framer-motion';

import { useSiteSettings } from '@/hooks/use-site-settings';

/**
 * Hero Section — "Theater Mode" with Multi-Ring Solar System
 */
export default function InductionHeroSection() {
  const router = useRouter();
  const firestore = useFirestore();
  const { settings } = useSiteSettings();
  const [partners, setPartners] = useState<Partner[]>([]);

  // Theater Mode State
  const [isUIHidden, setIsUIHidden] = useState(false);
  // Use a ref to track last interaction so the idle timer closure doesn't go stale
  const lastInteractionRef = useRef(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const IDLE_TIMEOUT = 3500;

  // Fetch Partners for Orbit
  useEffect(() => {
    const fetchOrbits = async () => {
      if (!firestore) return;
      try {
        const q = query(collection(firestore, 'organizations'), orderBy('displayOrder', 'asc'));
        const snap = await getDocs(q);
        const orgs = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));

        // Filter active & homepage
        const visible = orgs.filter((o: any) => o.isActive && o.showOnHomepageMarquee);

        // Map to Partner type
        const dbPartners = visible.map((o: any) => ({
          id: o.id,
          name: o.name,
          logoUrl: o.logoUrl,
          type: o.type
        }));

        // PRO MAX: Technical Domain Partners (Dynamic SVGs)
        const techPartners: Partner[] = [
          {
            id: 'tech-cubesat',
            name: 'CubeSat Development',
            type: 'Technology',
            rawSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-1"><rect x="7" y="7" width="10" height="10" /><path d="M7 12H3m14 0h4M12 7V3m0 14v4" /><path d="M12 12l-3-3m6 6l-3-3m0 0l3-3m-3 3l-3 3" /></svg>`
          },
          {
            id: 'tech-rover',
            name: 'Planetary Rover',
            type: 'Technology',
            rawSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-1"><path d="M4 14h16v3H4zM4 17h16m-14 3a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-6 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /><path d="M12 14V9m0 0l-3 3m3-3l3 3" /></svg>`
          },
          {
            id: 'tech-mission',
            name: 'Mission Design',
            type: 'Technology',
            rawSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-1"><path d="M12 2v20m-7-7l7 7 7-7" /><path d="M12 2l-7 7 7 7 7-7-7-7z" /><circle cx="12" cy="12" r="3" /></svg>`
          },
          {
            id: 'tech-collab',
            name: 'International Collaboration',
            type: 'Technology',
            rawSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-1"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/></svg>`
          }
        ];

        setPartners([...techPartners, ...dbPartners]);

      } catch (err) {
        console.error("Orbit fetch failed", err);
      }
    };
    fetchOrbits();
  }, [firestore]);

  // Lazy single-timeout idle pattern: no continuous setInterval polling.
  // Schedules one timeout on interaction; fires only once when truly idle.
  const scheduleIdleCheck = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      const elapsed = Date.now() - lastInteractionRef.current;
      if (elapsed >= IDLE_TIMEOUT) {
        setIsUIHidden(true);
      }
    }, IDLE_TIMEOUT);
  }, []);

  // WAKE UP + reschedule idle check on every interaction
  const wakeUp = useCallback(() => {
    lastInteractionRef.current = Date.now();
    setIsUIHidden(false);
    scheduleIdleCheck();
  }, [scheduleIdleCheck]);

  // Start first idle countdown on mount, clean up on unmount
  useEffect(() => {
    scheduleIdleCheck();
    window.addEventListener('scroll', wakeUp, { passive: true });
    window.addEventListener('mousemove', wakeUp, { passive: true });
    window.addEventListener('click', wakeUp);
    window.addEventListener('touchstart', wakeUp, { passive: true });
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      window.removeEventListener('scroll', wakeUp);
      window.removeEventListener('mousemove', wakeUp);
      window.removeEventListener('click', wakeUp);
      window.removeEventListener('touchstart', wakeUp);
    };
  }, [wakeUp, scheduleIdleCheck]);


  return (
    <section
      id="induction-hero"
      className="relative w-full overflow-hidden border-none z-10 bg-transparent flex items-center justify-center min-h-[94vh] py-24"
      aria-labelledby="induction-hero-heading"
    >
      {/* ===== ORBITING SATELLITES (Persistent) ===== */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute inset-0 md:-translate-y-[8%]">
          <OrbitingPartners partners={partners} />
        </div>
      </div>

      {/* ===== READABILITY SCRIM (dims badges passing behind text) ===== */}
      <div className="absolute inset-0 z-10 pointer-events-none bg-[radial-gradient(ellipse_60%_55%_at_50%_42%,rgba(2,6,23,0.72),transparent_75%)]" aria-hidden="true" />

      {/* ===== CONTENT (Fades in Theater Mode) ===== */}
      <motion.div
        className="relative z-20 flex flex-col items-center justify-center text-center px-4 md:px-6 w-full"
        animate={{ opacity: isUIHidden ? 0 : 1, filter: isUIHidden ? 'blur(10px)' : 'blur(0px)' }}
        transition={{ duration: 0.8, ease: "easeInOut" }}
      >
        <div className="flex flex-col items-center gap-8 max-w-5xl mx-auto">
          <div className="space-y-4 text-center">
            <h1
              id="induction-hero-heading"
              className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-accent font-black tracking-tighter 
                         text-white animate-hero-fade-in-up relative drop-shadow-[0_0_30px_rgba(59,130,246,0.3)] leading-[0.95]"
            >
              <span className="block opacity-90 text-transparent bg-clip-text bg-gradient-to-b from-white to-white/40">JOIN SEDS PAKISTAN</span>
              <span className="block mt-2 text-primary drop-shadow-[0_0_50px_rgba(59,130,246,0.5)]">BUILD THE FUTURE</span>
            </h1>
            <div className="flex items-center justify-center gap-4 text-[10px] md:text-xs font-black uppercase tracking-[0.5em] text-primary/60 animate-pulse">
              <div className="h-px w-8 md:w-12 bg-primary/40" />
              <span>Operational Readiness: Nominal</span>
              <div className="h-px w-8 md:w-12 bg-primary/40" />
            </div>
          </div>
          
          <p className="max-w-3xl text-base md:text-2xl text-white/80 font-body animate-hero-fade-in-up-delay-1 leading-relaxed px-4">
            Hands-on <span className="text-white font-black underline decoration-primary/50 underline-offset-4">CubeSat</span>, Rover, Rocketry, Mission Design workshops, and international collaborations.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 mt-8 animate-hero-fade-in-up-delay-2 w-full max-w-2xl mx-auto">
            <AuthGuardedButton
              size="lg"
              className="h-16 px-10 font-accent tracking-widest uppercase text-base bg-primary text-black font-black hover:bg-white hover:shadow-[0_0_40px_rgba(255,255,255,0.4)] transition-all duration-500 rounded-2xl group relative overflow-hidden flex-1 w-full sm:w-auto"
              onAuthenticatedClick={() => router.push('/apply/step-1')}
              redirectPath="/apply/step-1"
            >
              <div className="flex items-center justify-center gap-3 relative z-10">
                <span>Apply Now</span>
                <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
              </div>
            </AuthGuardedButton>

            <Button asChild size="lg" variant="outline" className="h-16 px-10 font-accent tracking-widest uppercase text-base border-2 border-primary/40 text-white hover:border-primary hover:bg-primary/10 bg-slate-950/40 backdrop-blur-2xl rounded-2xl transition-all duration-500 group flex-1 w-full sm:w-auto">
              <Link href="/apply" className="flex items-center gap-3">
                Join The Tribe <ChevronRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
              </Link>
            </Button>

            {settings?.enableDonations && (
              <Button asChild size="lg" className="h-16 px-8 font-accent tracking-widest uppercase text-sm bg-orange-600/20 text-orange-500 border-2 border-orange-500/30 hover:bg-orange-500 hover:text-black transition-all duration-500 rounded-2xl shadow-xl group">
                <Link href="/donate" className="flex items-center gap-2">
                  Donate <Heart className="h-4 w-4 transition-transform group-hover:scale-125 fill-current" />
                </Link>
              </Button>
            )}
          </div>

          {settings?.enableChapterRegistration && (
            <div className="mt-12 animate-hero-fade-in-up-delay-2 pointer-events-auto w-full max-w-lg">
              <Link
                href="/register-chapter"
                className="group flex items-center justify-between p-4 rounded-2xl border border-white/10 bg-slate-900/40 hover:bg-slate-900/60 hover:border-primary/50 transition-all duration-500 backdrop-blur-3xl shadow-2xl overflow-hidden relative"
              >
                <div className="flex flex-col items-start gap-1 relative z-10">
                  <span className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500 group-hover:text-primary transition-colors">Academic Network</span>
                  <span className="text-sm font-medium text-white/90">University or School Representative?</span>
                </div>
                <div className="px-4 py-2 rounded-xl bg-primary/10 text-primary border border-primary/20 group-hover:bg-primary group-hover:text-black transition-all duration-500 font-accent font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                  Establish Chapter <ChevronRight className="w-4 h-4" />
                </div>
                {/* Visual scanline effect */}
                <div className="absolute top-0 left-0 w-full h-[1px] bg-primary/20 -translate-y-full group-hover:animate-scan-slow" />
              </Link>
            </div>
          )}

        </div>
      </motion.div>
    </section>
  );
}
