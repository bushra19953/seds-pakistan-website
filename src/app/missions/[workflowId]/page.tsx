'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface MissionStep {
  title: string;
  description: string;
  status: string;
  sequenceIndex: number;
  points: number;
  individualDeadline: string | null;
  completedAt: string | null;
  assigneeName: string;
  assigneeChapter: string | null;
  role: string | null;
}

interface Mission {
  workflowId: string;
  title: string;
  description: string;
  chapterName: string | null;
  totalSteps: number;
  completedSteps: number;
  progressPercentage: number;
  isCompleted: boolean;
  createdAt: string | null;
  deadline: string | null;
  steps: MissionStep[];
}

const STATUS_STYLES: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  completed: { label: 'COMPLETED', bg: 'bg-green-500/15', text: 'text-green-400', dot: 'bg-green-400' },
  'in-progress': { label: 'IN PROGRESS', bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400' },
  'submitted-for-review': { label: 'IN REVIEW', bg: 'bg-sky-500/15', text: 'text-sky-400', dot: 'bg-sky-400' },
  overdue: { label: 'OVERDUE', bg: 'bg-rose-500/15', text: 'text-rose-400', dot: 'bg-rose-400' },
  pending: { label: 'PENDING', bg: 'bg-slate-500/15', text: 'text-slate-400', dot: 'bg-slate-400' },
};

function formatDate(iso: string | null): string {
  if (!iso) return 'TBD';
  try {
    return new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return 'TBD';
  }
}

export default function PublicMissionPage() {
  const params = useParams();
  const workflowId = params?.workflowId as string;
  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    const fetchMission = async () => {
      try {
        const res = await fetch(`/api/missions/${encodeURIComponent(workflowId)}`);
        if (!res.ok) {
          if (res.status === 404) throw new Error('Mission not found');
          throw new Error('Failed to load mission');
        }
        const data = await res.json();
        if (!cancelled) {
          setMission(data.mission);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load mission');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchMission();
    const interval = setInterval(fetchMission, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [workflowId]);

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white">
      {/* Starfield background */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,#1a2340_0%,#0a0e1a_60%)]" />
      </div>

      <div className="relative max-w-4xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-sm tracking-[0.3em] text-amber-400/80 font-semibold mb-3">SEDS PAKISTAN</div>
          <div className="text-xs tracking-widest text-slate-400 mb-6">LIVE MISSION STATUS</div>
          {mission?.chapterName && (
            <div className="inline-block px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm font-semibold mb-4">
              {mission.chapterName}
            </div>
          )}
        </div>

        {loading && (
          <div className="text-center py-20">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mb-4" />
            <p className="text-slate-400">Acquiring mission telemetry...</p>
          </div>
        )}

        {error && !loading && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">🛰️</div>
            <h1 className="text-2xl font-bold mb-2">Signal Lost</h1>
            <p className="text-slate-400 mb-6">{error}</p>
            <Link href="/" className="px-6 py-3 rounded-lg bg-amber-500 text-black font-semibold hover:bg-amber-400 transition">
              Return to Base
            </Link>
          </div>
        )}

        {mission && !loading && (
          <>
            {/* Mission title + progress */}
            <div className="text-center mb-10">
              <h1 className="text-3xl sm:text-4xl font-bold leading-tight mb-6">{mission.title}</h1>
              <div className="max-w-md mx-auto">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-slate-400">Mission Progress</span>
                  <span className={`font-bold ${mission.isCompleted ? 'text-green-400' : 'text-amber-400'}`}>
                    {mission.progressPercentage}%
                  </span>
                </div>
                <div className="h-3 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-1000 ${mission.isCompleted ? 'bg-green-400' : 'bg-gradient-to-r from-amber-500 to-amber-300'}`}
                    style={{ width: `${mission.progressPercentage}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-2">
                  <span>{mission.completedSteps} of {mission.totalSteps} objectives complete</span>
                  {mission.deadline && <span>Deadline: {formatDate(mission.deadline)}</span>}
                </div>
              </div>
              {mission.isCompleted && (
                <div className="mt-6 inline-block px-6 py-2 rounded-full bg-green-500/15 border border-green-500/40 text-green-300 font-bold tracking-widest">
                  ★ MISSION ACCOMPLISHED
                </div>
              )}
            </div>

            {/* Steps timeline */}
            <div className="space-y-4">
              {mission.steps.map((step, i) => {
                const st = STATUS_STYLES[step.status] || STATUS_STYLES.pending;
                const isDone = step.status === 'completed';
                return (
                  <div
                    key={i}
                    className={`rounded-2xl border p-5 sm:p-6 backdrop-blur transition ${
                      isDone ? 'border-green-500/30 bg-green-500/5' : 'border-white/10 bg-white/5'
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      <div className={`mt-1 h-10 w-10 shrink-0 rounded-full flex items-center justify-center font-bold text-lg border ${
                        isDone ? 'bg-green-500/20 border-green-500/40 text-green-300' : 'bg-white/5 border-white/15 text-slate-300'
                      }`}>
                        {isDone ? '✓' : String(i + 1).padStart(2, '0')}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <h2 className="text-lg font-bold">{step.title}</h2>
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${st.bg} ${st.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                            {st.label}
                          </span>
                        </div>
                        {step.description && (
                          <p className="text-slate-400 text-sm leading-relaxed mb-3">{step.description}</p>
                        )}
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                          <span className="text-slate-300">
                            <span className="text-slate-500">Assigned: </span>
                            <span className="font-semibold">{step.assigneeName}</span>
                            {step.assigneeChapter && (
                              <span className="text-emerald-300/80"> · {step.assigneeChapter}</span>
                            )}
                          </span>
                          {step.role && (
                            <span className="text-slate-500">{step.role}</span>
                          )}
                          <span className="text-slate-500">
                            Due: <span className="text-slate-300">{formatDate(step.individualDeadline)}</span>
                          </span>
                          {step.points > 0 && (
                            <span className="text-amber-400/90 font-semibold">{step.points} pts</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="text-center mt-12 pt-8 border-t border-white/10">
              <p className="text-slate-500 text-sm mb-4">
                Live telemetry refreshes automatically · SEDS Pakistan Mission Control
              </p>
              <Link href="/" className="text-amber-400 hover:text-amber-300 text-sm font-semibold">
                ← Back to SEDS Pakistan
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
