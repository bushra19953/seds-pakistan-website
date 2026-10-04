'use client';

import { useState } from 'react';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Database, RefreshCw } from 'lucide-react';

const MIGRATIONS = [
  {
    id: 'update-task02-deadlines',
    endpoint: '/api/admin/migrations/update-task02-deadlines',
    title: 'Update Task 02 Deadlines',
    description: 'Sets all 3 Task 02 step-task deadlines to the datetime you enter below (ISO format). Updates deadline and individualDeadline.',
    needsDeadline: true,
  },
];

export default function MigrationsPage() {
  const { toast } = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});
  const [deadlineInput, setDeadlineInput] = useState('2026-10-05T20:00:00+05:00');

  const runMigration = async (m: typeof MIGRATIONS[number]) => {
    const body: any = {};
    if ((m as any).needsDeadline) {
      const dl = deadlineInput.trim();
      if (!dl || isNaN(Date.parse(dl))) {
        toast({ variant: 'destructive', title: 'Invalid deadline', description: 'Enter a valid ISO datetime, e.g. 2026-10-05T20:00:00+05:00' });
        return;
      }
      body.deadline = dl;
    }
    setRunning(m.id);
    try {
      const res = await fetch(m.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      });
    try {
      const res = await fetch(m.endpoint, { method: 'POST' });
      const body = await res.json();
      setResults((p) => ({ ...p, [m.id]: { status: res.status, body } }));
      if (res.ok && body.ok) {
        toast({ title: 'Migration complete', description: m.title });
      } else {
        toast({ variant: 'destructive', title: 'Migration failed', description: body.error || `HTTP ${res.status}` });
      }
    } catch (e: any) {
      setResults((p) => ({ ...p, [m.id]: { status: 0, body: { error: e?.message } } }));
      toast({ variant: 'destructive', title: 'Migration error', description: e?.message });
    } finally {
      setRunning(null);
    }
  };

  return (
    <AuthorizationGate permission="canManageTasks">
    <div className="container mx-auto py-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-2 flex items-center gap-2">
        <Database className="h-6 w-6" /> Data Migrations
      </h1>
      <p className="text-muted-foreground mb-6">
        Deterministic, code-driven data fixes. No hand edits: each migration is committed code that produces the same state every run.
      </p>
      <div className="space-y-4">
        {MIGRATIONS.map((m) => (
          <Card key={m.id}>
            <CardHeader>
              <CardTitle className="text-lg">{m.title}</CardTitle>
              <CardDescription>{m.description}</CardDescription>
            </CardHeader>
            <CardContent>
              {(m as any).needsDeadline && (
                <div className="mb-4">
                  <label className="text-sm font-medium">New deadline (ISO)</label>
                  <input
                    type="text"
                    value={deadlineInput}
                    onChange={(e) => setDeadlineInput(e.target.value)}
                    placeholder="2026-10-05T20:00:00+05:00"
                    className="mt-1 w-full rounded border px-3 py-2 text-sm font-mono"
                  />
                </div>
              )}
              <Button onClick={() => runMigration(m)} disabled={running !== null}>
                {running === m.id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                {running === m.id ? 'Running...' : 'Run Migration'}
              </Button>
              {results[m.id] && (
                <pre className="mt-4 text-xs bg-muted p-3 rounded overflow-auto max-h-64">
                  {JSON.stringify(results[m.id], null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
    </AuthorizationGate>
  );
}
