'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, firestore } from '@/firebase/core';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { AlertCircle, CalendarCheck2, CheckCircle2, Loader2, MapPin } from 'lucide-react';
import StarryBackground from '@/components/ui/starry-background';

/**
 * TASK REDIRECTOR + AVAILABILITY GATE
 *
 * This page acts as a legacy bridge. It redirects individual task URLs to
 * the Unified Profile's task focus mode.
 *
 * Reason: Consolidation of task management into the high-performance OptimizedProfile.
 *
 * AVAILABILITY GATE: on first open of an assigned task by the assignee, we
 * show a one-tap availability confirmation BEFORE the redirect. Tasks that
 * were never confirmed (server truth: task.availabilityConfirmed !== true)
 * pause here so an assignee who is out of town is never silently handed
 * field work. On-site tasks carry a location notice naming where the work
 * happens.
 *
 * Persistence reuses the existing task API pattern: PATCH /api/tasks with
 * { taskId, action: 'accept' } and a Bearer Firebase ID token. That handler
 * stamps acceptanceStatus 'accepted' with server time, records acceptedBy,
 * and logs an activity entry. It is gated to the assignee (or someone above
 * them in the reporting chain), so no other assignee write path is needed.
 */
export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params?.taskId as string;
  const router = useRouter();

  const [gate, setGate] = useState<{
    user: User;
    taskTitle: string;
    requiresOnSitePresence: boolean;
    locationRequired: string | null;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const resolvedRef = useRef(false);

  const redirectToTask = useCallback(() => {
    if (router && taskId) {
      // Use replace to avoid polluting history with the redirect bridge
      router.replace(`/profile/unified?task=${taskId}`);
    }
  }, [router, taskId]);

  useEffect(() => {
    if (!taskId || resolvedRef.current) return;
    resolvedRef.current = true;

    const settle = (outcome: 'redirect' | 'gate', gateState?: NonNullable<typeof gate>) => {
      if (outcome === 'gate' && gateState) {
        setGate(gateState);
      } else {
        redirectToTask();
      }
    };

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      try {
        // Anyone who is not a signed-in assignee keeps the old behavior.
        if (!user) {
          settle('redirect');
          return;
        }
        const snap = await getDoc(doc(firestore, 'tasks', taskId));
        if (!snap.exists()) {
          settle('redirect');
          return;
        }
        const task = snap.data() as any;
        const assigneeIds: string[] = Array.isArray(task.assigneeIds) && task.assigneeIds.length
          ? task.assigneeIds.map((v: any) => String(v)).filter(Boolean)
          : task.assigneeId
            ? [String(task.assigneeId)]
            : [];
        if (!assigneeIds.includes(user.uid)) {
          settle('redirect');
          return;
        }
        // Server truth drives "first open": only assignees who have not yet
        // confirmed availability see the gate. Both fields are set by the
        // confirmation writes, so either one being true skips the prompt.
        const alreadyConfirmed = task.availabilityConfirmed === true || task.acceptanceStatus === 'accepted';
        if (alreadyConfirmed) {
          settle('redirect');
          return;
        }
        settle('gate', {
          user,
          taskTitle: typeof task.title === 'string' && task.title ? task.title : 'This task',
          requiresOnSitePresence: task.requiresOnSitePresence === true,
          locationRequired: typeof task.locationRequired === 'string' && task.locationRequired.trim()
            ? task.locationRequired.trim()
            : null,
        });
      } catch {
        // A failed read must never strand the user on this bridge.
        settle('redirect');
      }
    });

    return () => unsubscribe();
  }, [taskId, redirectToTask]);

  const handleConfirm = async () => {
    if (!gate || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const token = await gate.user.getIdToken();
      const res = await fetch('/api/tasks', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, action: 'accept' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Confirmation failed');
      }
      redirectToTask();
    } catch (err: any) {
      setConfirmError(err?.message || 'Could not save your confirmation. Please try again.');
      setConfirming(false);
    }
  };

  // The availability gate replaces the redirect until the assignee confirms.
  if (gate) {
    const onSite = gate.requiresOnSitePresence;
    return (
      <StarryBackground>
        <div className="min-h-screen flex flex-col items-center justify-center p-4">
          <div className="w-full max-w-lg">
            <div className="bg-card/60 border border-slate-800 p-8 rounded-[2.5rem] space-y-6">
              <div className="flex items-center gap-4">
                <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
                  <CalendarCheck2 className="h-7 w-7 text-primary" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.4em] text-muted-foreground">
                    Quick check
                  </p>
                  <h1 className="text-xl font-black text-foreground leading-tight mt-1">
                    {gate.taskTitle}
                  </h1>
                </div>
              </div>

              {onSite && (
                <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
                  <MapPin className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-sm leading-relaxed text-foreground">
                    <span className="font-bold">This work happens in person</span>
                    {gate.locationRequired ? (
                      <>
                        {' '}at <span className="font-bold">{gate.locationRequired}</span>.{' '}
                        Please confirm you can be there before you open this task.
                      </>
                    ) : (
                      <>
                        . Please confirm you can be there before you open this task.
                      </>
                    )}
                  </div>
                </div>
              )}

              <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                {onSite
                  ? 'Confirm you are available and can reach the location above.'
                  : 'You were assigned this task. Please confirm you are available to work on it.'}
              </p>

              {confirmError && (
                <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{confirmError}</span>
                </div>
              )}

              <div className="space-y-3">
                <Button
                  onClick={handleConfirm}
                  disabled={confirming}
                  className="w-full min-h-[52px] text-base font-bold rounded-2xl"
                >
                  {confirming ? (
                    <>
                      <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                      Confirming
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      {onSite ? 'Confirm I can be there' : 'Confirm I am available'}
                    </>
                  )}
                </Button>
                <button
                  type="button"
                  onClick={redirectToTask}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                >
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        </div>
      </StarryBackground>
    );
  }

  return (
    <StarryBackground>
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-2xl space-y-8 animate-pulse">
          <div className="space-y-4 text-center">
            <Skeleton className="h-12 w-3/4 mx-auto bg-primary/10" />
            <Skeleton className="h-6 w-1/2 mx-auto bg-muted" />
          </div>
          
          <div className="bg-card/40 border border-slate-800 p-8 rounded-[2.5rem] space-y-6">
            <div className="flex items-center gap-6">
              <Skeleton className="h-16 w-16 rounded-2xl bg-muted" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-4 w-1/4 bg-muted" />
                <Skeleton className="h-8 w-3/4 bg-muted" />
              </div>
            </div>
            
            <div className="space-y-4 pt-4">
              <Skeleton className="h-32 w-full rounded-2xl bg-muted/50" />
              <div className="grid grid-cols-3 gap-4">
                <Skeleton className="h-20 rounded-xl bg-muted/30" />
                <Skeleton className="h-20 rounded-xl bg-muted/30" />
              </div>
            </div>
          </div>
          
          <p className="text-center text-xs font-black uppercase tracking-[0.4em] text-muted-foreground animate-pulse">
            Establishing Tactical Uplink...
          </p>
        </div>
      </div>
    </StarryBackground>
  );
}
