'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import ConsentRequestForm, {
  type ConsentFormValues,
} from '@/components/admin/consents/consent-request-form';
import { consentApi } from '@/components/admin/consents/consent-api';

export default function NewConsentRequestPage() {
  const { user } = useUser();
  const router = useRouter();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const createDraft = async (values: ConsentFormValues): Promise<string> => {
    if (!user) throw new Error('Not signed in');
    const created = await consentApi<{ id: string; requestNumber: string | null }>(
      () => user.getIdToken(),
      '/api/consents',
      { method: 'POST', body: JSON.stringify(values) },
    );
    return created.id;
  };

  const handleSaveDraft = async (values: ConsentFormValues) => {
    setSubmitting(true);
    setServerErrors({});
    try {
      const id = await createDraft(values);
      toast({ title: 'Draft saved' });
      router.push(`/admin/consents/${id}`);
    } catch (err: any) {
      if (err?.fields) setServerErrors(err.fields);
      toast({
        title: 'Could not save the draft',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (values: ConsentFormValues) => {
    setSubmitting(true);
    setServerErrors({});
    try {
      const id = await createDraft(values);
      await consentApi(
        () => user!.getIdToken(),
        `/api/consents/${id}/submit`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      toast({ title: 'Consent request filed' });
      router.push(`/admin/consents/${id}`);
    } catch (err: any) {
      if (err?.fields) setServerErrors(err.fields);
      toast({
        title: 'Could not file the request',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold">New Consent Request</h1>
          <p className="text-sm text-muted-foreground">
            File for Founder Consent before the Act is done. One Act per request.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Exhibit A filing</CardTitle>
          </CardHeader>
          <CardContent>
            <ConsentRequestForm
              submitting={submitting}
              serverErrors={serverErrors}
              onSaveDraft={(v) => void handleSaveDraft(v)}
              onSubmitRequest={(v) => void handleSubmit(v)}
            />
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
