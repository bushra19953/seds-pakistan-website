'use client';

import { useEffect, useState } from 'react';
import { Fraunces, Manrope } from 'next/font/google';
import Link from 'next/link';
import StarryBackground from '@/components/starry-background';
import Footer from '@/components/layout/footer';
import SpaceScene from './space-scene';
import CartoonPlanets from './cartoon-planets';
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

const display = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--gp-display',
});

const body = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--gp-body',
});

interface RegistrationStatus {
  open: boolean;
  state: WindowState;
  closesAt: string | null;
  opensAt: string | null;
  totalRegistered: number;
}

const IVORY = '#F5F0E4';
const GOLD = '#C9A45C';
const GOLD_LIGHT = '#E8CF8F';

const fieldClass =
  'h-12 rounded-lg border-white/15 bg-white/[0.05] px-4 text-[15px] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] placeholder:text-[#8E887A] focus-visible:border-[#C9A45C]/70 focus-visible:ring-2 focus-visible:ring-[#C9A45C]/40';
const selectClass =
  'flex h-12 w-full rounded-lg border border-white/15 bg-white/[0.05] px-4 py-2 text-[15px] focus:outline-none focus:ring-2 focus:ring-[#C9A45C]/40 [&>option]:bg-[#101623] [&>option]:text-[#F5F0E4]';
const labelClass =
  'text-[11px] font-bold uppercase tracking-[0.18em] text-[#CBBFA5]';
const cardClass =
  'rounded-2xl border-white/10 bg-white/[0.04] shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-md';
const displayFont = '[font-family:var(--gp-display)]';

function statusLine(state: WindowState): string {
  if (state === 'open') return 'Registration open — initial window closes Nov 15, 2026, 23:59 PKT.';
  if (state === 'late') return 'Late admission open — closes Nov 28, 2026, 23:59 PKT.';
  return 'Registration closed — late admission opens Nov 21, 2026, 09:00 PKT and closes Nov 28, 2026, 23:59 PKT.';
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
  const [remainMs, setRemainMs] = useState<number | null>(null);

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

  useEffect(() => {
    if (countdownTarget === null) {
      setRemainMs(null);
      return;
    }
    const target = new Date(countdownTarget).getTime();
    const tick = () => setRemainMs(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [countdownTarget]);
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
    <div
      className={`relative flex min-h-screen flex-col ${display.variable} ${body.variable} [font-family:var(--gp-body)]`}
      style={{ color: IVORY }}
    >
      <StarryBackground />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-55"
        style={{
          backgroundImage: 'url(/assets/grand-prix-nebula.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
        }}
      />
      <SpaceScene />
      <CartoonPlanets />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_55%_40%_at_50%_-5%,rgba(201,164,92,0.14),transparent),linear-gradient(180deg,rgba(6,9,16,0.35),rgba(6,9,16,0.78))]" />
      <main className="container relative z-10 mx-auto flex-1 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-center gap-4">
            <span className="h-px w-12 bg-gradient-to-r from-transparent to-[#C9A45C]/80" />
            <p
              className="text-center text-[11px] font-extrabold uppercase tracking-[0.3em] sm:tracking-[0.42em]"
              style={{ color: GOLD_LIGHT }}
            >
              SEDS Pakistan and SEDS Sri Lanka
            </p>
            <span className="h-px w-12 bg-gradient-to-l from-transparent to-[#C9A45C]/80" />
          </div>
          <h1
            className={`mt-6 bg-gradient-to-r from-[#E8CF8F] via-[#C9A45C] to-[#E8CF8F] bg-clip-text text-center text-4xl font-semibold leading-[1.08] text-transparent sm:text-[3.4rem] ${displayFont}`}
          >
            {SERIES_NAME}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-center text-[15px] leading-relaxed text-[#CFC8B8]">
            Individual enrolment for the six-module masterclass series. Choose your country and pass below.
            See the six modules on the{' '}
            <Link href="/grand-prix" className="font-semibold underline underline-offset-4" style={{ color: GOLD_LIGHT }}>
              series page
            </Link>
            .
          </p>
          <p className="mx-auto mt-4 flex items-center justify-center gap-2.5 text-center text-[13px] font-semibold text-[#CFC8B8]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: GOLD }} />
            {closedLine}
          </p>
          <div className="mt-8 flex items-center justify-center gap-3" aria-hidden="true">
            <span className="h-px w-24 bg-white/15" />
            <span className="block h-1.5 w-1.5 rotate-45" style={{ backgroundColor: GOLD }} />
            <span className="h-px w-24 bg-white/15" />
          </div>

          {remainMs !== null && remainMs > 0 && (
            <div className="mt-10">
              <p className="flex items-center justify-center gap-2.5 text-center text-[11px] font-extrabold uppercase tracking-[0.34em]" style={{ color: GOLD_LIGHT }}>
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: GOLD }} />
                {countdownLabel}
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
                    className="min-w-0 rounded-xl border border-white/10 bg-white/[0.04] px-1 py-3 text-center shadow-[0_16px_40px_rgba(0,0,0,0.4)] backdrop-blur-md sm:py-3.5"
                  >
                    <p className={`text-2xl font-semibold tabular-nums sm:text-3xl ${displayFont}`} style={{ color: IVORY }}>
                      {String(part.value).padStart(2, '0')}
                    </p>
                    <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.16em] text-[#CBBFA5] sm:text-[10px] sm:tracking-[0.24em]">
                      {part.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Card className={`mt-10 ${cardClass}`}>
            <CardContent className="py-5">
              <p className="text-center text-sm font-semibold leading-relaxed" style={{ color: GOLD_LIGHT }}>
                {FEE_CALLOUT}
              </p>
            </CardContent>
          </Card>

          {success ? (
            <Card className={`mt-10 ${cardClass}`} >
              <CardHeader className="border-b border-[#C9A45C]/25 pb-6 text-center">
                <CardTitle className={`text-3xl font-semibold ${displayFont}`} style={{ color: GOLD_LIGHT }}>
                  Enrolment received
                </CardTitle>
                <CardDescription className="mx-auto max-w-md text-[15px] leading-relaxed text-[#CFC8B8]">
                  Your place is held while the enrolment is verified. Keep this registration ID for all
                  correspondence about the masterclass series.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6 text-center">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#CBBFA5]">Registration ID</p>
                <p className="mt-2 break-all font-mono text-xl" style={{ color: GOLD_LIGHT }}>
                  {success.registrationId}
                </p>
                <p className="mt-5 text-sm text-[#CFC8B8]">
                  {fullName} ({NATION_LABELS[nation]} · {passType === 'student' ? 'Collegiate Student Pass' : 'Industry Professional Observer Pass'})
                </p>
              </CardContent>
            </Card>
          ) : closed ? (
            <Card className={`mt-10 ${cardClass}`}>
              <CardHeader className="text-center">
                <CardTitle className={`text-3xl font-semibold ${displayFont}`} style={{ color: GOLD_LIGHT }}>
                  Registration is closed
                </CardTitle>
                <CardDescription className="mx-auto max-w-md text-[15px] leading-relaxed text-[#CFC8B8]">
                  {closedLine}
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <form onSubmit={handleSubmit} className="mt-10 space-y-8">
              <Card className={cardClass}>
                <CardHeader className="pb-2">
                  <CardTitle className={`text-2xl font-semibold ${displayFont}`}>Your enrolment</CardTitle>
                  <CardDescription className="text-sm leading-relaxed text-[#A79E8B]">
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
                              ? 'border-[#C9A45C]/80 bg-[#C9A45C]/10 shadow-[0_10px_30px_rgba(201,164,92,0.22)]'
                              : 'border-white/15 bg-white/[0.05] hover:border-white/35'
                          }`}
                          style={{ color: IVORY }}
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
              </Card>

              <Card className={cardClass}>
                <CardHeader className="pb-2">
                  <CardTitle className={`text-2xl font-semibold ${displayFont}`}>About you</CardTitle>
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
              </Card>

              {errors.length > 0 && (
                <Card className="rounded-2xl border-red-400/30 bg-red-500/[0.08] backdrop-blur-md">
                  <CardContent className="py-5">
                    <p className="text-sm font-bold text-red-200">Please fix the following:</p>
                    <ul className="mt-2 list-inside list-disc text-sm text-red-200/85">
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
                className="h-[52px] w-full rounded-full bg-[linear-gradient(120deg,#E8CF8F,#C9A45C_45%,#A87F35)] text-sm font-extrabold uppercase tracking-[0.14em] text-[#171106] shadow-[0_16px_40px_rgba(201,164,92,0.35)] transition hover:brightness-110 disabled:opacity-60"
              >
                {submitting ? 'Submitting...' : 'Enrol now'}
              </Button>
              <p className="text-center text-xs text-[#8E887A]">
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
