'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/firebase/provider';

interface MissionStep {
  title: string;
  description: string;
  status: string;
  sequenceIndex: number;
  points: number;
  individualDeadline: string | null;
  assigneeName: string;
}

interface Mission {
  workflowId: string;
  title: string;
  steps: MissionStep[];
}

export default function StepSubmitPage() {
  const params = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const workflowId = params?.workflowId as string;
  const stepIndex = parseInt(params?.stepIndex as string, 10);

  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId || isNaN(stepIndex)) return;
    fetch(`/api/missions/${encodeURIComponent(workflowId)}`)
      .then(r => {
        if (!r.ok) throw new Error('Mission not found');
        return r.json();
      })
      .then(d => setMission(d.mission))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [workflowId, stepIndex]);

  const step = mission?.steps?.[stepIndex];

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mb-4" />
          <p className="text-slate-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !step) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-6xl mb-4">🛰️</div>
          <h1 className="text-2xl font-bold mb-2">Step Not Found</h1>
          <p className="text-slate-400 mb-6">{error || 'This mission step does not exist.'}</p>
          <Link href={`/missions/${workflowId}`} className="px-6 py-3 rounded-lg bg-amber-500 text-black font-semibold">
            View Mission
          </Link>
        </div>
      </div>
    );
  }

  // Not logged in → prompt to sign in
  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white">
        <div className="max-w-md mx-auto px-4 py-20 text-center">
          <div className="text-sm tracking-[0.3em] text-amber-400/80 font-semibold mb-4">SEDS PAKISTAN</div>
          <h1 className="text-2xl font-bold mb-3">{step.title}</h1>
          <p className="text-slate-400 mb-2">Assigned to: <span className="text-white font-semibold">{step.assigneeName}</span></p>
          <p className="text-slate-400 mb-8">Sign in to submit your work for this mission step.</p>
          <Link
            href={`/auth/login?redirect=/missions/${workflowId}/submit/${stepIndex}`}
            className="inline-block px-8 py-4 rounded-xl bg-amber-500 text-black font-bold text-lg hover:bg-amber-400 transition"
          >
            Sign In to Submit
          </Link>
          <div className="mt-6">
            <Link href={`/missions/${workflowId}`} className="text-slate-500 hover:text-slate-300 text-sm">
              ← View mission status
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Logged in → direct to profile task view
  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white">
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-8">
          <div className="text-sm tracking-[0.3em] text-amber-400/80 font-semibold mb-3">SEDS PAKISTAN</div>
          <h1 className="text-2xl font-bold mb-2">{step.title}</h1>
          <p className="text-slate-400">Ready to submit your work?</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6">
          <h2 className="font-bold mb-2">Your Deliverable</h2>
          <p className="text-slate-400 text-sm leading-relaxed">{step.description}</p>
          {step.points > 0 && (
            <p className="text-amber-400 font-semibold mt-3">{step.points} points on completion</p>
          )}
        </div>

        <Link
          href={`/profile/unified`}
          className="block w-full text-center px-8 py-4 rounded-xl bg-amber-500 text-black font-bold text-lg hover:bg-amber-400 transition mb-4"
        >
          Open My Mission Control to Submit
        </Link>

        <div className="text-center">
          <Link href={`/missions/${workflowId}`} className="text-slate-500 hover:text-slate-300 text-sm">
            ← View mission status
          </Link>
        </div>
      </div>
    </div>
  );
}
