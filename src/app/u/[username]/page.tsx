'use client';

import { useEffect, useState, use as usePromise } from 'react';
import Link from 'next/link';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Award, MapPin, BookOpen, Trophy, Rocket, ExternalLink, CheckCircle2, Clock } from 'lucide-react';
import { getRoleDisplayName } from '@/lib/roles';

/**
 * WS3 public portfolio at /u/:username.
 * Renders the sanitised public view from GET /api/public/portfolio/[username]:
 * no contact details, no warnings, proof-free mission timeline. Never
 * authenticated: works for logged-out visitors and share links.
 */
export default function PublicPortfolioPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = usePromise(params);
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/portfolio/${encodeURIComponent(username)}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error('Failed to load');
        const body = await res.json();
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-4xl space-y-4">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  if (notFound || !data?.profile) {
    return (
      <div className="container mx-auto px-4 py-24 max-w-xl text-center">
        <Rocket className="h-12 w-12 text-slate-600 mx-auto mb-4 opacity-40" />
        <h1 className="text-2xl font-bold mb-2">Portfolio not found</h1>
        <p className="text-muted-foreground mb-6">
          This member has not published a public portfolio.
        </p>
        <Link href="/join">
          <Button>Join SEDS Pakistan</Button>
        </Link>
      </div>
    );
  }

  const { profile, skillNames, telemetry, missionTimeline, certificates } = data;
  const initials = String(profile.displayName || 'M')
    .split(' ')
    .map((p: string) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-6">
      <Card className="border-border bg-background/70 backdrop-blur-md overflow-hidden">
        {profile.bannerURL && (
          <div className="relative h-32 md:h-44 w-full">
            <img src={profile.bannerURL} alt="" className="h-full w-full object-cover" />
          </div>
        )}
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row md:items-center gap-5">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile.photoURL || undefined} alt={profile.displayName} />
              <AvatarFallback className="text-xl font-bold">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl md:text-3xl font-heading font-bold text-foreground truncate">
                {profile.displayName}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {profile.customTitle || getRoleDisplayName(profile.role || 'member', profile.uid)}
                {' '}at SEDS Pakistan
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                {profile.university && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> {profile.university}
                  </span>
                )}
                {profile.fieldOfStudy && (
                  <span className="inline-flex items-center gap-1">
                    <BookOpen className="h-3 w-3" /> {profile.fieldOfStudy}
                  </span>
                )}
                <span>{profile.points} points</span>
              </div>
              {profile.bio && <p className="text-sm text-foreground/80 mt-3 max-w-2xl">{profile.bio}</p>}
              <div className="flex gap-2 mt-3">
                {profile.githubUrl && (
                  <a href={profile.githubUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
                    GitHub
                  </a>
                )}
                {profile.linkedinUrl && (
                  <a href={profile.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
                    LinkedIn
                  </a>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Missions completed', value: `${telemetry.tasksCompleted}`, sub: `of ${telemetry.tasksAssigned} assigned` },
          { label: 'On-time rate', value: telemetry.onTimeRate === null ? 'No data yet' : `${Math.round(telemetry.onTimeRate * 100)}%`, sub: null },
          { label: 'Hours logged', value: `${telemetry.loggedHours}h`, sub: null },
          { label: 'Quality index', value: telemetry.qualityIndex === null ? 'No data yet' : `${telemetry.qualityIndex}/100`, sub: telemetry.qualityIndexBasis === 'derived' ? 'Derived metric' : null },
        ].map((c) => (
          <Card key={c.label} className="border-border bg-background/60">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{c.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">{c.value}</p>
              {c.sub && <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {profile.badges.length > 0 && (
        <Card className="border-border bg-background/60">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="h-5 w-5 text-amber-400" /> Badges
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {profile.badges.map((b: string) => (
                <Badge key={b} variant="secondary">{b}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {profile.skillIds.length > 0 && (
        <Card className="border-border bg-background/60">
          <CardHeader>
            <CardTitle className="text-base">Skills</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {profile.skillIds.map((s: string) => (
                <Badge key={s} variant="outline">{skillNames?.[s] || s}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {missionTimeline.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-heading font-bold text-foreground">Mission record</h2>
          {missionTimeline.slice(0, 12).map((e: any) => (
            <Card key={e.taskId} className="border-border bg-background/60">
              <CardContent className="pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground text-sm">{e.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {e.workflowTitle ? `${e.workflowTitle} · ` : ''}
                      {e.completedAt ? new Date(e.completedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date unknown'}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {e.wasOnTime === true ? <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-400" /> : <Clock className="h-3 w-3 mr-1 text-amber-400" />}
                    {e.wasOnTime === true ? 'On time' : e.wasOnTime === false ? 'Late' : 'No deadline'}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {certificates.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-heading font-bold text-foreground flex items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-400" /> Certificates
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {certificates.map((c: any) => (
              <Card key={c.id || c.code} className="border-border bg-background/60">
                <CardContent className="pt-5">
                  <p className="font-semibold text-foreground text-sm">{c.title}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {c.issueDate ? new Date(c.issueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : ''}
                    {c.issuingAuthority ? ` · ${c.issuingAuthority}` : ''}
                  </p>
                  <Link href={c.verificationUrl || '#'} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    Verify certificate <ExternalLink className="h-3 w-3" />
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="pt-5 text-center">
          <p className="text-sm text-muted-foreground mb-3">
            This is a public portfolio on the SEDS Pakistan platform.
          </p>
          <Link href="/join">
            <Button>Join SEDS Pakistan</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
