'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Download, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import ConsentRegisterTable from '@/components/admin/consents/consent-register-table';
import { consentApi } from '@/components/admin/consents/consent-api';
import { RESERVED_MATTERS } from '@/lib/consents/reserved-matters';
import { REGISTER_STATUSES } from '@/lib/consents/consent-state';
import { STATUS_LABELS } from '@/components/admin/consents/consent-api';

export default function RegisterOfConsentsPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [status, setStatus] = useState('all');
  const [matterKey, setMatterKey] = useState('all');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (matterKey !== 'all') params.set('matterKey', matterKey);
    if (q.trim()) params.set('q', q.trim());
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', '200');
    return params.toString();
  }, [status, matterKey, q, from, to]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const data = await consentApi<{ register: any[] }>(
        () => user.getIdToken(),
        `/api/consents/register?${buildQuery()}`,
      );
      setRows(data.register ?? []);
      setForbidden(false);
    } catch (err: any) {
      if (err?.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        toast({
          title: 'Could not load the register',
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
    }
  }, [user, buildQuery, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/consents/register?${buildQuery()}&format=csv`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'register-of-consents.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: 'CSV export failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <AuthorizationGate permission="canAccessAdmin">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Register of Consents</h1>
          <p className="text-sm text-muted-foreground">
            Register of Consents. Kept by the National General Secretary (Role
            Catalog Art. 11). Decided requests only.
          </p>
        </div>

        {forbidden ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm">
                The Register of Consents is readable by the Founder and the National
                General Secretary only.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Decided requests</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-1">
                  <Label>Decision</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All decisions</SelectItem>
                      {REGISTER_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABELS[s] ?? s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Matter</Label>
                  <Select value={matterKey} onValueChange={setMatterKey}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All matters</SelectItem>
                      {RESERVED_MATTERS.map((m) => (
                        <SelectItem key={m.matterKey} value={m.matterKey}>
                          {m.scheduleSection} - {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-q">Search</Label>
                  <Input
                    id="reg-q"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Number, requester, Act"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-from">Decided from</Label>
                  <Input id="reg-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-to">Decided to</Label>
                  <Input id="reg-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void exportCsv()}>
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
              </div>
              {loading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <ConsentRegisterTable rows={rows} />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AuthorizationGate>
  );
}
