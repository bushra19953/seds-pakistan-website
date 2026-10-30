'use client';
// Participant surface per ws-a section 5: /meetings/[meetingId]. Signed-in body members only; API enforces membership.
// READ-BLEED INTERIM (census 16): the read below was a live listener over
// the meeting's motions, so every ballot billed a read to EVERY connected
// participant. Polling GET /api/governance/meetings/[meetingId]/motions
// (meetingsAdapter.listMotions) was evaluated and is NOT a clean swap:
// that route is gated on canViewGovernance (superadmin / founder_patron
// only in permissions.config), so ordinary body members - this page's
// audience - would get 403 and lose the voting view. Until the route's
// gate matches this surface, the interim is a bounded one-time fetch
// (limit 200, newest first, no listener); plan cluster_meetings_PLAN.md
// §1-G1 client-read ruling (a) otherwise stands.
import { useMemo } from 'react';
import { useParams } from 'next/navigation';
import { collection, query, where, orderBy, limit } from 'firebase/firestore';
import { useFirestore, useCollection, useUser } from '@/firebase';
import { MotionCard } from '@/components/admin/governance/motion-card';
import { BallotPanel } from '@/components/admin/governance/ballot-panel';
import type { MotionView } from '@/lib/governance/meetings-ui';
export default function MemberMeetingPage() {
  const params = useParams(); const meetingId = String(params?.meetingId ?? '');
  const db = useFirestore(); const { user, isLoading } = useUser();
  const q = useMemo(() => (db && meetingId ? query(collection(db, 'motions'), where('meetingId', '==', meetingId), orderBy('openedAt', 'desc'), limit(200)) : null), [db, meetingId]);
  const { data, loading } = useCollection<any>(q as any, { listen: false });
  if (isLoading) return <div className="p-6">Loading...</div>;
  if (!user) return <div className="p-6"><h1 className="text-xl font-semibold">Sign in required</h1><p className="text-sm">Meeting voting is available to signed-in body members only.</p></div>;
  const motions = (data ?? []) as MotionView[];
  return (<div className="mx-auto max-w-3xl space-y-6 p-6"><h1 className="text-2xl font-semibold">Meeting voting</h1>
    <p className="text-sm text-muted-foreground">Vote on open motions for this meeting. Secret ballots show no running totals and your choice is never linked to you.</p>
    {loading ? <p>Loading motions...</p> : motions.length === 0 ? <p>No motions are open for this meeting yet.</p> : motions.map((m) => (<div key={(m as any).id} className="space-y-2"><MotionCard motion={m} /><BallotPanel motion={m} /></div>))}
  </div>);
}
