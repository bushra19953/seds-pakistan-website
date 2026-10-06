'use client';

import { useEffect, useRef, useState } from 'react';
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
  penaltyPoints: number;
  isAssignee: boolean;
  isManager: boolean;
}

/**
 * Proof-file types this page accepts. Documents go to the server 'document'
 * kind (SEDS Chapter Documents); video extensions go to the 'video' kind
 * (SEDS Video Deliverables). The byte limits mirror UPLOAD_KINDS.<kind>.maxBytes
 * in src/lib/drive/folders.ts (that module is server-only, so the numbers are
 * repeated here with a pointer instead of an import). The server still
 * enforces its own rules; this just rejects early in the browser.
 */
const DOCUMENT_EXTS = ['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.m4v'];
const ACCEPT =
  'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'image/png,image/jpeg,image/webp,image/gif,' +
  'video/mp4,video/quicktime,video/webm,video/x-m4v';
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
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
  // Pre-submit validation: the server rejects a review submission with an
  // empty report (PATCH /api/tasks returns 400), so name the missing report
  // inline before the summary opens.
  const [reportError, setReportError] = useState<string | null>(null);
  // Step 2 of the two-step submit: true while the pre-submit summary is open
  // for the user to confirm exactly what gets sent.
  const [confirming, setConfirming] = useState(false);
  const reportRef = useRef<HTMLTextAreaElement>(null);

  // Client-side proof-file validation, mirroring the DeliverableUploader
  // messaging style. Returns an error message or null when the file is fine.
  const validateFile = (file: File): string | null => {
    const ext = extOf(file.name);
    const isVideo = VIDEO_EXTS.includes(ext);
    if (!isVideo && !DOCUMENT_EXTS.includes(ext)) {
      return `"${file.name}" is not an accepted type. Upload a PDF, Word document, image, or video instead.`;
    }
    if (file.size === 0) {
      return `"${file.name}" is empty. Pick a file that has content.`;
    }
    const limit = isVideo ? MAX_VIDEO_BYTES : MAX_DOCUMENT_BYTES;
    if (file.size > limit) {
      return isVideo
        ? `"${file.name}" is over the 100MB video limit. Compress it or trim it down and try again.`
        : `"${file.name}" is over the 25MB limit. Compress it or split it up and try again.`;
    }
    return null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !user || !task) return;
    setUploading(true);
    setUploadProgress(0);
    setSubmitMsg(null);
    try {
      const token = await user.getIdToken();
      for (const file of Array.from(files)) {
        const problem = validateFile(file);
        if (problem) {
          setSubmitMsg(`Upload failed: ${problem}`);
          continue;
        }
        const meta = await uploadToDrive(file, token, {
          kind: VIDEO_EXTS.includes(extOf(file.name)) ? 'video' : 'document',
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

  // Returns true when the PATCH actually went through, so the pre-submit
  // summary can stay open for a retry when it fails.
  const handleTransmit = async (forReview: boolean): Promise<boolean> => {
    if (!user || !task) return false;
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
      return true;
    } catch (e: any) {
      setSubmitMsg(e.message || 'Submit failed. Try again.');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  // Step 1 of the two-step submit: a review submission needs a real report,
  // then opens the pre-submit summary for confirmation. A plain progress save
  // goes straight through.
  const handleSubmitForReviewClick = () => {
    if (!report.trim()) {
      setReportError('Write a work report before submitting for review.');
      setTimeout(() => reportRef.current?.focus(), 200);
      return;
    }
    setConfirming(true);
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
  // Late-penalty warning, mirroring the server rule in
  // src/lib/server/gamification-transaction.ts: approving a task after its
  // deadline deducts penaltyPoints from the points it is worth (never below
  // zero). The penalty applies on approval, so warn when the deadline has
  // already passed and the task carries a non-zero penalty with points to lose.
  const isPastDeadline = deadline ? new Date(deadline).getTime() < Date.now() : false;
  const showLatePenalty =
    isPastDeadline && (task.penaltyPoints ?? 0) > 0 && task.points > 0;

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
              ref={reportRef}
              value={report}
              onChange={(e) => { setReport(e.target.value); if (reportError) setReportError(null); }}
              rows={5}
              placeholder="Describe what you completed, key decisions, and anything the reviewer should know..."
              className="w-full rounded-xl bg-background/80 border border-border p-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-amber-500/50 focus:outline-none mb-4"
            />
            {reportError && (
              <p role="alert" className="text-xs text-red-400 font-semibold leading-relaxed mb-4">{reportError}</p>
            )}

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
                <p className="text-xs text-muted-foreground mb-2 leading-relaxed">Upload what your Mission Brief asks for as proof, like photos, receipts, documents, or a short video. PDF, DOC, JPG, or PNG up to 25MB each; video (MP4, MOV, WebM, M4V) up to 100MB. Use this or the links field, whichever is easier.</p>
                <input
                  type="file"
                  multiple
                  accept={ACCEPT}
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
                onClick={handleSubmitForReviewClick}
                disabled={submitting}
                className="flex-1 px-6 py-3 rounded-xl bg-amber-500 text-black font-bold hover:bg-amber-400 transition disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Submit for Review'}
              </button>
            </div>

            {/* ── Pre-submit summary (step 2 of the two-step submit) ── */}
            {confirming && (
              <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="qr-presubmit-title">
                <div className="absolute inset-0 bg-black/70" onClick={() => setConfirming(false)} />
                <div className="relative w-full max-w-lg rounded-2xl border border-border bg-[#11182b] p-5 sm:p-6 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                  <p className="text-[10px] font-black uppercase tracking-[0.25em] text-amber-400 mb-2">Check before you submit</p>
                  <h3 id="qr-presubmit-title" className="text-lg font-bold text-foreground break-words mb-4">{task.title}</h3>
                  <div className="space-y-4 text-sm">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1.5">Your report</p>
                      <p className="text-foreground/90 leading-relaxed whitespace-pre-wrap break-words max-h-44 overflow-y-auto rounded-xl bg-muted/40 p-3">{report.trim()}</p>
                    </div>
                    <p className="text-muted-foreground">
                      <span className="font-semibold text-foreground">{hours.trim() || '0'} hours logged</span>
                    </p>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1.5">Proof</p>
                      {links.trim() || uploadedFiles.length > 0 ? (
                        <div className="rounded-xl bg-muted/40 p-3 space-y-1.5">
                          {links.trim() && <p className="text-foreground/90 break-all">{links.trim()}</p>}
                          {uploadedFiles.map((f, i) => (
                            <p key={i} className="text-foreground/90 break-all text-xs">
                              {f.fileName} <span className="text-muted-foreground">({(f.sizeBytes / 1048576).toFixed(1)} MB)</span>
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">No proof links or files attached.</p>
                      )}
                    </div>
                    {showLatePenalty && (
                      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
                        <p className="text-xs text-red-300 leading-relaxed">
                          The deadline for this step has passed. If your reviewer approves it now, {task.penaltyPoints} of the {task.points} points will be deducted as a late penalty.
                        </p>
                      </div>
                    )}
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Submitting locks your report until your reviewer decides. You will get a notification when they approve it or ask for changes. You can withdraw the submission from your profile to keep editing.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col-reverse sm:flex-row gap-3 mt-5">
                    <button
                      onClick={() => setConfirming(false)}
                      className="flex-1 h-12 px-6 rounded-xl border border-border font-semibold hover:bg-muted transition"
                    >
                      Go back
                    </button>
                    <button
                      onClick={async () => { const ok = await handleTransmit(true); if (ok) setConfirming(false); }}
                      disabled={submitting}
                      className="flex-1 h-12 px-6 rounded-xl bg-amber-500 text-black font-bold hover:bg-amber-400 transition disabled:opacity-50"
                    >
                      {submitting ? 'Submitting...' : 'Submit for Review'}
                    </button>
                  </div>
                </div>
              </div>
            )}
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
