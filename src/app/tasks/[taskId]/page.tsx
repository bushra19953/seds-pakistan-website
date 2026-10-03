'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import StarryBackground from '@/components/ui/starry-background';

/**
 * 🚀 TASK REDIRECTOR
 * 
 * This page acts as a legacy bridge. 
 * It redirects individual task URLs to the Unified Profile's task focus mode.
 * 
 * Reason: Consolidation of task management into the high-performance OptimizedProfile.
 */
export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params?.taskId as string;
  const router = useRouter();

  useEffect(() => {
    if (taskId && router) {
      // Use replace to avoid polluting history with the redirect bridge
      router.replace(`/profile/unified?task=${taskId}`);
    }
  }, [taskId, router]);

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
                <Skeleton className="h-20 rounded-xl bg-muted/30" />
              </div>
            </div>
          </div>
          
          <p className="text-center text-[10px] font-black uppercase tracking-[0.4em] text-muted-foreground animate-pulse">
            Establishing Tactical Uplink...
          </p>
        </div>
      </div>
    </StarryBackground>
  );
}
