'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useUserContext } from '@/firebase/user-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { RocketLoader } from '@/components/ui/rocket-loader';
import {
  LayoutDashboard,
  ScrollText,
  Award,
  Trophy,
  Settings as SettingsIcon,
  ExternalLink,
  MapPin,
  BookOpen,
} from 'lucide-react';
import { getRoleDisplayName } from '@/lib/roles';
import {
  resolvePublicDirectoryOptIn,
  usernameForUser,
  type ProbationSummary,
  type Telemetry,
  type MissionTimelineEntry,
} from '@/lib/profile-hub/telemetry';
import { TelemetryCards } from './telemetry-cards';
import { ProbationCard } from './probation-card';
import { MissionTimeline } from './mission-timeline';
import { CredentialVault } from './credential-vault';
import { HubPrivacySettings } from './hub-settings';

const ProfileEditForm = dynamic(() => import('@/components/profile/profile-edit-form'), {
  loading: () => <Skeleton className="h-96 w-full" />,
});

type VaultCertificate = ReturnType<
  typeof import('@/lib/profile-hub/telemetry').sanitizeCertificateForVault
>;

interface HubData {
  profile: any;
  badges: any[];
  skills: any[];
  chapter: any;
  telemetry: Telemetry | null;
  missionTimeline: MissionTimelineEntry[];
  probation: ProbationSummary | null;
  certificates: VaultCertificate[];
}

/**
 * Member Profile Hub (WS3). The consolidated private profile:
 * Overview | Mission Log | Skills and Badges | Credentials | Settings.
 *
 * Data: profile shell from the existing /api/profile/[userId] route, and
 * telemetry / timeline / probation / vault certificates from the gated
 * /api/profile/[userId]/telemetry route (owner or admin only).
 */
export function ProfileHub({ uid }: { uid: string }) {
  const router = useRouter();
  const { user: currentUser, isLoading: userLoading } = useUserContext();
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const editFormRef = useRef<(() => any) | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsMessage, setDetailsMessage] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const handleSaveDetails = async () => {
    if (!currentUser || !editFormRef.current) return;
    try {
      setSavingDetails(true);
      setDetailsMessage(null);
      setDetailsError(null);
      const values = editFormRef.current();
      const whatsapp = String(values?.whatsappNumber || '').trim();
      if (whatsapp && !/^\+?[0-9\s-]{6,}$/.test(whatsapp)) {
        setDetailsError('Please enter a valid WhatsApp number.');
        return;
      }
      const token = await currentUser.getIdToken(true);
      const res = await fetch(`/api/profile/${uid}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error('Save failed');
      setDetailsMessage('Profile details saved.');
    } catch {
      setDetailsError('Could not save profile details. Try again.');
    } finally {
      setSavingDetails(false);
    }
  };

  useEffect(() => {
    if (!uid || userLoading || !currentUser) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await currentUser.getIdToken(false).catch(() => null);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const [profileRes, telemetryRes] = await Promise.all([
          fetch(`/api/profile/${uid}`, { headers }),
          fetch(`/api/profile/${uid}/telemetry`, { headers }),
        ]);
        if (!profileRes.ok) throw new Error('Failed to load profile');
        const profileData = await profileRes.json();
        const telemetryData = telemetryRes.ok ? await telemetryRes.json() : null;

        if (cancelled) return;
        setData({
          profile: profileData.profile || null,
          badges: profileData.badges || [],
          skills: profileData.skills || [],
          chapter: profileData.chapter || null,
          telemetry: telemetryData?.telemetry ?? null,
          missionTimeline: telemetryData?.missionTimeline ?? [],
          probation: telemetryData?.probation ?? null,
          certificates: telemetryData?.certificates ?? [],
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, currentUser, userLoading]);

  if (loading || userLoading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <RocketLoader />
      </div>
    );
  }
  if (!currentUser) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <h2 className="text-2xl font-bold mb-2">Access restricted</h2>
        <p className="text-muted-foreground mb-6">Please sign in to view your profile hub.</p>
        <Button onClick={() => router.push('/auth')}>Sign in</Button>
      </div>
    );
  }
  if (error || !data?.profile) {
    return (
      <div className="container mx-auto px-4 py-12 max-w-3xl text-center">
        <p className="text-red-400">{error || 'Profile not found.'}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  const { profile, badges, skills, chapter } = data;
  const username = usernameForUser(profile);
  const optedIn = resolvePublicDirectoryOptIn(profile);
  const initials = String(profile.displayName || 'M')
    .split(' ')
    .map((p: string) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl space-y-6">
      <Card className="border-border bg-background/70 backdrop-blur-md overflow-hidden">
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row md:items-center gap-5">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile.photoURL || undefined} alt={profile.displayName || 'Member'} />
              <AvatarFallback className="text-xl font-bold">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl md:text-3xl font-heading font-bold text-foreground truncate">
                {profile.displayName || 'Member'}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {getRoleDisplayName(profile.role || 'member', uid)}
                {chapter?.name ? ` · ${chapter.name}` : ''}
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
                <span>{profile.points || 0} points</span>
              </div>
              {profile.bio && <p className="text-sm text-foreground/80 mt-3 max-w-2xl">{profile.bio}</p>}
            </div>
            <div className="shrink-0 flex flex-col gap-2">
              {optedIn && username ? (
                <Link href={`/u/${username}`}>
                  <Button variant="outline" size="sm" className="gap-1.5 w-full">
                    <ExternalLink className="h-3.5 w-3.5" /> Public portfolio
                  </Button>
                </Link>
              ) : (
                <p className="text-xs text-muted-foreground max-w-[180px]">
                  Public portfolio is off. Turn it on in Settings.
                </p>
              )}
              <Link href="/profile/unified">
                <Button variant="ghost" size="sm" className="w-full">
                  Classic profile view
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="w-full justify-start bg-background/80 border border-border p-1.5 h-auto rounded-xl backdrop-blur-md mb-6 gap-2 flex-wrap">
          <TabsTrigger value="overview" className="flex items-center gap-2 py-2.5 px-4 rounded-lg">
            <LayoutDashboard className="h-4 w-4" /> Overview
          </TabsTrigger>
          <TabsTrigger value="mission-log" className="flex items-center gap-2 py-2.5 px-4 rounded-lg">
            <ScrollText className="h-4 w-4" /> Mission Log
          </TabsTrigger>
          <TabsTrigger value="skills-badges" className="flex items-center gap-2 py-2.5 px-4 rounded-lg">
            <Award className="h-4 w-4" /> Skills and Badges
          </TabsTrigger>
          <TabsTrigger value="credentials" className="flex items-center gap-2 py-2.5 px-4 rounded-lg">
            <Trophy className="h-4 w-4" /> Credentials
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2 py-2.5 px-4 rounded-lg">
            <SettingsIcon className="h-4 w-4" /> Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <TelemetryCards telemetry={data.telemetry} />
          <ProbationCard probation={data.probation} />
          <div>
            <h2 className="text-lg font-heading font-bold text-foreground mb-3">Recent missions</h2>
            <MissionTimeline entries={data.missionTimeline.slice(0, 3)} />
          </div>
        </TabsContent>

        <TabsContent value="mission-log" className="space-y-6">
          <MissionTimeline entries={data.missionTimeline} />
        </TabsContent>

        <TabsContent value="skills-badges" className="space-y-6">
          <Card className="border-border bg-background/60">
            <CardHeader>
              <CardTitle className="text-base">Badges</CardTitle>
            </CardHeader>
            <CardContent>
              {badges.length > 0 ? (
                <div className="flex flex-wrap gap-3">
                  {badges.map((b: any) => (
                    <Badge key={b.slug || b.name} variant="secondary" className="gap-1.5 py-1.5 px-3">
                      <Award className="h-3.5 w-3.5" /> {b.name || b.slug}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No badges yet. Complete missions to earn badges.</p>
              )}
            </CardContent>
          </Card>
          <Card className="border-border bg-background/60">
            <CardHeader>
              <CardTitle className="text-base">Skills</CardTitle>
            </CardHeader>
            <CardContent>
              {skills.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {skills.map((s: any) => (
                    <Badge key={s.id} variant="outline" className="py-1.5 px-3">
                      {s.name}
                      {s.category ? <span className="ml-1.5 text-muted-foreground">{s.category}</span> : null}
                      {s.unlinked ? <span className="ml-1.5 text-amber-400">unverified</span> : null}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No skills claimed yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="credentials" className="space-y-6">
          <CredentialVault certificates={data.certificates} uid={uid} />
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <HubPrivacySettings
            uid={uid}
            initialUsername={typeof profile.username === 'string' ? profile.username : username}
            initialOptIn={typeof profile.publicDirectoryOptIn === 'boolean' ? profile.publicDirectoryOptIn : optedIn}
          />
          <Card className="border-border bg-background/60">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Profile details</CardTitle>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => router.refresh()}>
                  Reset
                </Button>
                <Button size="sm" onClick={handleSaveDetails} disabled={savingDetails}>
                  {savingDetails ? 'Saving...' : 'Save details'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {detailsMessage && <p className="text-sm text-emerald-400">{detailsMessage}</p>}
              {detailsError && <p className="text-sm text-red-400">{detailsError}</p>}
              <ProfileEditForm
                initialForm={{
                  displayName: profile.displayName || '',
                  bio: profile.bio || '',
                  githubUrl: profile.githubUrl || '',
                  linkedinUrl: profile.linkedinUrl || '',
                  whatsappNumber: profile.whatsappNumber || '',
                  university: profile.university || '',
                  fieldOfStudy: profile.fieldOfStudy || '',
                  chapterId: chapter?.id || profile.chapterId || '',
                  role: profile.role || '',
                  publicDirectoryOptIn: optedIn,
                }}
                onGetValuesRef={(getValues: () => any) => {
                  editFormRef.current = getValues;
                }}
                chapters={(chapter?.allChapters || []).map((c: any) => ({ id: c.id, name: c.name }))}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
