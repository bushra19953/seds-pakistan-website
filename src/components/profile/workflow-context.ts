/**
 * Shared, deduplicated loader for GET /api/workflows?workflowId=…
 *
 * Why this exists (profile perf, 2026-10-31): every task card on the
 * unified profile used to fire its own workflow fetch on mount — no
 * cache, no dedupe — so a user with N workflow tasks (the founder has
 * dozens) produced N identical-or-parallel requests before the Mission
 * Control board could settle, and cards in the SAME workflow each
 * re-fetched the same payload. This module is the single client-side
 * entry point for that endpoint from the profile surface:
 *
 *  - concurrent calls for the same workflowId share ONE request
 *    (in-flight dedupe, vercel-react-best-practices: client-swr-dedup);
 *  - a successful payload is cached for the page session, so expanding
 *    a second card in the same workflow is free;
 *  - failures are NOT cached, so a later expand retries honestly.
 *
 * The rich `names` map mirrors the shape the task cards consume:
 * uid -> { name, photoURL, whatsapp, email, role }.
 */

export interface WorkflowContextData {
  steps: any[];
  names: Record<string, any>;
}

const cache = new Map<string, WorkflowContextData>();
const inflight = new Map<string, Promise<WorkflowContextData | null>>();

export function normalizeWorkflowContext(data: any): WorkflowContextData {
  const steps = data?.tasks || [];
  let names: Record<string, any> = {};
  if (data?.assigneeInfo) {
    names = data.assigneeInfo;
  } else if (data?.assigneeNames) {
    Object.keys(data.assigneeNames).forEach((uid) => {
      names[uid] = {
        name: data.assigneeNames[uid],
        photoURL: data.assigneePhotos?.[uid],
        whatsapp: data.assigneeWhatsapps?.[uid],
        email: data.assigneeEmails?.[uid],
        role: data.assigneeRoles?.[uid],
      };
    });
  }
  return { steps, names };
}

export async function loadWorkflowContext(
  workflowId: string,
  getToken: () => Promise<string | null>,
  fetcher: typeof fetch = fetch,
): Promise<WorkflowContextData | null> {
  if (!workflowId) return null;

  const hit = cache.get(workflowId);
  if (hit) return hit;

  const pending = inflight.get(workflowId);
  if (pending) return pending;

  const request = (async (): Promise<WorkflowContextData | null> => {
    try {
      const token = await getToken();
      if (!token) return null;
      const res = await fetcher(`/api/workflows?workflowId=${encodeURIComponent(workflowId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) return null;
      const normalized = normalizeWorkflowContext(data);
      cache.set(workflowId, normalized);
      return normalized;
    } catch {
      return null;
    } finally {
      inflight.delete(workflowId);
    }
  })();

  inflight.set(workflowId, request);
  return request;
}

/** Test hook / manual invalidation: drop one cached workflow payload. */
export function invalidateWorkflowContext(workflowId: string) {
  cache.delete(workflowId);
}

export function clearWorkflowContextCache() {
  cache.clear();
  inflight.clear();
}
