"use client";

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth } from 'firebase/auth';
import { getFirebaseApp } from '@/firebase/provider';
import { useUser } from '@/firebase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';
import type { ApplicantStatusPayload } from '@/lib/applicant-status';
import StageTracker from './stage-tracker';
import DocumentsSection from './documents-section';
import DomainPreferencesSection from './domain-preferences-section';
import OnboardingChecklist from './onboarding-checklist';
import StatusLookupForm from './status-lookup-form';

interface StatusResponse {
  application?: ApplicantStatusPayload;
  error?: string;
}

async function parseResponse(res: Response): Promise<StatusResponse> {
  return (await res.json().catch(() => ({}))) as StatusResponse;
}

async function idToken(): Promise<string | null> {
  try {
    const token = await getAuth(getFirebaseApp()).currentUser?.getIdToken();
    return token ?? null;
  } catch {
    return null;
  }
}

export default function ApplicantPortal() {
  const { user, isLoading: userLoading } = useUser();
  const router = useRouter();
  const { toast } = useToast();

  const [payload, setPayload] = useState<ApplicantStatusPayload | null>(null);
  const [ownMissing, setOwnMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [fromLookup, setFromLookup] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [docsSaving, setDocsSaving] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  // Signed-in applicants load their own application automatically, scoped
  // server-side to their token UID.
  const loadOwn = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const token = await idToken();
      if (!token) {
        setLoadError('We could not verify your sign-in. Sign out and back in, then try again.');
        return;
      }
      const res = await fetch('/api/applications/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await parseResponse(res);
      if (res.status === 404) {
        setOwnMissing(true);
        setPayload(null);
        return;
      }
      if (!res.ok || !body.application) {
        setLoadError(body.error || 'Could not load your application status.');
        return;
      }
      setPayload(body.application);
      setOwnMissing(false);
      setFromLookup(false);
    } catch {
      setLoadError('Could not load your application status. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!userLoading && user) {
      loadOwn();
    }
  }, [user, userLoading, loadOwn]);

  const handleLookup = async (referenceId: string, email: string) => {
    setLoading(true);
    setLookupError(null);
    try {
      const res = await fetch('/api/applications/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId: referenceId.trim().toUpperCase(), email: email.trim() }),
      });
      const body = await parseResponse(res);
      if (!res.ok || !body.application) {
        setLookupError(body.error || 'No application matches that reference ID and email.');
        return;
      }
      setPayload(body.application);
      setFromLookup(true);
    } catch {
      setLookupError('Lookup failed. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const patch = useCallback(
    async (patchBody: Record<string, unknown>): Promise<ApplicantStatusPayload | null> => {
      const token = await idToken();
      if (!token) {
        toast({
          variant: 'destructive',
          title: 'Sign-in needed',
          description: 'Sign in with the account you applied with to make changes.',
        });
        return null;
      }
      const res = await fetch('/api/applications/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patchBody),
      });
      const body = await parseResponse(res);
      if (!res.ok || !body.application) {
        throw new Error(body.error || 'Could not save your changes.');
      }
      setPayload(body.application);
      setRefreshKey((k) => k + 1);
      return body.application;
    },
    [toast]
  );

  const saveDocuments = async (documents: {
    resumeUrl: string;
    transcriptUrl: string;
    portfolioLink: string;
    githubLink: string;
  }) => {
    setDocsError(null);
    setDocsSaving(true);
    try {
      await patch({ documents });
      toast({ title: 'Documents saved', description: 'Your application documents are up to date.' });
    } catch (err: any) {
      setDocsError(err?.message || 'Could not save your documents.');
    } finally {
      setDocsSaving(false);
    }
  };

  const savePreferences = async (preferences: string[]) => {
    setPrefsError(null);
    setPrefsSaving(true);
    try {
      await patch({ domainPreferences: preferences });
      toast({ title: 'Preferences saved', description: 'Your domain preferences are up to date.' });
    } catch (err: any) {
      setPrefsError(err?.message || 'Could not save your preferences.');
    } finally {
      setPrefsSaving(false);
    }
  };

  const toggleMilestone = async (key: string, done: boolean) => {
    try {
      await patch({ milestones: { [key]: done } });
      toast({ title: done ? 'Step completed' : 'Step reopened', description: 'Your checklist is saved.' });
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Could not update checklist',
        description: err?.message || 'Try again in a moment.',
      });
    }
  };

  if (userLoading) {
    return (
      <div role="status" className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        <span className="sr-only">Loading...</span>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <StatusLookupForm loading={loading && !user} error={lookupError} onLookup={handleLookup} />
        {user && loading && (
          <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading your application...
          </p>
        )}
        {user && loadError && (
          <Card className="border-destructive/40">
            <CardContent className="space-y-3 pt-6 text-center">
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" onClick={loadOwn}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}
        {user && ownMissing && !loading && (
          <Card className="border-primary/20">
            <CardContent className="space-y-3 pt-6 text-center">
              <p className="text-muted-foreground">
                No application found for this account yet. Start your induction application to begin.
              </p>
              <Button onClick={() => router.push('/induction')}>Start application</Button>
            </CardContent>
          </Card>
        )}
        {!user && (
          <p className="text-center text-sm text-muted-foreground">
            To update documents, preferences, or your checklist,{' '}
            <a href="/auth/login?callbackUrl=/apply/status" className="text-primary underline">
              sign in
            </a>{' '}
            with the account you applied with.
          </p>
        )}
      </div>
    );
  }

  const currentStage = payload.stages[payload.currentStageIndex];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <Card className="border-primary/20 bg-card/80 backdrop-blur-sm">
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-bold text-foreground">{payload.fullName || 'Applicant'}</h2>
              <p className="text-sm text-muted-foreground">
                {payload.university || 'University not listed'}
              </p>
            </div>
            <div className="text-right">
              <Badge variant="secondary" className="uppercase tracking-wide">
                {payload.terminalRejected ? 'Not accepted' : currentStage?.title ?? payload.status}
              </Badge>
              <p className="mt-2 text-xs text-muted-foreground">
                Reference ID:{' '}
                <span className="font-mono font-semibold text-foreground">{payload.referenceId}</span>
              </p>
            </div>
          </div>
          {payload.terminalRejected && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              Your application was not accepted for this intake. You can apply again from the induction
              page when applications are open, or reach out through the contact page with questions.
            </div>
          )}
          <StageTracker stages={payload.stages} terminalRejected={payload.terminalRejected} status={payload.status} />
          {fromLookup && (
            <Button variant="outline" onClick={() => { setPayload(null); setFromLookup(false); }}>
              Look up a different application
            </Button>
          )}
        </CardContent>
      </Card>

      <DocumentsSection
        key={`docs-${refreshKey}`}
        documents={payload.documents}
        canEdit={payload.canEdit}
        saving={docsSaving}
        saveError={docsError}
        onSave={saveDocuments}
      />

      <DomainPreferencesSection
        key={`prefs-${refreshKey}`}
        domainPreferences={payload.domainPreferences}
        canEdit={payload.canEdit}
        saving={prefsSaving}
        saveError={prefsError}
        onSave={savePreferences}
      />

      <OnboardingChecklist
        milestones={payload.milestones}
        milestonesEditable={payload.milestonesEditable && payload.canEdit}
        onToggle={toggleMilestone}
      />
    </div>
  );
}
