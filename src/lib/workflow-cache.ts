export const WORKFLOW_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
export const WORKFLOW_STALE_DURATION = 60 * 1000; // 1 minute

export const workflowCache: Record<string, { steps: any[], names: Record<string, string>, timestamp: number }> = {};
export const inflightRequests: Record<string, Promise<{ steps: any[], names: Record<string, string> } | null>> = {};

export const invalidateWorkflowCache = (workflowId: string) => {
    if (workflowCache[workflowId]) {
        delete workflowCache[workflowId];
    }
};
