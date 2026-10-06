'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useUser } from '@/firebase/auth/use-user';
import { uploadToDrive, type DriveUploadMeta } from '@/lib/uploads/client';

interface SubmitTask {
  id: string;
  title: string;
  description: string;
  status: string;
  points: number;
  individualDeadline: string | null;
  deadline: string | null;
  report: string;
  hoursWorked: number | null;
  resourceLinks: string;
  isAssignee: boolean;
  isManager: boolean;
}

export default function StepSubmitPage() {
  const params = useParams();
  const router = useRouter();
  const { user, isLoading: authLoading } = useUser();
  const workflowId = params?.workflowId as string;
  const stepIndexParam = params?.stepIndex as string;

  const [task, setTask] = useState<SubmitTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [report, setReport] = useState('');
  const [hours, setHours] = useState('');
  const [links, setLinks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<DriveUploadMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !user || !task) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const token = await user.getIdToken();
      for (const file of Array.from(files)) {
        const meta = await uploadToDrive(file, token, {
          kind: 'document',
          context: `task-${task.id}`,
          onProgress: (p) => setUploadProgress(p),
        });
        setUploadedFiles((prev) => [...prev, meta]);
      }
    } catch (err: any) {
      setSubmitMsg(`Upload failed: ${err.message || 'Try again'}`);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      e.target.value = '';
    }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    if (!workflowId || stepIndexParam === undefined) return;
    (async () => {
      try {
        const token = await user.getIdToken();
        const res = await fetch(
          `/api/missions/${encodeURIComponent(workflowId)}/submit/${encodeURIComponent(stepIndexParam)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load your mission step');
        setTask(data.task);
        setReport(data.task.report || '');
        setHours(data.task.hoursWorked != null ? String(data.task.hoursWorked) : '');
        setLinks(data.task.resourceLinks || '');
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, authLoading, workflowId, stepIndexParam]);

  const handleTransmit = async (forReview: boolean) => {
    if (!user || !task) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const token = await user.getIdToken();
      const updates: any = {
        status: forReview ? 'submitted-for-review' : 'in-progress',
      };
      if (report.trim()) updates.report = report.trim();
      if (hours.trim()) updates.hoursWorked = parseFloat(hours);
      if (links.trim()) updates.resourceLinks = links.trim();
      if (uploadedFiles.length > 0) {
        updates.deliverableFiles = uploadedFiles.map((f) => ({
          fileName: f.fileName,
          driveFileId: f.driveFileId,
          downloadUrl: f.downloadUrl,
          sizeBytes: f.sizeBytes,
          contentType: f.contentType,
        }));
      }
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, updates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submit failed. Try again.');
      setSubmitMsg(
        forReview
          ? 'Submitted for review. Your reviewer has been notified.'
          : 'Progress saved.'
      );
      setTask({ ...task, status: updates.status, report: updates.report ?? task.report });
    } catch (e: any) {
      setSubmitMsg(e.message || 'Submit failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-foreground flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mb-4" />
          <p className="text-muted-foreground">Loading your mission step...</p>
        </div>
      </div>
    );
  }

  // Not logged in → sign-in prompt that returns here after login
  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-foreground">
        <div className="max-w-md mx-auto px-4 py-20 text-center">
          <div className="text-sm tracking-[0.3em] text-amber-400/80 font-semibold mb-4">SEDS PAKISTAN</div>
          <h1 className="text-2xl font-bold mb-3">Submit Your Mission Work</h1>
          <p className="text-muted-foreground mb-8">Sign in to submit your work for this mission step.</p>
          <Link
            href={`/auth/login?redirect=/missions/${workflowId}/submit/${stepIndexParam}`}
            className="inline-block px-8 py-4 rounded-xl bg-amber-500 text-black font-bold text-lg hover:bg-amber-400 transition"
          >
            Sign In to Submit
          </Link>
          <div className="mt-6">
            <Link href={`/missions/${workflowId}`} className="text-muted-foreground hover:text-muted-foreground text-sm">
              ← View mission status
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Logged in but lookup failed (not the assignee, step missing, etc.)
  if (error || !task) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-foreground flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">🛰️</div>
          <h1 className="text-2xl font-bold mb-2">Cannot Open Submission</h1>
          <p className="text-muted-foreground mb-6">{error || 'This mission step could not be loaded.'}</p>
          <Link href={`/missions/${workflowId}`} className="px-6 py-3 rounded-lg bg-amber-500 text-black font-semibold">
            View Mission
          </Link>
        </div>
      </div>
    );
  }

  const deadline = task.individualDeadline || task.deadline;

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-foreground">
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-8">
          <div className="text-sm tracking-[0.3em] text-amber-400/80 font-semibold mb-3">SEDS PAKISTAN</div>
          <h1 className="text-2xl font-bold mb-2">{task.title}</h1>
          <p className="text-muted-foreground text-sm">
            {task.points > 0 && <span className="text-amber-400 font-semibold">{task.points} points</span>}
            {deadline && (
              <span className="ml-2">
                • Due {new Date(deadline).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            )}
          </p>
          <p className="mt-2 inline-block text-xs font-mono px-3 py-1 rounded-full bg-muted">
            Status: {task.status.replace(/-/g, ' ').toUpperCase()}
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-muted p-6 mb-6">
          <h2 className="font-bold mb-2">Mission Brief</h2>
          <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">{task.description}</p>
        </div>

        {task.isAssignee ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6">
            <h2 className="font-bold mb-4">Submit your work</h2>

            <label className="block text-sm font-semibold text-muted-foreground mb-2">Work Report <span className="text-xs font-normal text-amber-400">(required to submit for review)</span></label>
            <textarea
              value={report}
              onChange={(e) => setReport(e.target.value)}
              rows={5}
              placeholder="Describe what you completed, key decisions, and anything the reviewer should know..."
              className="w-full rounded-xl bg-background/80 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-amber-500/50 focus:outline-none mb-4"
            />

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-semibold text-muted-foreground mb-2">Hours Worked <span className="text-xs font-normal">(optional)</span></label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  placeholder="e.g. 6"
                  className="w-full rounded-xl bg-background/80 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-amber-500/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-muted-foreground mb-2">Proof Links <span className="text-xs font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={links}
                  onChange={(e) => setLinks(e.target.value)}
                  placeholder="Shared Drive, Docs, or video link"
                  className="w-full rounded-xl bg-background/80 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-amber-500/50 focus:outline-none"
                />
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">If your proof already lives online, paste the link here instead of uploading. Anything that proves the work is done: photos, documents, videos, repos.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-muted-foreground mb-2">
                  Upload Proof Files <span className="text-xs font-normal">(optional, goes straight to SEDS Drive)</span>
                </label>
                <p className="text-xs text-muted-foreground mb-2 leading-relaxed">Upload what your Mission Brief asks for as proof, like photos, receipts, or documents. PDF, DOC, JPG, or PNG, up to 25MB each. Use this or the links field, whichever is easier.</p>
                <input
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  disabled={uploading}
                  className="w-full rounded-xl bg-background/80 border border-border p-3 text-sm text-foreground file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-emerald-600 file:text-foreground file:font-semibold file:cursor-pointer hover:file:bg-emerald-500 disabled:opacity-50"
                />
                {uploading && (
                  <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500 transition-all" style={{ width: `${uploadProgress}%` }} />
                  </div>
                )}
                {uploadedFiles.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {uploadedFiles.map((f, i) => (
                      <li key={i} className="text-xs text-emerald-400 flex items-center gap-2">
                        <span className="truncate">{f.fileName}</span>
                        <span className="text-muted-foreground shrink-0">({(f.sizeBytes / 1048576).toFixed(1)} MB)</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {submitMsg && (
              <p className={`text-sm mb-4 ${submitMsg.includes('failed') || submitMsg.includes('Try again') ? 'text-red-400' : 'text-emerald-400'}`}>
                {submitMsg}
              </p>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => handleTransmit(false)}
                disabled={submitting}
                className="flex-1 px-6 py-3 rounded-xl border border-border font-semibold hover:bg-muted transition disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Save Progress'}
              </button>
              <button
                onClick={() => handleTransmit(true)}
                disabled={submitting}
                className="flex-1 px-6 py-3 rounded-xl bg-amber-500 text-black font-bold hover:bg-amber-400 transition disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Submit for Review'}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-muted p-6 text-center">
            <p className="text-muted-foreground text-sm">
              You are viewing this step as a manager. The assignee submits through their own personal link.
            </p>
          </div>
        )}

        <div className="text-center mt-6">
          <Link href={`/missions/${workflowId}`} className="text-muted-foreground hover:text-muted-foreground text-sm">
            ← View live mission status
          </Link>
        </div>
      </div>
    </div>
  );
}
