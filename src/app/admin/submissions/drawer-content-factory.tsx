import React, { Suspense } from 'react';

const Inspectors: Record<string, React.LazyExoticComponent<any>> = {
    LEAVE_REQUEST: React.lazy(() => import('@/components/admin/inspectors/leave-inspector')),
    APPLICATION: React.lazy(() => import('@/components/admin/inspectors/application-inspector')),
    FORM_RESPONSE: React.lazy(() => import('@/components/admin/inspectors/form-inspector')),
    TASK_REVIEW: React.lazy(() => import('@/components/admin/inspectors/task-inspector')),
    SUBMISSION: React.lazy(() => import('@/components/admin/inspectors/submission-inspector')),
};

export default function DrawerContentFactory({ submission, onClose }: { submission: any, onClose: () => void }) {
    const InspectorComponent = Inspectors[submission.type];

    return (
        <div className="flex flex-col h-full bg-background relative">

            {/* Drawer Header */}
            <div className="flex items-center justify-between p-6 border-b sticky top-0 bg-background/95 z-10">
                <h2 className="text-xl font-bold tracking-tight pr-4 truncate">
                    {submission.summary_text}
                </h2>
                <button
                    onClick={onClose}
                    className="p-2 rounded-full hover:bg-muted text-muted-foreground transition-colors"
                    aria-label="Close panel"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>

            {/* Drawer Body (Lazy Loaded) */}
            <div className="flex-1 overflow-y-auto p-6 scrollbar-hide pb-24">
                {InspectorComponent ? (
                    <Suspense fallback={
                        <div className="space-y-4 animate-pulse">
                            <div className="h-8 bg-muted rounded w-3/4"></div>
                            <div className="h-4 bg-muted rounded w-full"></div>
                            <div className="h-4 bg-muted rounded w-5/6"></div>
                            <div className="h-32 bg-muted rounded w-full mt-8"></div>
                            <div className="h-12 bg-muted rounded w-1/3"></div>
                        </div>
                    }>
                        <InspectorComponent globalId={submission.global_id} originalRef={submission.original_ref} status={submission.status} />
                    </Suspense>
                ) : (
                    <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground border-2 border-dashed rounded-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mb-4 text-muted-foreground/"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon><line x1="12" y1="22" x2="12" y2="15.5"></line><polyline points="22 8.5 12 15.5 2 8.5"></polyline><polyline points="2 15.5 12 8.5 22 15.5"></polyline><line x1="12" y1="2" x2="12" y2="8.5"></line></svg>
                        <h3 className="font-semibold text-lg mb-2">Unknown Schematic</h3>
                        <p className="text-sm">Cannot resolve an inspector for type <span className="font-mono text-primary bg-primary/10 px-1 rounded">{submission.type}</span>.</p>
                    </div>
                )}
            </div>

        </div>
    );
}
