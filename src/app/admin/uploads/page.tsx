'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Database, RefreshCw, ExternalLink, AlertTriangle, Search, CheckCircle2, Clock3, Paperclip,
} from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

interface UploadRecord {
  id: string;
  fileName?: string;
  userId?: string;
  fileSizeBytes?: number;
  mimeType?: string;
  kind?: string;
  context?: string;
  driveFileId?: string;
  webViewLink?: string;
  taskId?: string | null;
  status?: 'initiated' | 'completed' | 'attached';
  uploadedAt?: string;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
}

function StatusBadge({ status }: { status?: string }) {
  if (status === 'attached')
    return <Badge className="bg-green-500/15 text-green-400 border-green-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />Attached</Badge>;
  if (status === 'initiated')
    return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30"><Clock3 className="h-3 w-3 mr-1" />Initiated</Badge>;
  if (status === 'completed')
    return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30"><AlertTriangle className="h-3 w-3 mr-1" />Completed · not attached</Badge>;
  return <Badge variant="outline">{status || 'unknown'}</Badge>;
}

export default function AdminUploadsPage() {
  const { user } = useUser();
  const { showErrorToast } = useEnhancedToast();
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'orphaned'>('all');
  const [userIdQuery, setUserIdQuery] = useState('');
  const [appliedUserId, setAppliedUserId] = useState('');

  const fetchUploads = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const params = new URLSearchParams({ filter, limit: '100' });
      if (appliedUserId.trim()) params.set('userId', appliedUserId.trim());
      const res = await fetch(`/api/admin/uploads?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch uploads');
      const data = await res.json();
      setUploads(Array.isArray(data.uploads) ? data.uploads : []);
    } catch {
      showErrorToast('Failed to load uploads');
    } finally {
      setLoading(false);
    }
  }, [user, filter, appliedUserId, showErrorToast]);

  useEffect(() => { fetchUploads(); }, [fetchUploads]);

  return (
    <AuthorizationGate permission="canViewUploads">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Database className="h-6 w-6 text-primary" />
              Recent Uploads
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Every file upload is tracked server-side, even when the user never submits.
              Orphaned files (uploaded but never attached to a task) show up here.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchUploads} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Filters</CardTitle>
            <CardDescription>Switch to Orphaned to find files users uploaded but never attached.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`px-4 py-2 text-sm font-medium ${filter === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
              >
                All uploads
              </button>
              <button
                type="button"
                onClick={() => setFilter('orphaned')}
                className={`px-4 py-2 text-sm font-medium ${filter === 'orphaned' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
              >
                Orphaned
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Filter by user ID"
                value={userIdQuery}
                onChange={(e) => setUserIdQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') setAppliedUserId(userIdQuery); }}
                className="w-56"
              />
              <Button size="sm" variant="secondary" onClick={() => setAppliedUserId(userIdQuery)}>
                <Search className="h-4 w-4 mr-1" /> Apply
              </Button>
              {appliedUserId && (
                <Button size="sm" variant="ghost" onClick={() => { setUserIdQuery(''); setAppliedUserId(''); }}>
                  Clear
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-6 space-y-3">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : uploads.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground">
                <Paperclip className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm">
                  {filter === 'orphaned'
                    ? 'No orphaned uploads. Every completed upload is attached to a task.'
                    : 'No uploads recorded yet.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-3">File</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Size</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Task</th>
                      <th className="px-4 py-3">Uploaded</th>
                      <th className="px-4 py-3">Drive</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploads.map((u) => (
                      <tr key={u.id} className="border-b border-border/50 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="font-medium truncate max-w-[280px]" title={u.fileName}>{u.fileName || '—'}</div>
                          <div className="text-[11px] text-muted-foreground truncate max-w-[280px]" title={u.userId}>
                            {u.userId || '—'}
                          </div>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                        <td className="px-4 py-3 whitespace-nowrap">{formatSize(u.fileSizeBytes)}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">{u.kind || '—'}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          {u.taskId ? (
                            <Link href={`/admin/tasks?taskId=${encodeURIComponent(u.taskId)}`} className="text-primary hover:underline text-xs font-mono">
                              {u.taskId.slice(0, 12)}…
                            </Link>
                          ) : (
                            <span className="text-muted-foreground text-xs">not attached</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{formatTime(u.uploadedAt)}</td>
                        <td className="px-4 py-3">
                          {u.driveFileId ? (
                            <a
                              href={u.webViewLink || `https://drive.google.com/file/d/${u.driveFileId}/view`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline inline-flex items-center gap-1 text-xs"
                            >
                              Open <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
