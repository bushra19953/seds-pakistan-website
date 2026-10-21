"use client";

/**
 * Compliance triggers (phase2_spec.md Sections G.7/G.8): record-a-trigger
 * form + the trigger log. Recording creates the event instance and
 * notifies the office holder immediately; the idempotency key makes a
 * retried submission return the original instance instead of duplicating
 * the duty.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface TriggerRow {
  id: string;
  templateKey: string;
  triggerType: string;
  recordedBy: string;
  obligationId: string;
  idempotencyKey: string;
}

export default function TriggersPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [templateKey, setTemplateKey] = useState('');
  const [triggerDate, setTriggerDate] = useState('');
  const [subjectDate, setSubjectDate] = useState('');
  const [subjectLabel, setSubjectLabel] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/compliance/triggers/list', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setTriggers(body.triggers ?? []);
    } catch (err: any) {
      toast({ title: 'Failed to load triggers', description: err?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const record = useCallback(async () => {
    if (!user) return;
    setBusy(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/compliance/triggers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateKey,
          triggerDate: triggerDate ? new Date(triggerDate).toISOString() : undefined,
          subjectDate: subjectDate ? new Date(subjectDate).toISOString() : undefined,
          subjectRef: { kind: 'event', id: '', label: subjectLabel },
          idempotencyKey: idempotencyKey || `${templateKey}-${Date.now()}`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      toast({
        title: body.duplicate ? 'Already recorded - original instance returned' : 'Trigger recorded',
        description: `Obligation ${body.obligationId}, due ${body.dueDate?.slice(0, 10) ?? ''}`,
      });
      await load();
    } catch (err: any) {
      toast({ title: 'Recording failed', description: err?.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [user, toast, templateKey, triggerDate, subjectDate, subjectLabel, idempotencyKey, load]);

  return (
    <AuthorizationGate requiredPermission="canAccessAdmin">
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Event triggers</h1>
          <p className="text-sm text-muted-foreground">
            Record something that happened (an officer changed, a contract was signed) and the engine creates the
            filing duty and notifies the office holder at once.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Record a trigger</CardTitle>
            <CardDescription>Callers: NGS, Audit Chair, or a role the template lists as recordable-by.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Input placeholder="Template key (e.g. change-of-officer-filing)" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} />
            <Input placeholder="Subject label (what happened)" value={subjectLabel} onChange={(e) => setSubjectLabel(e.target.value)} />
            <label className="text-sm">
              Trigger date
              <Input type="date" value={triggerDate} onChange={(e) => setTriggerDate(e.target.value)} />
            </label>
            <label className="text-sm">
              Subject date (for before-execution rules)
              <Input type="date" value={subjectDate} onChange={(e) => setSubjectDate(e.target.value)} />
            </label>
            <Input placeholder="Idempotency key (blank = auto)" value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} />
            <Button disabled={busy || !templateKey} onClick={record} className="self-end">
              Record trigger
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Trigger log</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {loading && (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </span>
            )}
            {!loading && triggers.length === 0 && <p className="text-muted-foreground">No triggers recorded yet.</p>}
            {triggers.map((t) => (
              <p key={t.id} className="border-b pb-2">
                <span className="font-medium">{t.templateKey}</span> · recorded by {t.recordedBy} · obligation{' '}
                {t.obligationId} · key {t.idempotencyKey}
              </p>
            ))}
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
