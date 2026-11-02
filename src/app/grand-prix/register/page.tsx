'use client';

import { useEffect, useState } from 'react';
import { Fraunces, Manrope } from 'next/font/google';
import StarryBackground from '@/components/starry-background';
import Footer from '@/components/layout/footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  GRAND_PRIX_NAME,
  NATION_LABELS,
  SQUAD_SIZE,
  TRACK_LABELS,
  type Nation,
  type Track,
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

interface MemberForm {
  fullName: string;
  studentId: string;
  email: string;
  discipline: string;
  whatsapp: string;
}

const emptyMember = (): MemberForm => ({
  fullName: '',
  studentId: '',
  email: '',
  discipline: '',
  whatsapp: '',
});

interface BracketStatus {
  open: boolean;
  totalRegistered: number;
  seatsTotal: number;
  byNation: Record<Nation, { registered: number; cap: number }>;
  byTrack: Record<Track, { registered: number; cap: number }>;
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

export default function GrandPrixRegisterPage() {
  const [squadName, setSquadName] = useState('');
  const [nation, setNation] = useState<Nation>('PK');
  const [track, setTrack] = useState<Track>('rocketry');
  const [institutionName, setInstitutionName] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [city, setCity] = useState('');
  const [members, setMembers] = useState<MemberForm[]>(() =>
    Array.from({ length: SQUAD_SIZE }, emptyMember),
  );
  const [status, setStatus] = useState<BracketStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [success, setSuccess] = useState<{ registrationId: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/grand-prix/registrations')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (live && data && data.ok) setStatus(data as BracketStatus);
      })
      .catch(() => {
        /* Bracket counts are informational; the server enforces the caps. */
      });
    return () => {
      live = false;
    };
  }, []);

  const setMember = (i: number, field: keyof MemberForm, value: string) => {
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSubmitting(true);
    try {
      const res = await fetch('/api/grand-prix/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          squadName,
          nation,
          track,
          institutionName,
          institutionId,
          city,
          members: members.map((m, i) =>
            i === 0 ? m : { fullName: m.fullName, studentId: m.studentId, email: m.email, discipline: m.discipline },
          ),
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
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_55%_40%_at_50%_-5%,rgba(201,164,92,0.14),transparent),linear-gradient(180deg,rgba(6,9,16,0.35),rgba(6,9,16,0.78))]" />
      <main className="container relative z-10 mx-auto flex-1 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-center gap-4">
            <span className="h-px w-12 bg-gradient-to-r from-transparent to-[#C9A45C]/80" />
            <p
              className="text-center text-[11px] font-extrabold uppercase tracking-[0.42em]"
              style={{ color: GOLD_LIGHT }}
            >
              SEDS Pakistan and SEDS Sri Lanka
            </p>
            <span className="h-px w-12 bg-gradient-to-l from-transparent to-[#C9A45C]/80" />
          </div>
          <h1
            className={`mt-6 bg-gradient-to-r from-[#E8CF8F] via-[#C9A45C] to-[#E8CF8F] bg-clip-text text-center text-4xl font-semibold leading-[1.08] text-transparent sm:text-[3.4rem] ${displayFont}`}
          >
            {GRAND_PRIX_NAME}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-center text-[15px] leading-relaxed text-[#CFC8B8]">
            One common registration intake for both nations. Register a squad of exactly {SQUAD_SIZE} students,
            pick one track, and hold your seat in the 30 squad bracket. Registration closes on Nov 15, 2026 at
            23:59 PKT, or as soon as the bracket fills.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3" aria-hidden="true">
            <span className="h-px w-24 bg-white/15" />
            <span className="block h-1.5 w-1.5 rotate-45" style={{ backgroundColor: GOLD }} />
            <span className="h-px w-24 bg-white/15" />
          </div>

          {status && (
            <div className="mt-10 grid grid-cols-1 gap-4 text-center sm:grid-cols-3">
              <Card className={cardClass}>
                <CardContent className="py-6">
                  <p className={`text-4xl font-semibold ${displayFont}`} style={{ color: IVORY }}>
                    {status.totalRegistered} <span className="text-2xl text-[#8E887A]">/ {status.seatsTotal}</span>
                  </p>
                  <div className="mx-auto mt-3 h-px w-10" style={{ backgroundColor: GOLD }} />
                  <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[#CBBFA5]">
                    Squads registered
                  </p>
                </CardContent>
              </Card>
              {(Object.keys(NATION_LABELS) as Nation[]).map((n) => (
                <Card key={n} className={cardClass}>
                  <CardContent className="py-6">
                    <p className={`text-4xl font-semibold ${displayFont}`} style={{ color: IVORY }}>
                      {status.byNation[n].registered}{' '}
                      <span className="text-2xl text-[#8E887A]">/ {status.byNation[n].cap}</span>
                    </p>
                    <div className="mx-auto mt-3 h-px w-10" style={{ backgroundColor: GOLD }} />
                    <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[#CBBFA5]">
                      {NATION_LABELS[n]}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {success ? (
            <Card className={`mt-10 ${cardClass}`} >
              <CardHeader className="border-b border-[#C9A45C]/25 pb-6 text-center">
                <CardTitle className={`text-3xl font-semibold ${displayFont}`} style={{ color: GOLD_LIGHT }}>
                  Squad registered
                </CardTitle>
                <CardDescription className="mx-auto max-w-md text-[15px] leading-relaxed text-[#CFC8B8]">
                  Your seat is held while the registration is verified. Keep this registration ID for all
                  correspondence about the Grand Prix.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6 text-center">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#CBBFA5]">Registration ID</p>
                <p className="mt-2 break-all font-mono text-xl" style={{ color: GOLD_LIGHT }}>
                  {success.registrationId}
                </p>
                <p className="mt-5 text-sm text-[#CFC8B8]">
                  Squad: {squadName} ({NATION_LABELS[nation]}, {TRACK_LABELS[track]})
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
                  The bracket is full or the Nov 15, 2026 deadline has passed. No further squads can be accepted.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <form onSubmit={handleSubmit} className="mt-10 space-y-8">
              <Card className={cardClass}>
                <CardHeader className="pb-2">
                  <CardTitle className={`text-2xl font-semibold ${displayFont}`}>The Squad</CardTitle>
                  <CardDescription className="text-sm leading-relaxed text-[#A79E8B]">
                    One squad per lead email. Squad names and student IDs must be unique across the bracket.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-5 pt-4 sm:grid-cols-2">
                  <div className="space-y-2.5">
                    <Label htmlFor="squadName" className={labelClass}>Squad name</Label>
                    <Input id="squadName" className={fieldClass} placeholder="e.g. Falcon IST" value={squadName} onChange={(e) => setSquadName(e.target.value)} required />
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="nation" className={labelClass}>Nation</Label>
                    <select id="nation" className={selectClass} value={nation} onChange={(e) => setNation(e.target.value as Nation)}>
                      <option value="PK">Pakistan</option>
                      <option value="LK">Sri Lanka</option>
                    </select>
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="track" className={labelClass}>Track (pick one)</Label>
                    <select id="track" className={selectClass} value={track} onChange={(e) => setTrack(e.target.value as Track)}>
                      {(Object.keys(TRACK_LABELS) as Track[]).map((t) => (
                        <option key={t} value={t}>
                          {TRACK_LABELS[t]}
                          {status ? ` (${status.byTrack[t].registered}/${status.byTrack[t].cap} squads)` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="city" className={labelClass}>City</Label>
                    <Input id="city" className={fieldClass} placeholder="e.g. Islamabad" value={city} onChange={(e) => setCity(e.target.value)} required />
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

              {members.map((member, i) => (
                <Card key={i} className={cardClass}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex flex-wrap items-center gap-3">
                      <span className={`text-2xl font-semibold ${displayFont}`}>
                        Seat {i + 1}
                      </span>
                      {i === 0 && (
                        <span
                          className="rounded-full border px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.2em]"
                          style={{ borderColor: 'rgba(201,164,92,0.55)', color: GOLD_LIGHT }}
                        >
                          Squad Lead
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 gap-5 pt-4 sm:grid-cols-2">
                    <div className="space-y-2.5">
                      <Label htmlFor={`m${i}-name`} className={labelClass}>Full name</Label>
                      <Input id={`m${i}-name`} className={fieldClass} placeholder="Full name, as on the student ID card" value={member.fullName} onChange={(e) => setMember(i, 'fullName', e.target.value)} required />
                    </div>
                    <div className="space-y-2.5">
                      <Label htmlFor={`m${i}-sid`} className={labelClass}>Student ID</Label>
                      <Input id={`m${i}-sid`} className={fieldClass} placeholder="Student ID / registration number" value={member.studentId} onChange={(e) => setMember(i, 'studentId', e.target.value)} required />
                    </div>
                    <div className="space-y-2.5">
                      <Label htmlFor={`m${i}-email`} className={labelClass}>Email</Label>
                      <Input id={`m${i}-email`} type="email" className={fieldClass} placeholder="e.g. yourname@gmail.com" value={member.email} onChange={(e) => setMember(i, 'email', e.target.value)} required />
                    </div>
                    <div className="space-y-2.5">
                      <Label htmlFor={`m${i}-disc`} className={labelClass}>Discipline or role in the squad</Label>
                      <Input id={`m${i}-disc`} className={fieldClass} placeholder="e.g. Avionics, Structures, Software, Propulsion" value={member.discipline} onChange={(e) => setMember(i, 'discipline', e.target.value)} required />
                    </div>
                    {i === 0 && (
                      <div className="space-y-2.5">
                        <Label htmlFor="m0-wa" className={labelClass}>WhatsApp number (lead)</Label>
                        <Input id="m0-wa" className={fieldClass} placeholder="+92 3XX XXXXXXX or +94 7X XXXXXXX" value={member.whatsapp} onChange={(e) => setMember(0, 'whatsapp', e.target.value)} required />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}

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
                {submitting ? 'Submitting...' : 'Register squad'}
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
