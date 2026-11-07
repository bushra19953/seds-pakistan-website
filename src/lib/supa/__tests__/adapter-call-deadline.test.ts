/**
 * @jest-environment node
 *
 * Adapter call deadlines — regression suite for the 2026-11-07
 * workflow-create submit hang.
 *
 * Root cause (systematic-debugging investigation, 2026-11-07):
 * POST /api/workflows sequentially awaits Supabase adapter calls —
 * supaGetDoc reads in the permission/validation prelude and one
 * mirror setDoc per step task + per workflow member — and NO layer
 * of that chain carried a deadline: the supabase-js client is built
 * with no timeout and no fetch wrapper (src/lib/supa/client.ts),
 * and both seams catch REJECTIONS but cannot catch a promise that
 * never settles. One transiently stalled PostgREST fetch therefore
 * pinned the create request (and the form's spinner) forever:
 * two hung submits on the 4-step role-grant create, one 8+ minute
 * hang on the 49-step acknowledgment create, zero docs mirrored,
 * instant success on retry. Every Firestore read in the sibling
 * paths is deadline-wrapped (src/lib/server/read-deadline.ts); the
 * Supabase layer never was.
 *
 * These tests pin the cure at the adapter: every adapter call must
 * REJECT with a deadline error when its transport never settles, so
 * the seams' existing failure semantics apply (reads fall back to
 * Firestore, mirror writes degrade to a logged no-op). A transport
 * that settles inside the deadline must be unaffected.
 *
 * On the pre-fix tree every "never settles" case below fails: the
 * adapter promise simply never settles, exactly as in production.
 */

import { createSupaAdapter } from '../adapter';
import { FakeClient } from './fake-client';

/** A supabase-js-shaped client whose every transport promise never settles. */
function neverSettlingClient(): any {
  const never = () => new Promise<any>(() => {});
  const chain: any = {
    maybeSingle: () => never(),
    then: (onFulfilled?: any, onRejected?: any) => never().then(onFulfilled, onRejected),
  };
  for (const m of ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'is', 'not', 'filter', 'order', 'limit']) {
    chain[m] = () => chain;
  }
  const table: any = {
    select: () => chain,
    upsert: () => never(),
    update: () => chain,
    delete: () => chain,
  };
  return { from: () => table, rpc: () => never() };
}

describe('supa adapter call deadlines (never-settling transport)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('setDoc rejects with a deadline error instead of hanging forever', async () => {
    const adapter = createSupaAdapter(neverSettlingClient());
    let settled = false;
    let error: any = null;
    void adapter.setDoc('tasks', 'doc-1', { title: 'x' }).then(
      () => { settled = true; },
      (e) => { settled = true; error = e; },
    );
    await jest.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(true);
    expect(error).toBeTruthy();
    expect(String(error?.message ?? error)).toMatch(/deadline/i);
  });

  it('getDoc rejects with a deadline error instead of hanging forever', async () => {
    const adapter = createSupaAdapter(neverSettlingClient());
    let settled = false;
    let error: any = null;
    void adapter.getDoc('users', 'user-1').then(
      () => { settled = true; },
      (e) => { settled = true; error = e; },
    );
    await jest.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(true);
    expect(error).toBeTruthy();
    expect(String(error?.message ?? error)).toMatch(/deadline/i);
  });

  it('listDocs rejects with a deadline error instead of hanging forever', async () => {
    const adapter = createSupaAdapter(neverSettlingClient());
    let settled = false;
    let error: any = null;
    void adapter.listDocs('tasks', { limit: 5 }).then(
      () => { settled = true; },
      (e) => { settled = true; error = e; },
    );
    await jest.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(true);
    expect(error).toBeTruthy();
    expect(String(error?.message ?? error)).toMatch(/deadline/i);
  });
});

describe('supa adapter call deadlines (settling transports are unaffected)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a transport that settles immediately still succeeds', async () => {
    const adapter = createSupaAdapter(new FakeClient() as any);
    await expect(adapter.setDoc('tasks', 'doc-1', { title: 'x' })).resolves.toMatchObject({ id: 'doc-1' });
    await expect(adapter.getDoc('tasks', 'doc-1')).resolves.toBeNull();
  });

  it('a slow transport that settles inside the deadline still succeeds', async () => {
    const slowClient: any = {
      from: () => ({
        upsert: () => new Promise((resolve) => {
          setTimeout(() => resolve({ data: null, error: null, count: null }), 2_000);
        }),
      }),
      rpc: () => new Promise(() => {}),
    };
    const adapter = createSupaAdapter(slowClient);
    let settled = false;
    let error: any = null;
    void adapter.setDoc('tasks', 'doc-1', { title: 'x' }).then(
      () => { settled = true; },
      (e) => { settled = true; error = e; },
    );
    await jest.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    expect(error).toBeNull();
  });
});
