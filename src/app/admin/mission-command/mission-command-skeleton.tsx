'use client';

import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading skeleton for /admin/mission-command.
 *
 * Mirrors the real layout 1:1 at every breakpoint (same grid, column spans,
 * card padding, rounding and approximate content heights) so swapping
 * skeleton -> real content produces zero layout shift. Skeleton tones use
 * bg-slate-800/60 to match the page's dark command-deck palette.
 *
 * Keep this file in sync with page.tsx if the grid/card structure changes.
 */
function StatCardSkeleton() {
  return (
    <div className="relative overflow-hidden border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 shadow-2xl">
      <Skeleton className="h-3 w-24 mb-6 bg-slate-800/60" />
      <Skeleton className="h-9 sm:h-12 md:h-16 w-28 bg-slate-800/60" />
      <div className="mt-4 flex items-center gap-2">
        <Skeleton className="h-3 w-3 rounded-full bg-slate-800/60" />
        <Skeleton className="h-3 w-28 bg-slate-800/60" />
      </div>
    </div>
  );
}

function SyncCardSkeleton() {
  return (
    <div className="border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 shadow-2xl">
      <div className="flex justify-between items-center mb-6">
        <Skeleton className="h-3 w-20 bg-slate-800/60" />
        <Skeleton className="h-5 w-16 rounded bg-slate-800/60" />
      </div>
      <div className="flex gap-1.5 h-2 w-full mb-4" aria-hidden="true">
        {[...Array(8)].map((_, i) => (
          <Skeleton key={i} className="h-full flex-1 rounded-full bg-slate-800/60" />
        ))}
      </div>
      <Skeleton className="h-3 w-3/4 bg-slate-800/60" />
    </div>
  );
}

function MissionRowSkeleton() {
  return (
    <div className="border border-slate-800 bg-[#1E293B]/20 rounded-3xl p-4 sm:p-6">
      <div className="flex justify-between items-start gap-3 mb-4 md:mb-6">
        <div className="space-y-2 flex-1 min-w-0">
          <Skeleton className="h-5 w-2/3 bg-slate-800/60" />
          <Skeleton className="h-3 w-32 bg-slate-800/60" />
        </div>
        <Skeleton className="h-8 w-16 shrink-0 bg-slate-800/60" />
      </div>
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-4 md:mb-6">
        <Skeleton className="h-6 w-32 rounded-lg bg-slate-800/60" />
        <Skeleton className="h-6 w-40 rounded-lg bg-slate-800/60" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full bg-slate-800/60 mb-4 md:mb-6" />
      <div className="flex flex-wrap justify-between items-center gap-3">
        <Skeleton className="h-4 w-1/2 min-w-0 bg-slate-800/60" />
        <Skeleton className="h-11 w-36 rounded-xl bg-slate-800/60" />
      </div>
    </div>
  );
}

function FeedLogSkeleton() {
  return (
    <div className="border border-slate-800/50 bg-[#1E293B]/10 rounded-2xl p-4">
      <Skeleton className="h-3 w-full mb-2 bg-slate-800/60" />
      <div className="flex justify-between items-center mt-2">
        <Skeleton className="h-2 w-20 bg-slate-800/60" />
        <Skeleton className="h-2 w-16 bg-slate-800/60" />
      </div>
    </div>
  );
}

export default function MissionCommandSkeleton() {
  return (
    <div role="status" aria-label="Loading mission command data" aria-busy="true">
      <span className="sr-only">Loading mission command&hellip;</span>

      {/* Tactical Grid - same responsive structure as the real content:
          1 col mobile, 2 col tablet, 12-col 3/6/3 split desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-6 md:gap-8" aria-hidden="true">
        {/* Left Column: Essential Metrics */}
        <div className="md:col-span-2 lg:col-span-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-6">
            <StatCardSkeleton />
            <StatCardSkeleton />
            <SyncCardSkeleton />
          </div>
        </div>

        {/* Center Column: Live Mission Board */}
        <div className="md:col-span-1 lg:col-span-6 border border-slate-800 bg-[#0F172A] rounded-[2.5rem] p-5 sm:p-8 md:p-10 relative overflow-hidden flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.5)]">
          <div className="flex flex-wrap justify-between items-center gap-4 mb-6 md:mb-10 pb-6 border-b border-slate-800/60">
            <Skeleton className="h-5 w-48 bg-slate-800/60" />
            <Skeleton className="h-7 w-32 rounded-full bg-slate-800/60" />
          </div>
          <div className="space-y-4 md:space-y-6 flex-1">
            <MissionRowSkeleton />
            <MissionRowSkeleton />
            <MissionRowSkeleton />
          </div>
        </div>

        {/* Right Column: Command Feed & Diagnostics */}
        <div className="md:col-span-1 lg:col-span-3 space-y-6">
          <div className="border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 h-[380px] sm:h-[450px] flex flex-col shadow-2xl">
            <Skeleton className="h-4 w-36 mb-5 md:mb-8 bg-slate-800/60" />
            <div className="flex-1 space-y-4 md:space-y-5">
              <FeedLogSkeleton />
              <FeedLogSkeleton />
              <FeedLogSkeleton />
              <FeedLogSkeleton />
            </div>
          </div>

          <div className="border border-slate-800 bg-[#0F172A] rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-8 h-[250px] flex flex-col items-center justify-center shadow-2xl">
            <Skeleton className="h-12 w-12 rounded-full bg-slate-800/60 mb-6" />
            <Skeleton className="h-3 w-40 bg-slate-800/60" />
            <Skeleton className="h-2 w-32 bg-slate-800/60 mt-2" />
          </div>
        </div>
      </div>

      {/* Operational Readiness Footer */}
      <div className="mt-12 border-t border-slate-800/60 pt-10 pb-6" aria-hidden="true">
        <div className="flex flex-col md:flex-row justify-between items-stretch md:items-end mb-8 gap-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-64 max-w-full bg-slate-800/60" />
            <Skeleton className="h-3 w-96 max-w-full bg-slate-800/60" />
          </div>
          <Skeleton className="h-16 w-48 rounded-3xl bg-slate-800/60" />
        </div>
        <Skeleton className="h-6 w-full rounded-xl bg-slate-800/60 mb-6" />
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <Skeleton className="h-3 w-96 max-w-full bg-slate-800/60" />
          <Skeleton className="h-6 w-64 max-w-full rounded-full bg-slate-800/60" />
        </div>
      </div>
    </div>
  );
}
