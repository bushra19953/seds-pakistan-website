/**
 * @jest-environment node
 *
 * Regression suite for the /api/tasks SILENT-EMPTY defect
 * (2026-10-29): the tasks seams declare Firestore-idiom tuple
 * orderBy ([field, direction]) in their SupaListOptions and forward
 * it verbatim, while the adapter's normalizeOrders only understood
 * OrderSpec objects. The tuple's two strings were mapped as if they
 * were spec objects, manufacturing { field: undefined } specs whose
 * G4 existence filter excluded every document — so GET /api/tasks
 * and GET /api/tasks/by-workflow returned well-formed EMPTY pages
 * against a populated fs_tasks, with no error anywhere.
 *
 * These tests run the REAL adapter (createSupaAdapter over the
 * recording FakeClient) and the REAL seam wrappers — the exact
 * boundary the mocked suites on both sides never exercised.
 * Zero live calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupaAdapter, SupaAdapterError } from '@/lib/supa/adapter';
import { listTasksDocs } from '@/lib/supa/seam-tasks-route';
import { listTasksByWorkflowDocs } from '@/lib/supa/seam-admin-tasks';
import { FakeClient } from './fake-client';

function adapterWith(fake: FakeClient) {
  return createSupaAdapter(fake as unknown as SupabaseClient);
}

const ISO = (s: string) => s;

function tasksFake() {
  return new FakeClient({
    fs_tasks: {
      rows: [
        { id: 't-old', data: { title: 'Old', status: 'pending', createdAt: ISO('2026-10-19T13:57:42.192Z') } },
        { id: 't-mid', data: { title: 'Mid', status: 'completed', createdAt: ISO('2026-10-25T03:13:07.039Z') } },
        { id: 't-new', data: { title: 'New', status: 'pending', createdAt: ISO('2026-10-25T03:15:51.007Z') } },
        { id: 't-nodate', data: { title: 'No createdAt', status: 'pending' } },
      ],
    },
  });
}

describe('tuple orderBy [field, direction] through the real adapter', () => {
  it('serves a populated list newest-first (the GET /api/tasks tier-1 shape)', async () => {
    const docs = await adapterWith(tasksFake()).listDocs('tasks', {
      orderBy: ['createdAt', 'desc'] as any,
      limit: 100,
    });
    // 't-nodate' is excluded by the orderBy existence rule (G4) —
    // every doc WITH a createdAt must be present.
    expect(docs.map((d) => d.id)).toEqual(['t-new', 't-mid', 't-old']);
  });

  it('honours the ascending direction', async () => {
    const docs = await adapterWith(tasksFake()).listDocs('tasks', {
      orderBy: ['createdAt', 'asc'] as any,
      limit: 100,
    });
    expect(docs.map((d) => d.id)).toEqual(['t-old', 't-mid', 't-new']);
  });

  it('orders dumped-timestamp shapes chronologically alongside ISO strings', async () => {
    const fake = new FakeClient({
      fs_tasks: {
        rows: [
          { id: 'dumped', data: { createdAt: { _seconds: 1761000000, _nanoseconds: 0 } } },
          { id: 'iso', data: { createdAt: ISO('2026-10-25T03:15:51.007Z') } },
        ],
      },
    });
    const docs = await adapterWith(fake).listDocs('tasks', {
      orderBy: ['createdAt', 'desc'] as any,
      limit: 100,
    });
    expect(docs.map((d) => d.id)).toEqual(['iso', 'dumped']);
  });
});

describe('the exact seam calls the routes make', () => {
  it('listTasksDocs (route tier 1 / tier 3 shape) returns snapshot docs, not an empty page', async () => {
    const adapter = adapterWith(tasksFake());
    const docs = await listTasksDocs(adapter as any, {
      where: [],
      orderBy: ['createdAt', 'desc'],
      limit: 100,
    });
    expect(docs.length).toBe(3);
    expect(docs.map((d) => d.id)).toEqual(['t-new', 't-mid', 't-old']);
    expect(docs[0].data().title).toBe('New');
    expect(docs[0].get('status')).toBe('pending');
  });

  it('listTasksByWorkflowDocs returns the workflow steps in sequenceIndex order', async () => {
    const fake = new FakeClient({
      fs_tasks: {
        rows: [
          { id: 'step-3', data: { workflowId: 'wf-1', sequenceIndex: 3, title: 'Third' } },
          { id: 'step-1', data: { workflowId: 'wf-1', sequenceIndex: 1, title: 'First' } },
          { id: 'step-2', data: { workflowId: 'wf-1', sequenceIndex: 2, title: 'Second' } },
          { id: 'step-noseq', data: { workflowId: 'wf-1', title: 'No sequenceIndex' } },
        ],
      },
    });
    const docs = await listTasksByWorkflowDocs(adapterWith(fake) as any, 'wf-1');
    expect(docs.map((d) => d.id)).toEqual(['step-1', 'step-2', 'step-3']);
  });
});

describe('malformed order specs fail loud — never a silent empty page', () => {
  it('rejects a spec object with no field', async () => {
    await expect(
      adapterWith(tasksFake()).listDocs('tasks', { orderBy: [{ field: undefined }] as any, limit: 10 }),
    ).rejects.toThrow(SupaAdapterError);
  });

  it('rejects a tuple with a nonsense direction', async () => {
    await expect(
      adapterWith(tasksFake()).listDocs('tasks', { orderBy: ['createdAt', 'sideways'] as any, limit: 10 }),
    ).rejects.toThrow(/direction/);
  });

  it('rejects an array of non-spec values', async () => {
    await expect(
      adapterWith(tasksFake()).listDocs('tasks', { orderBy: [42] as any, limit: 10 }),
    ).rejects.toThrow(SupaAdapterError);
  });

  it('propagates adapter query errors through the seam instead of resolving []', async () => {
    const fake = new FakeClient({
      fs_tasks: { error: { message: 'relation "public.fs_tasks" does not exist' } },
    });
    await expect(
      listTasksDocs(adapterWith(fake) as any, { orderBy: ['createdAt', 'desc'], limit: 100 }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('the shapes that already worked are unchanged', () => {
  it('OrderSpec object (the review-queue shape) still orders correctly', async () => {
    const fake = new FakeClient({
      fs_tasks: {
        rows: [
          { id: 'q-old', data: { submittedAt: ISO('2026-10-28T10:00:00.000Z') } },
          { id: 'q-new', data: { submittedAt: ISO('2026-10-29T10:00:00.000Z') } },
        ],
      },
    });
    const docs = await adapterWith(fake).listDocs('tasks', {
      orderBy: { field: 'submittedAt', direction: 'desc' },
      limit: 100,
    });
    expect(docs.map((d) => d.id)).toEqual(['q-new', 'q-old']);
  });
});
