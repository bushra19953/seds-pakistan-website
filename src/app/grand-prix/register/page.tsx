'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useReducedMotion } from 'framer-motion';
import Image from 'next/image';
import Link from 'next/link';
import StarryBackground from '@/components/starry-background';
import Footer from '@/components/layout/footer';
import SpaceScene from './space-scene';

// Decorative fixed-position SVG backdrop (22 KB of inline SVG): kept out of
// the initial document and main bundle so the enrolment form paints and
// hydrates first. It is purely decorative, so loading it after hydration
// changes nothing the visitor can act on.
const CartoonPlanets = dynamic(() => import('./cartoon-planets'), { ssr: false });
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  FEE_CALLOUT,
  INITIAL_CLOSE_ISO,
  NATION_LABELS,
  PASS_LABELS,
  PASS_TYPES,
  SERIES_NAME,
  type Nation,
  type PassType,
  type WindowState,
} from '@/lib/grand-prix/registration';

interface RegistrationStatus {
  open: boolean;
  state: WindowState;
  closesAt: string | null;
  opensAt: string | null;
  totalRegistered: number;
}

// Same world as the rest of the site: Bebas display, Orbitron labels,
// Courier Prime body (inherited), coral the only signal colour, hairline
// cards at the shared 0.5rem radius, and a full light-mode treatment —
// the old page-local Fraunces / Manrope / gold sub-brand is gone.
const fieldClass =
  'h-12 rounded-lg border border-[#1A1610]/15 bg-white px-4 text-[15px] transition-colors placeholder:text-[#7A7260] focus-visible:border-primary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:border-white/15 dark:bg-white/[0.05] dark:placeholder:text-[#8E887A] dark:focus-visible:bg-white/[0.08]';
const selectClass =
  'flex h-12 w-full rounded-lg border border-[#1A1610]/15 bg-white px-4 py-2 text-[15px] transition-colors focus:bg-primary/[0.04] focus:outline-none focus:ring-2 focus:ring-primary/40 dark:border-white/15 dark:bg-white/[0.05] dark:focus:bg-white/[0.08] [&>option]:bg-white [&>option]:text-[#1A1610] dark:[&>option]:bg-[#101623] dark:[&>option]:text-[#F5F0E4]';
const labelClass =
  'font-accent text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B5E3F] dark:text-[#CBBFA5]';
const cardClass =
  'rounded-lg border-[#1A1610]/10 bg-white dark:border-white/10 dark:bg-white/[0.04] dark:backdrop-blur-md';
const displayFont = 'font-headline';

/**
 * Spotlight card treatment, adapted from the 21st.dev "Spotlight Card"
 * community pattern: a soft radial glow that follows the visitor's pointer
 * across the card surface. The glow is painted in the site's coral signal
 * colour at low alpha (the same accent the page reserves for its primary
 * action), answers the visitor's own pointer movement only, and is removed
 * entirely for visitors who prefer reduced motion. Purely visual: fields,
 * validation and submit behaviour inside the card are untouched.
 */
function SpotlightCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--spot-x', `${e.clientX - rect.left}px`);
    el.style.setProperty('--spot-y', `${e.clientY - rect.top}px`);
  };

  return (
    <Card
      ref={ref}
      onPointerMove={reduceMotion ? undefined : handlePointerMove}
      className={`group/spot relative overflow-hidden ${className ?? ''}`}
    >
      {!reduceMotion && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover/spot:opacity-100 group-focus-within/spot:opacity-100"
          style={{
            background:
              'radial-gradient(520px circle at var(--spot-x, 50%) var(--spot-y, 0%), rgba(233,113,76,0.09), transparent 65%)',
          }}
        />
      )}
      {children}
    </Card>
  );
}

function statusLine(state: WindowState): string {
  if (state === 'open') return 'Registration open — initial window closes Nov 15, 2026, 23:59 PKT.';
  if (state === 'late') return 'Late admission open — closes Nov 28, 2026, 23:59 PKT.';
  return 'Registration closed — late admission opens Nov 21, 2026, 09:00 PKT and closes Nov 28, 2026, 23:59 PKT.';
}

/**
 * The countdown owns its own one-second timer state so that each tick
 * re-renders only these four boxes. Previously the tick state lived in the
 * page root, which re-rendered the whole enrolment form (and every input in
 * it) once per second.
 */
function RegistrationCountdown({ target, label }: { target: string | null; label: string }) {
  const [remainMs, setRemainMs] = useState<number | null>(null);

  useEffect(() => {
    if (target === null) {
      setRemainMs(null);
      return;
    }
    const targetMs = new Date(target).getTime();
    const tick = () => setRemainMs(Math.max(0, targetMs - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (remainMs === null || remainMs <= 0) return null;

  return (
    <div className="mt-10">
      <p className="flex items-center justify-center gap-2.5 text-center font-accent text-[11px] font-semibold uppercase tracking-[0.3em] text-primary-text">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {label}
      </p>
      <div className="mx-auto mt-4 grid max-w-xl grid-cols-4 gap-2 sm:gap-3">
        {[
          { value: Math.floor(remainMs / 86400000), label: 'Days' },
          { value: Math.floor(remainMs / 3600000) % 24, label: 'Hours' },
          { value: Math.floor(remainMs / 60000) % 60, label: 'Minutes' },
          { value: Math.floor(remainMs / 1000) % 60, label: 'Seconds' },
        ].map((part) => (
          <div
            key={part.label}
            className="min-w-0 rounded-lg border border-[#1A1610]/10 bg-white px-1 py-3 text-center dark:border-white/10 dark:bg-white/[0.04] dark:backdrop-blur-md sm:py-3.5"
          >
            <p className={`text-3xl tabular-nums sm:text-4xl ${displayFont}`}>
              {String(part.value).padStart(2, '0')}
            </p>
            <p className="mt-1 font-accent text-[9px] font-semibold uppercase tracking-[0.16em] text-[#6B5E3F] dark:text-[#CBBFA5] sm:text-[10px] sm:tracking-[0.24em]">
              {part.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function GrandPrixRegisterPage() {
  const [fullName, setFullName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [email, setEmail] = useState('');
  const [discipline, setDiscipline] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [nation, setNation] = useState<Nation>('PK');
  const [passType, setPassType] = useState<PassType>('student');
  const [institutionName, setInstitutionName] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState<RegistrationStatus | null>(null);

  const countdownTarget =
    status === null
      ? INITIAL_CLOSE_ISO
      : status.state === 'closed'
        ? status.opensAt
        : status.closesAt;
  const countdownLabel =
    status === null || status.state === 'open'
      ? 'Registration closes in'
      : status.state === 'late'
        ? 'Late admission closes in'
        : 'Late admission opens in';

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [success, setSuccess] = useState<{ registrationId: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/grand-prix/registrations')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (live && data && data.ok) setStatus(data as RegistrationStatus);
      })
      .catch(() => {
        /* Window state is informational; the server enforces the windows. */
      });
    return () => {
      live = false;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSubmitting(true);
    try {
      const res = await fetch('/api/grand-prix/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          studentId,
          email,
          discipline,
          whatsapp,
          nation,
          passType,
          institutionName,
          institutionId,
          city,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(
          Array.isArray(data.errors) && data.errors.length > 0
            ? data.errors
            : [data.error || 'Submission failed. Please check the form and try again.'],
        );
        return;
      }
      setSuccess({ registrationId: data.registrationId });
    } catch {
      setErrors(['Network error. Please check your connection and submit again.']);
    } finally {
      setSubmitting(false);
    }
  };

  const closed = status !== null && status.open === false;
  const closedLine =
    status !== null && status.state === 'closed' && status.opensAt === null
      ? 'Registration closed — the late admission window ended Nov 28, 2026, 23:59 PKT.'
      : status !== null
        ? statusLine(status.state)
        : 'Registration open — initial window closes Nov 15, 2026, 23:59 PKT.';

  return (
    <div className="relative flex min-h-screen flex-col text-foreground">
      <StarryBackground />
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 hidden opacity-55 dark:block">
        {/* next/image (priority + responsive variants) instead of a CSS
            background: the raw backdrop is a 403 KB full-size JPG that every
            visitor, phone included, used to download at full resolution. */}
        <Image
          src="/assets/grand-prix-nebula.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-[center_top]"
        />
      </div>
      <SpaceScene />
      <CartoonPlanets />
      {/* Dark-only deep-space film, matching the series page; light mode
          drops the film, the nebula and the space scenes so the form sits
          on the site's light ground. */}
      <div className="pointer-events-none fixed inset-0 hidden bg-[radial-gradient(ellipse_55%_40%_at_50%_-5%,rgba(233,113,76,0.08),transparent),linear-gradient(180deg,rgba(6,9,16,0.22),rgba(6,9,16,0.52))] dark:block" />
      <main className="container relative z-10 mx-auto flex-1 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-center gap-4">
            <span className="h-px w-12 bg-gradient-to-r from-transparent to-primary/70" />
            <p className="text-center font-accent text-[11px] font-semibold uppercase tracking-[0.28em] text-primary-text sm:tracking-[0.32em]">
              SEDS Pakistan and SEDS Sri Lanka
            </p>
            <span className="h-px w-12 bg-gradient-to-l from-transparent to-primary/70" />
          </div>
          <h1 className={`mt-6 text-center text-5xl leading-[0.98] tracking-[0.02em] sm:text-7xl ${displayFont}`}>
            {SERIES_NAME}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-center text-[15px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
            Individual enrolment for the six-module masterclass series. Choose your country and pass below.
            See the six modules on the{' '}
            <Link href="/grand-prix" className="font-semibold text-primary-text underline underline-offset-4">
              series page
            </Link>
            .
          </p>
          <p className="mx-auto mt-4 flex items-center justify-center gap-2.5 text-center text-[13px] font-semibold text-[#57503E] dark:text-[#CFC8B8]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            {closedLine}
          </p>
          <div className="mt-8 flex items-center justify-center gap-3" aria-hidden="true">
            <span className="h-px w-24 bg-[#1A1610]/15 dark:bg-white/15" />
            <span className="block h-1.5 w-1.5 rotate-45 bg-primary" />
            <span className="h-px w-24 bg-[#1A1610]/15 dark:bg-white/15" />
          </div>

          <RegistrationCountdown target={countdownTarget} label={countdownLabel} />

          <SpotlightCard className={`mt-10 ${cardClass}`}>
            <CardContent className="py-5">
              <p className="text-center text-sm font-semibold leading-relaxed text-primary-text">
                {FEE_CALLOUT}
              </p>
            </CardContent>
          </SpotlightCard>

          {success ? (
            <SpotlightCard className={`mt-10 ${cardClass}`}>
              <CardHeader className="border-b border-primary/25 pb-6 text-center">
                <CardTitle className={`text-4xl ${displayFont}`}>Enrolment received</CardTitle>
                <CardDescription className="mx-auto max-w-md text-[15px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
                  Your place is held while the enrolment is verified. Keep this registration ID for all
                  correspondence about the masterclass series.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6 text-center">
                <p className="font-accent text-[11px] font-semibold uppercase tracking-[0.22em] text-[#6B5E3F] dark:text-[#CBBFA5]">
                  Registration ID
                </p>
                <p className="mt-2 break-all font-mono text-xl text-primary-text">{success.registrationId}</p>
                <p className="mt-5 text-sm text-[#57503E] dark:text-[#CFC8B8]">
                  {fullName} ({NATION_LABELS[nation]} · {passType === 'student' ? 'Collegiate Student Pass' : 'Industry Professional Observer Pass'})
                </p>
              </CardContent>
            </SpotlightCard>
          ) : closed ? (
            <SpotlightCard className={`mt-10 ${cardClass}`}>
              <CardHeader className="text-center">
                <CardTitle className={`text-4xl ${displayFont}`}>Registration is closed</CardTitle>
                <CardDescription className="mx-auto max-w-md text-[15px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
                  {closedLine}
                </CardDescription>
              </CardHeader>
            </SpotlightCard>
          ) : (
            <form onSubmit={handleSubmit} className="mt-10 space-y-8">
              <SpotlightCard className={cardClass}>
                <CardHeader className="pb-2">
                  <div className="flex items-baseline gap-3">
                    <span aria-hidden="true" className="font-accent text-sm font-semibold tabular-nums text-primary-text">
                      01
                    </span>
                    <CardTitle className={`text-3xl ${displayFont}`}>Your enrolment</CardTitle>
                  </div>
                  <CardDescription className="text-sm leading-relaxed text-[#7A7260] dark:text-[#A79E8B]">
                    One enrolment per email. Student IDs must be unique per institution.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-5 pt-4 sm:grid-cols-2">
                  <div className="space-y-2.5">
                    <Label htmlFor="nation" className={labelClass}>Country</Label>
                    <select id="nation" className={selectClass} value={nation} onChange={(e) => setNation(e.target.value as Nation)}>
                      {(Object.keys(NATION_LABELS) as Nation[]).map((n) => (
                        <option key={n} value={n}>
                          {NATION_LABELS[n]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="city" className={labelClass}>City</Label>
                    <Input id="city" className={fieldClass} placeholder="e.g. Islamabad" value={city} onChange={(e) => setCity(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5 sm:col-span-2">
                    <Label className={labelClass}>Pass type</Label>
                    <div className="grid grid-cols-1 gap-3" role="radiogroup" aria-label="Pass type">
                      {PASS_TYPES.map((p) => (
                        <button
                          key={p}
                          type="button"
                          role="radio"
                          aria-checked={passType === p}
                          onClick={() => setPassType(p)}
                          className={`rounded-lg border px-4 py-3 text-left text-sm leading-relaxed transition ${
                            passType === p
                              ? 'border-primary/80 bg-primary/10'
                              : 'border-[#1A1610]/15 bg-white hover:border-[#1A1610]/35 dark:border-white/15 dark:bg-white/[0.05] dark:hover:border-white/35'
                          }`}
                        >
                          {PASS_LABELS[p]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="institutionName" className={labelClass}>Institution name</Label>
                    <Input id="institutionName" className={fieldClass} placeholder="e.g. Institute of Space Technology" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="institutionId" className={labelClass}>Institution verification ID</Label>
                    <Input id="institutionId" className={fieldClass} placeholder="ID issued by your institution, e.g. IST-REG-2026" value={institutionId} onChange={(e) => setInstitutionId(e.target.value)} required />
                  </div>
                </CardContent>
              </SpotlightCard>

              <SpotlightCard className={cardClass}>
                <CardHeader className="pb-2">
                  <div className="flex items-baseline gap-3">
                    <span aria-hidden="true" className="font-accent text-sm font-semibold tabular-nums text-primary-text">
                      02
                    </span>
                    <CardTitle className={`text-3xl ${displayFont}`}>About you</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-5 pt-4 sm:grid-cols-2">
                  <div className="space-y-2.5">
                    <Label htmlFor="fullName" className={labelClass}>Full name</Label>
                    <Input id="fullName" className={fieldClass} placeholder="Full name, as on the student ID card" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="studentId" className={labelClass}>Student ID</Label>
                    <Input id="studentId" className={fieldClass} placeholder="Student ID / registration number" value={studentId} onChange={(e) => setStudentId(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="email" className={labelClass}>Email</Label>
                    <Input id="email" type="email" className={fieldClass} placeholder="e.g. yourname@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="discipline" className={labelClass}>Discipline or field</Label>
                    <Input id="discipline" className={fieldClass} placeholder="e.g. Avionics, Structures, Software, Propulsion" value={discipline} onChange={(e) => setDiscipline(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="whatsapp" className={labelClass}>WhatsApp number</Label>
                    <Input id="whatsapp" className={fieldClass} placeholder="+92 3XX XXXXXXX or +94 7X XXXXXXX" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} required />
                  </div>
                </CardContent>
              </SpotlightCard>

              {errors.length > 0 && (
                <Card className="rounded-lg border-red-700/30 bg-red-500/[0.05] dark:border-red-400/30 dark:bg-red-500/[0.08] dark:backdrop-blur-md">
                  <CardContent className="py-5">
                    <p className="text-sm font-bold text-red-800 dark:text-red-200">Please fix the following:</p>
                    <ul className="mt-2 list-inside list-disc text-sm text-red-800/80 dark:text-red-200/85">
                      {errors.map((err) => (
                        <li key={err}>{err}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              <Button
                type="submit"
                disabled={submitting}
                className="h-[52px] w-full rounded-full bg-primary font-accent text-sm font-semibold uppercase tracking-[0.14em] text-primary-foreground transition hover:bg-primary/90 active:scale-[0.99] disabled:opacity-60"
              >
                {submitting ? 'Submitting...' : 'Enrol now'}
              </Button>
              <p className="text-center text-xs text-[#7A7260] dark:text-[#8E887A]">
                Student IDs are collected for institutional verification only and are never shown publicly.
              </p>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
