/**
 * Profile client perf (2026-10-31) — founder: the unified profile's
 * tasks "load honay me sari zindgi lga deta he".
 *
 * Proven defects pinned here (skill: vercel-react-best-practices —
 * client-swr-dedup, async waterfalls, rendering long lists):
 *
 *  1. Every TaskCard fired GET /api/workflows?workflowId=… on mount,
 *     uncached and undeduped: N workflow tasks = N requests on page
 *     open, most for below-fold cards. The fetch now goes through the
 *     shared loadWorkflowContext loader (cache + in-flight dedupe)
 *     and is gated on expand / near-viewport visibility.
 *  2. The board resolved assigner/assignee docs with a sequential
 *     getDoc per unique person across ALL tasks on mount; that cache
 *     only feeds the detail dialog, so it is now gated on a task
 *     actually being expanded/opened.
 *  3. The board mounted every active task card at once (timers,
 *     avatars, team strips). It now mounts a bounded first slice
 *     with a Show-more control; small boards render whole, unchanged.
 *  4. WorkflowStepsInline fetched eagerly even when its expanded
 *     panel sat below the fold; its fetch is now visibility-gated.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadWorkflowContext,
  clearWorkflowContextCache,
  normalizeWorkflowContext,
} from '../workflow-context';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const BOARD = 'src/components/profile/assigned-tasks.tsx';
const STEPS = 'src/components/profile/workflow-steps-inline.tsx';

describe('profile client perf — structural contracts', () => {
  it('task cards no longer fetch /api/workflows directly', () => {
    const src = read(BOARD);
    expect(src).not.toContain('/api/workflows?workflowId=');
    expect(src).toContain('loadWorkflowContext');
    expect(src).toContain("from './workflow-context'");
  });

  it('the workflow context fetch is gated on expand or near-visibility', () => {
    const src = read(BOARD);
    expect(src).toContain('IntersectionObserver');
    expect(src).toContain('shouldLoadContext');
    expect(src).toContain('isExpanded || nearVisible');
  });

  it('the board name lookup is gated on an expanded/open task, not mount', () => {
    const src = read(BOARD);
    expect(src).toContain('if (!firestore || !expandedTaskId) return;');
  });

  it('the board caps mounted task cards with a show-more control', () => {
    const src = read(BOARD);
    expect(src).toContain('TASK_RENDER_BUDGET');
    expect(src).toContain('visibleMissions');
    expect(src).toContain('hiddenTaskCount');
    expect(src).toContain('Show more directives');
  });

  it('workflow steps inline defers its fetch until near the viewport', () => {
    const src = read(STEPS);
    expect(src).toContain('IntersectionObserver');
    expect(src).toContain('!workflowId || !inView');
  });
});

describe('loadWorkflowContext — dedupe, cache, retry', () => {
  const token = async () => 'tok';

  beforeEach(() => {
    clearWorkflowContextCache();
  });

  it('dedupes concurrent calls for the same workflow into one request', async () => {
    const fetcher = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, tasks: [{ id: 't1' }], assigneeInfo: { u1: { name: 'A' } } }),
    })) as any;

    const [a, b] = await Promise.all([
      loadWorkflowContext('wf1', token, fetcher),
      loadWorkflowContext('wf1', token, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a?.steps).toHaveLength(1);
    expect(b).toBe(a);
  });

  it('serves a second call from cache without a new request', async () => {
    const fetcher = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, tasks: [], assigneeNames: { u2: 'Bee' }, assigneePhotos: { u2: 'p' } }),
    })) as any;

    const first = await loadWorkflowContext('wf2', token, fetcher);
    const second = await loadWorkflowContext('wf2', token, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    // assigneeNames shape normalizes to the rich names map cards use
    expect(second?.names.u2).toEqual({ name: 'Bee', photoURL: 'p', whatsapp: undefined, email: undefined, role: undefined });
  });

  it('does not cache failures, so a later expand retries', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, tasks: [{ id: 't9' }] }) }) as any;

    const failed = await loadWorkflowContext('wf3', token, fetcher);
    const retried = await loadWorkflowContext('wf3', token, fetcher);

    expect(failed).toBeNull();
    expect(retried?.steps).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns null without a token and performs no request', async () => {
    const fetcher = jest.fn() as any;
    const result = await loadWorkflowContext('wf4', async () => null, fetcher);
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('normalizeWorkflowContext', () => {
  it('prefers assigneeInfo when present', () => {
    const out = normalizeWorkflowContext({ tasks: [1], assigneeInfo: { u: { name: 'X' } }, assigneeNames: { u: 'Y' } });
    expect(out.names.u.name).toBe('X');
    expect(out.steps).toEqual([1]);
  });
});
