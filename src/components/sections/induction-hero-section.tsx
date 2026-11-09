"use client";

import { Button } from '@/components/ui/button';
import { ArrowRight, Heart, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { OrbitingPartners, Partner } from '@/components/hero/orbiting-partners';
import { AuthGuardedButton } from '@/components/auth/auth-guarded-button';
import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion, type Variants } from 'framer-motion';
import { fetchHomepageOrganizations } from '@/lib/homepage-organizations';

import { useSiteSettings } from '@/hooks/use-site-settings';
import { useIntakeWindow } from '@/hooks/use-intake-window';
import { formatIntakeCloseLine, formatIntakeScheduledLine } from '@/lib/intake-windows/format';

/**
 * Hero Section — "Theater Mode" with Multi-Ring Solar System
 */

// One orchestrated entrance, adapted from 21st.dev's "Animated Blur Text"
// (BlurText) pattern: the headline resolves word by word out of a blur,
// then the status line, subcopy and CTAs rise in sequence. Nothing else
// on the hero animates on its own. Gold (#C9A45C, the Grand Prix accent)
// is reserved for the single primary CTA; every other element stays in
// quiet foreground tones.
const heroSequence: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.14, delayChildren: 0.05 } },
};

const heroWord: Variants = {
  hidden: { opacity: 0, y: 16, filter: 'blur(8px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.55, ease: 'easeOut' },
  },
};

const heroLine: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};

const heroRise: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: 'easeOut' } },
};
export default function InductionHeroSection() {
  const router = useRouter();
  const shouldReduceMotion = useReducedMotion();
  const { settings, loading: settingsLoading } = useSiteSettings();
  const [partners, setPartners] = useState<Partner[]>([]);

  // Theater Mode State
  const [isUIHidden, setIsUIHidden] = useState(false);
  // Use a ref to track last interaction so the idle timer closure doesn't go stale
  const lastInteractionRef = useRef(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const IDLE_TIMEOUT = 3500;

  // Application window state (data-driven, Workstream E): unless the
  // resolved window is open, the Apply Now CTA stops navigating and the
  // countdown shows closed. While loading, the CTA renders disabled with
  // its normal label (fail-safe: nothing renders as open pre-fetch).
  const { window: intakeWindow, state: intakeState } = useIntakeWindow('induction');
  const applicationsClosed = intakeState !== 'open';
  // Resolved non-open states (closed, scheduled, cancelled, none)
  // state the fact exactly once: the disabled primary-slot button
  // carries the label, the secondary slot renders nothing and the
  // countdown stays silent. The hero used to say it three times —
  // two disabled buttons plus the red countdown line. While loading,
  // showClosedIndicator is false and both disabled placeholders
  // render with their normal labels (fail-safe: nothing reads as
  // closed before the window resolves).
  const showClosedIndicator = applicationsClosed && intakeState !== 'loading';
  const ctaDisabledLabel =
    intakeState === 'loading'
      ? 'Apply Now'
      : intakeState === 'scheduled'
        ? formatIntakeScheduledLine(intakeWindow?.opensAt)
        : 'Applications Closed';
  const joinDisabledLabel =
    intakeState === 'loading'
      ? 'Join The Tribe'
      : intakeState === 'scheduled'
        ? formatIntakeScheduledLine(intakeWindow?.opensAt)
        : 'Applications Closed';

  // Fetch Partners for Orbit. Read-bleed fix train 2 (census 01
  // item 2): from the shared homepage organizations API fetch (the
  // gated /api/organizations?showOnHomepage=true response, shared
  // with the credibility marquee) — no direct Firestore read. The
  // active & homepage filter below is unchanged.
  useEffect(() => {
    const fetchOrbits = async () => {
      // PRO MAX: Technical Domain Partners (Dynamic SVGs). Hoisted
      // out of the try (perf batch-3 lead decision (c)): the catch
      // sets this static list on fetch failure, so the orbit shows
      // true content instead of zero partners; the success path
      // still merges it ahead of the DB partners, unchanged.
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

      try {
        const orgs = await fetchHomepageOrganizations();

        // Filter active & homepage
        const visible = orgs.filter((o: any) => o.isActive && o.showOnHomepageMarquee);

        // Map to Partner type
        const dbPartners = visible.map((o: any) => ({
          id: o.id,
          name: o.name,
          logoUrl: o.logoUrl,
          type: o.type
        }));

        setPartners([...techPartners, ...dbPartners]);

      } catch (err) {
        console.error("Orbit fetch failed", err);
        setPartners(techPartners);
      }
    };
    fetchOrbits();
  }, []);

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
      className="relative w-full overflow-hidden border-none z-10 bg-transparent flex flex-col items-center justify-center min-h-[94vh] pt-10 pb-20 md:pt-12 md:pb-24"
      aria-labelledby="induction-hero-heading"
    >
      {/* ===== ORBITING SATELLITES (own stage above the copy) =====
          The orbit gets its own band at the top of the hero and the
          copy flows underneath it. Satellites used to orbit through
          the headline and the paragraph (founder's screenshot: chips
          sitting on the text, the nucleus behind the headline); in
          flow, no satellite can cross a line of copy on any viewport,
          and the readability scrim the old layering needed is gone.
          The stage reserves the mobile strip's height so the partner
          chips arriving async do not shove the headline down. */}
      <div className="relative z-0 w-full shrink-0 min-h-[11.5rem] md:min-h-0 md:h-[360px]" aria-hidden="true">
        <OrbitingPartners partners={partners} />
      </div>

      {/* ===== CONTENT (Fades in Theater Mode) ===== */}
      <motion.div
        className="relative z-20 flex flex-col items-center justify-center text-center px-4 md:px-6 w-full mt-4 md:mt-6"
        animate={{ opacity: isUIHidden ? 0 : 1, filter: isUIHidden ? 'blur(8px)' : 'blur(0px)' }}
        transition={{ duration: shouldReduceMotion ? 0 : 0.8, ease: "easeInOut" }}
      >
        <motion.div
          className="flex flex-col items-center gap-6 md:gap-8 max-w-5xl mx-auto"
          variants={heroSequence}
          initial={shouldReduceMotion ? false : 'hidden'}
          animate="show"
        >
          <div className="space-y-4 text-center">
            <motion.h1
              id="induction-hero-heading"
              aria-label="JOIN SEDS PAKISTAN BUILD THE FUTURE"
              className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-accent font-black tracking-tighter 
                         text-foreground relative drop-shadow-[0_2px_12px_rgba(0,0,0,0.45)] leading-[0.95]"
            >
              <motion.span variants={heroLine} className="block text-foreground" aria-hidden="true">
                {['JOIN', 'SEDS', 'PAKISTAN'].map((word, i, arr) => (
                  <motion.span key={word} variants={heroWord} className="inline-block will-change-transform">
                    {word}
                    {i < arr.length - 1 ? '\u00A0' : ''}
                  </motion.span>
                ))}
              </motion.span>
              <motion.span variants={heroLine} className="block mt-2 text-foreground" aria-hidden="true">
                {['BUILD', 'THE', 'FUTURE'].map((word, i, arr) => (
                  <motion.span key={word} variants={heroWord} className="inline-block will-change-transform">
                    {word}
                    {i < arr.length - 1 ? '\u00A0' : ''}
                  </motion.span>
                ))}
              </motion.span>
            </motion.h1>
            <motion.div variants={heroRise} className="flex items-center justify-center gap-4 text-[10px] md:text-xs font-black uppercase tracking-[0.5em] text-muted-foreground">
              <div className="h-px w-8 md:w-12 bg-foreground/20" />
              <span>Operational Readiness: Nominal</span>
              <div className="h-px w-8 md:w-12 bg-foreground/20" />
            </motion.div>
          </div>

          <motion.p variants={heroRise} className="max-w-3xl text-base md:text-2xl text-foreground/80 font-body leading-relaxed px-4">
            Hands-on <span className="text-foreground font-black underline decoration-foreground/40 underline-offset-4">CubeSat</span>, Rover, Rocketry, Mission Design workshops, and international collaborations.
          </motion.p>

          <motion.div variants={heroRise} className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6 w-full max-w-2xl mx-auto">
            {applicationsClosed ? (
              <Button
                size="lg"
                disabled
                className="h-16 px-10 font-accent tracking-widest uppercase text-base rounded-2xl flex-1 w-full sm:w-auto"
              >
                <span>{ctaDisabledLabel}</span>
              </Button>
            ) : (
              <AuthGuardedButton
                size="lg"
                className="h-16 px-10 font-accent tracking-widest uppercase text-base bg-[#C9A45C] text-black font-black hover:bg-[#E8CF8F] hover:shadow-[0_0_40px_rgba(201,164,92,0.35)] transition-all duration-500 rounded-2xl group relative overflow-hidden flex-1 w-full sm:w-auto"
                onAuthenticatedClick={() => router.push('/apply/step-1')}
                redirectPath="/apply/step-1"
              >
                <div className="flex items-center justify-center gap-3 relative z-10">
                  <span>Apply Now</span>
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                </div>
              </AuthGuardedButton>
            )}

            {/* Secondary slot: renders while loading (disabled
                placeholder) and while open (Join The Tribe). In a
                resolved non-open state it renders nothing — the
                primary slot already carries the one closed
                indicator. */}
            {!showClosedIndicator && (
              applicationsClosed ? (
                <Button size="lg" variant="outline" disabled className="h-16 px-10 font-accent tracking-widest uppercase text-base rounded-2xl flex-1 w-full sm:w-auto">
                  <span className="flex items-center gap-3">
                    {joinDisabledLabel}
                  </span>
                </Button>
              ) : (
              <Button asChild size="lg" variant="outline" className="h-16 px-10 font-accent tracking-widest uppercase text-base border-2 border-foreground/25 text-foreground hover:border-foreground/60 hover:bg-foreground/5 bg-slate-950/40 backdrop-blur-2xl rounded-2xl transition-all duration-500 group flex-1 w-full sm:w-auto">
                <Link href="/apply" className="flex items-center gap-3">
                  Join The Tribe <ChevronRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </Link>
              </Button>
              )
            )}

            {settingsLoading ? (
              // Invisible placeholder with identical footprint: prevents the
              // Donate button popping in late and shifting the layout
              <div aria-hidden className="h-16 px-8 invisible rounded-2xl flex-1 w-full sm:w-auto" />
            ) : settings?.enableDonations ? (
              <Button asChild size="lg" className="h-16 px-8 font-accent tracking-widest uppercase text-sm bg-slate-950/40 text-foreground/80 border-2 border-foreground/20 hover:bg-foreground/10 hover:text-foreground backdrop-blur-2xl transition-all duration-500 rounded-2xl group">
                <Link href="/donate" className="flex items-center gap-2">
                  Donate <Heart className="h-4 w-4 transition-transform group-hover:scale-125 fill-current" />
                </Link>
              </Button>
            ) : null}
          </motion.div>

          {settings?.enableChapterRegistration && (
            <motion.div variants={heroRise} className="pointer-events-auto w-full max-w-lg">
              <Link
                href="/register-chapter"
                className="group flex items-center justify-between p-4 rounded-2xl border border-border bg-card/40 hover:bg-card/60 hover:border-foreground/40 transition-all duration-500 backdrop-blur-3xl shadow-2xl overflow-hidden relative"
              >
                <div className="flex flex-col items-start gap-1 relative z-10">
                  <span className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground transition-colors">Academic Network</span>
                  <span className="text-sm font-medium text-foreground/90">University or School Representative?</span>
                </div>
                <div className="px-4 py-2 rounded-xl bg-foreground/10 text-foreground border border-foreground/20 group-hover:bg-foreground/20 transition-all duration-500 font-accent font-black text-[10px] uppercase tracking-widest flex items-center gap-2">
                  Establish Chapter <ChevronRight className="w-4 h-4" />
                </div>
                {/* Visual scanline effect */}
                <div className="absolute top-0 left-0 w-full h-[1px] bg-foreground/20 -translate-y-full group-hover:animate-scan-slow" />
              </Link>
            </motion.div>
          )}

          {/* Real-time application deadline countdown */}
          <motion.div variants={heroRise}>
            <ApplicationCountdown />
          </motion.div>

        </motion.div>
      </motion.div>
    </section>
  );
}

// Real-time countdown to the resolved intake window's closesAt
// (data-driven, Workstream E). The hook state flips open -> closed at
// closesAt; this component only renders the remaining-time boxes.
// In every non-open state it renders nothing: the hero's disabled
// primary CTA already carries the one closed/scheduled indicator
// (showClosedIndicator in the hero), and this component used to
// repeat the fact as a second line under the buttons.
function ApplicationCountdown() {
  const { window: intakeWindow, state: intakeState } = useIntakeWindow('induction');
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  const closesAtMs = intakeWindow?.closesAt
    ? new Date(intakeWindow.closesAt).getTime()
    : NaN;

  useEffect(() => {
    if (!Number.isFinite(closesAtMs)) return;
    const update = () => {
      const diff = closesAtMs - Date.now();
      if (diff <= 0) return;
      setTimeLeft({
        days: Math.floor(diff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
        minutes: Math.floor((diff / (1000 * 60)) % 60),
        seconds: Math.floor((diff / 1000) % 60),
      });
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [closesAtMs]);

  if (intakeState !== 'open') {
    // Loading, scheduled, closed, cancelled, none: silent. The one
    // non-open indicator lives in the hero's CTA row.
    return null;
  }

  return (
    <div className="text-center">
      <p className="text-sm text-muted-foreground mb-2">Applications close in</p>
      <div className="flex items-center justify-center gap-3">
        {[
          { label: 'Days', value: timeLeft.days },
          { label: 'Hours', value: timeLeft.hours },
          { label: 'Mins', value: timeLeft.minutes },
          { label: 'Secs', value: timeLeft.seconds },
        ].map((unit) => (
          <div key={unit.label} className="flex flex-col items-center">
            <div className="w-16 h-16 rounded-xl bg-foreground/5 border border-foreground/15 flex items-center justify-center">
              <span className="text-2xl font-black text-foreground">{String(unit.value).padStart(2, '0')}</span>
            </div>
            <span className="text-xs text-muted-foreground mt-1">{unit.label}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2">{formatIntakeCloseLine(intakeWindow?.closesAt)}</p>
    </div>
  );
}
