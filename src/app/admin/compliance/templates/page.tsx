"use client";

/**
 * Compliance templates (phase2_spec.md Section G.7): list + edit form.
 * Editing goes through PATCH, the ONLY correction path - it bumps
 * templateVersion, and instances pin the version they were generated
 * from. There is no delete: a wrong template is corrected or deactivated.
 * Founder/NGS only (the API enforces it; this page just renders).
 */

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface TemplateRow {
  id: string;
  title: string;
  officeRole: string;
  cadence: string;
  category: string;
  reviewerRole: string;
  templateVersion: number;
  active: boolean;
  deadlineRule: Record<string, unknown>;
}

export default function TemplatesPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [ruleJson, setRuleJson] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/compliance/templates', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setTemplates(body.templates ?? []);
    } catch (err: any) {
      toast({ title: 'Failed to load templates', description: err?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (key: string) => {
      if (!user) return;
      let deadlineRule: unknown;
      try {
        deadlineRule = JSON.parse(ruleJson);
      } catch {
        toast({ title: 'Deadline rule is not valid JSON', variant: 'destructive' });
        return;
      }
      setBusy(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch(`/api/admin/compliance/templates/${key}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, deadlineRule }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        toast({ title: `Template updated - now version ${body.templateVersion}` });
        setEditing(null);
        await load();
      } catch (err: any) {
        toast({ title: 'Save failed', description: err?.message, variant: 'destructive' });
      } finally {
        setBusy(false);
      }
    },
    [user, toast, ruleJson, title, load],
  );

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">Compliance templates</h1>
          <p className="text-sm text-muted-foreground">
            The seeded catalog. Corrections happen here only (PATCH bumps the version). Templates are never deleted -
            deactivate instead.
          </p>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-3">
            {templates.map((t) => (
              <Card key={t.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {t.title}
                    <Badge variant="outline">{t.id}</Badge>
                    <Badge variant={t.active ? 'default' : 'secondary'}>{t.active ? 'active' : 'inactive'}</Badge>
                    <span className="text-xs font-normal text-muted-foreground">v{t.templateVersion}</span>
                  </CardTitle>
                  <CardDescription>
                    Office: {t.officeRole} · Cadence: {t.cadence} · Category: {t.category} · Reviewer: {t.reviewerRole} ·
                    Rule: {JSON.stringify(t.deadlineRule)}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {editing === t.id ? (
                    <div className="space-y-3">
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
                      <Textarea
                        value={ruleJson}
                        onChange={(e) => setRuleJson(e.target.value)}
                        placeholder='Deadline rule JSON, e.g. {"kind":"fixed_day_of_month","day":15}'
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy} onClick={() => save(t.id)}>
                          Save (bumps version)
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(t.id);
                        setTitle(t.title);
                        setRuleJson(JSON.stringify(t.deadlineRule, null, 2));
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
            {templates.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No templates loaded yet. The seed loader (fixtures first, then production on approval) populates this
                catalog.
              </p>
            )}
          </div>
        )}
      </div>
    </AuthorizationGate>
  );
}
