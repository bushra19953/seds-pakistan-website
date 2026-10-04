'use client';

import { useState } from 'react';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Database, RefreshCw } from 'lucide-react';

const MIGRATIONS = [
  {
    id: 'recreate-task02',
    endpoint: '/api/admin/migrations/recreate-task02',
    title: 'Recreate Task 02 Workflow',
    description: 'Deletes the current Task 02 workflow and recreates it with Huzaifah as oversight co-assignee on every step and the 6 Drive resource links attached. Deterministic and safe to re-run.',
  },
  {
    id: 'backfill-task02-resources',
    endpoint: '/api/admin/migrations/backfill-task02-resources',
    title: 'Backfill Task 02 Drive Links',
    description: 'Adds the 6 Drive resource links to the existing Task 02 step tasks without recreating. Idempotent.',
  },
];

export default function MigrationsPage() {
  const { toast } = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});

  const runMigration = async (m: typeof MIGRATIONS[number]) => {
    setRunning(m.id);
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
