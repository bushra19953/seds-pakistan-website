'use client';

import { useState, useEffect, useCallback } from 'react';
import { useUser } from '@/firebase/auth/use-user';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Mail, Send, Loader2, RefreshCw, CheckCircle2, XCircle, Eye,
  Clock, AlertTriangle, Zap
} from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import AuthorizationGate from '@/components/admin/AuthorizationGate';

interface EmailLog {
  id: string;
  to: string;
  from: string;
  template: string;
  subject: string;
  htmlPreview?: string;
  success: boolean;
  error?: string | null;
  sentAt: string;
}

export default function EmailLogsPage() {
  const { user } = useUser();
  const { showSuccessToast, showErrorToast } = useEnhancedToast();
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [quota, setQuota] = useState<{ sent: number; limit: number; remaining: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testEmail, setTestEmail] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [previewLog, setPreviewLog] = useState<EmailLog | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/email-logs?limit=100', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setLogs(data.logs || []);
      setQuota(data.quota || null);
    } catch (err) {
      showErrorToast('Failed to load email logs');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const handleSendTest = async () => {
    if (!user || !testEmail.trim()) return;
    setSendingTest(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/email-logs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testEmail.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        showSuccessToast(`Test email sent to ${testEmail}`);
        setTestEmail('');
        setTimeout(fetchLogs, 2000); // Refresh after a short delay
      } else {
        showErrorToast(data.message || 'Failed to send');
      }
    } catch {
      showErrorToast('Network error');
    } finally {
      setSendingTest(false);
    }
  };

  const formatDate = (d: any) => {
    try {
      const date = new Date(d);
      return date.toLocaleString();
    } catch { return 'Unknown'; }
  };

  const templateLabel = (t: string) => {
    const map: Record<string, string> = {
      task_assigned: 'Task Assigned',
      task_status_change: 'Status Change',
      task_submitted_for_review: 'Submitted for Review',
      task_approved: 'Task Approved',
      task_feedback: 'Feedback',
    };
    return map[t] || t;
  };

  const successCount = logs.filter(l => l.success).length;
  const failCount = logs.filter(l => !l.success).length;

  return (
    <AuthorizationGate permission="canManagePermissions">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Mail className="h-6 w-6 text-primary" />
              Email Logs
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor every email sent by the system. Preview content, check delivery status, and send test emails.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchLogs} className="gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>

        {/* Stats + Test Email */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{successCount}</p>
                <p className="text-xs text-muted-foreground">Delivered</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-red-500/10 flex items-center justify-center">
                <XCircle className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{failCount}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Zap className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{quota?.remaining ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Remaining today ({quota?.sent ?? 0}/{quota?.limit ?? 95})</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2 font-medium">Send Test Email</p>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="test@example.com"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="h-8 text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && handleSendTest()}
                />
                <Button
                  size="sm"
                  onClick={handleSendTest}
                  disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail.trim()) || sendingTest}
                  className="h-8 gap-1"
                >
                  {sendingTest ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Send
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RESEND_API_KEY status */}
        {!loading && logs.length === 0 && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="p-4 flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-400">No email logs yet</p>
                <p className="text-muted-foreground mt-1">
                  Make sure <code className="bg-slate-800 px-1 rounded">RESEND_API_KEY</code> is set in your environment variables.
                  Use the test email button above to verify the integration works.
                  Emails are logged automatically — if none appear, the API key may not be configured.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Email Log Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Recent Emails</CardTitle>
            <CardDescription>Last {logs.length} email attempts</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : logs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No emails logged yet.
              </div>
            ) : (
              <ScrollArea className="max-h-[600px]">
                <div className="divide-y divide-border">
                  {logs.map((log) => (
                    <div
                      key={log.id}
                      className="flex items-center gap-4 px-4 py-3 hover:bg-accent/30 transition-colors cursor-pointer"
                      onClick={() => setPreviewLog(log)}
                    >
                      <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${
                        log.success ? 'bg-green-500/10' : 'bg-red-500/10'
                      }`}>
                        {log.success
                          ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                          : <XCircle className="h-4 w-4 text-red-500" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{log.subject}</p>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>To: {log.to}</span>
                          <span className="text-slate-600">|</span>
                          <Badge variant="outline" className="text-[9px] h-4">
                            {templateLabel(log.template)}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {!log.success && log.error && (
                          <Badge variant="destructive" className="text-[10px]">
                            {log.error}
                          </Badge>
                        )}
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDate(log.sentAt)}
                        </div>
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Email Preview Dialog */}
        <Dialog open={!!previewLog} onOpenChange={(v) => !v && setPreviewLog(null)}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Email Preview
              </DialogTitle>
            </DialogHeader>
            {previewLog && (
              <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">To:</span>
                    <p className="font-medium">{previewLog.to}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">From:</span>
                    <p className="font-medium">{previewLog.from}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Subject:</span>
                    <p className="font-medium">{previewLog.subject}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Status:</span>
                    <p>
                      {previewLog.success
                        ? <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Delivered</Badge>
                        : <Badge variant="destructive">{previewLog.error || 'Failed'}</Badge>
                      }
                    </p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Sent: {formatDate(previewLog.sentAt)} | Template: {templateLabel(previewLog.template)}
                </div>
                {previewLog.htmlPreview && (
                  <div className="flex-1 overflow-hidden rounded-lg border border-border">
                    <iframe
                      srcDoc={previewLog.htmlPreview}
                      className="w-full h-full min-h-[300px]"
                      sandbox=""
                      title="Email preview"
                    />
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AuthorizationGate>
  );
}
