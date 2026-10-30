'use client';

import { useEffect, useState } from 'react';
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

const selectClass =
  'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm [&>option]:bg-background [&>option]:text-foreground';

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
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      <StarryBackground />
      <main className="container relative z-10 mx-auto flex-1 px-4 py-10">
        <div className="mx-auto max-w-3xl">
          <p className="text-center text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            SEDS Pakistan and SEDS Sri Lanka
          </p>
          <h1 className="mt-3 text-center font-headline text-3xl font-bold leading-tight sm:text-4xl">
            {GRAND_PRIX_NAME}
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted-foreground">
            One common registration intake for both nations. Register a squad of exactly {SQUAD_SIZE} students,
            pick one track, and hold your seat in the 30 squad bracket. Registration closes on Nov 15, 2026 at
            23:59 PKT, or as soon as the bracket fills.
          </p>

          {status && (
            <div className="mt-6 grid grid-cols-1 gap-3 text-center sm:grid-cols-3">
              <Card>
                <CardContent className="py-4">
                  <p className="text-2xl font-bold text-primary">
                    {status.totalRegistered} / {status.seatsTotal}
                  </p>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Squads registered</p>
                </CardContent>
              </Card>
              {(Object.keys(NATION_LABELS) as Nation[]).map((n) => (
                <Card key={n}>
                  <CardContent className="py-4">
                    <p className="text-2xl font-bold text-primary">
                      {status.byNation[n].registered} / {status.byNation[n].cap}
                    </p>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">{NATION_LABELS[n]}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {success ? (
            <Card className="mt-8 border-primary/50">
              <CardHeader>
                <CardTitle className="text-primary">Squad registered</CardTitle>
                <CardDescription className="text-muted-foreground">
                  Your seat is held while the registration is verified. Keep this registration ID for all
                  correspondence about the Grand Prix.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Registration ID</p>
                <p className="break-all font-mono text-lg text-foreground">{success.registrationId}</p>
                <p className="mt-4 text-sm text-muted-foreground">
                  Squad: {squadName} ({NATION_LABELS[nation]}, {TRACK_LABELS[track]})
                </p>
              </CardContent>
            </Card>
          ) : closed ? (
            <Card className="mt-8 border-primary/50">
              <CardHeader>
                <CardTitle className="text-primary">Registration is closed</CardTitle>
                <CardDescription className="text-muted-foreground">
                  The bracket is full or the Nov 15, 2026 deadline has passed. No further squads can be accepted.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <form onSubmit={handleSubmit} className="mt-8 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Squad</CardTitle>
                  <CardDescription className="text-muted-foreground">
                    One squad per lead email. Squad names and student IDs must be unique across the bracket.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="squadName">Squad name</Label>
                    <Input id="squadName" value={squadName} onChange={(e) => setSquadName(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="nation">Nation</Label>
                    <select id="nation" className={selectClass} value={nation} onChange={(e) => setNation(e.target.value as Nation)}>
                      <option value="PK">Pakistan</option>
                      <option value="LK">Sri Lanka</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="track">Track (pick one)</Label>
                    <select id="track" className={selectClass} value={track} onChange={(e) => setTrack(e.target.value as Track)}>
                      {(Object.keys(TRACK_LABELS) as Track[]).map((t) => (
                        <option key={t} value={t}>
                          {TRACK_LABELS[t]}
                          {status ? ` (${status.byTrack[t].registered}/${status.byTrack[t].cap} squads)` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="city">City</Label>
                    <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="institutionName">Institution name</Label>
                    <Input id="institutionName" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="institutionId">Institution verification ID</Label>
                    <Input id="institutionId" value={institutionId} onChange={(e) => setInstitutionId(e.target.value)} required />
                  </div>
                </CardContent>
              </Card>

              {members.map((member, i) => (
                <Card key={i}>
                  <CardHeader>
                    <CardTitle className="text-lg">
                      Seat {i + 1}
                      {i === 0 && (
                        <span className="ml-2 text-sm font-semibold text-primary">
                          Squad Lead
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`m${i}-name`}>Full name</Label>
                      <Input id={`m${i}-name`} value={member.fullName} onChange={(e) => setMember(i, 'fullName', e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`m${i}-sid`}>Student ID</Label>
                      <Input id={`m${i}-sid`} value={member.studentId} onChange={(e) => setMember(i, 'studentId', e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`m${i}-email`}>Email</Label>
                      <Input id={`m${i}-email`} type="email" value={member.email} onChange={(e) => setMember(i, 'email', e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`m${i}-disc`}>Discipline or role in the squad</Label>
                      <Input id={`m${i}-disc`} value={member.discipline} onChange={(e) => setMember(i, 'discipline', e.target.value)} required />
                    </div>
                    {i === 0 && (
                      <div className="space-y-2">
                        <Label htmlFor="m0-wa">WhatsApp number (lead)</Label>
                        <Input id="m0-wa" value={member.whatsapp} onChange={(e) => setMember(0, 'whatsapp', e.target.value)} required />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}

              {errors.length > 0 && (
                <Card className="border-red-500/50 bg-red-950/40">
                  <CardContent className="py-4">
                    <p className="text-sm font-semibold text-red-300">Please fix the following:</p>
                    <ul className="mt-2 list-inside list-disc text-sm text-red-200">
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
                className="w-full text-base font-bold"
              >
                {submitting ? 'Submitting...' : 'Register squad'}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
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
