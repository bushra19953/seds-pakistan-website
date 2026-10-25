/**
 * Mission page data paths — Supabase migration, 'workflows' surface,
 * Group 2 contracts.
 *
 * The public mission page is a client component, and the Supa adapter
 * (@/lib/supa) is server-only, so this page must NEVER read Firestore
 * (or the adapter) directly: every field it renders comes from the one
 * server route GET /api/missions/[workflowId]. These tests pin that:
 *
 * - behavioral: the API payload renders byte-identically (the fields
 *   below are exactly the route's response shape), the request URL is
 *   the encoded missions route, and a confirmed 404 stops polling.
 * - source contracts: no Firestore/adapter imports or read calls in
 *   the mission page or its submit sub-page, and the read-burn poller
 *   wiring (usePollingRefresh, 5-minute floor, 404-stop enable flag)
 *   is not regressed to a raw interval.
 */
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import PublicMissionPage from '@/app/missions/[workflowId]/page';
import { usePollingRefresh } from '@/hooks/use-polling-refresh';

// The jest tsconfig uses the classic JSX runtime, so components that
// rely on Next's automatic runtime need React reachable as a global
// when their JSX evaluates at render time.
(global as any).React = React;

let mockWorkflowId: string | undefined = 'wf 1/x';

jest.mock('next/navigation', () => ({
  useParams: () => ({ workflowId: mockWorkflowId }),
}));

// Capture the poller wiring instead of running real timers: the hook's
// own cadence/hidden-tab behavior is covered by
// src/hooks/__tests__/use-polling-refresh.test.tsx.
jest.mock('@/hooks/use-polling-refresh', () => ({
  MIN_POLL_INTERVAL_MS: 5 * 60 * 1000,
  usePollingRefresh: jest.fn(),
}));

const mockPolling = usePollingRefresh as jest.MockedFunction<any>;

const MISSION = {
  workflowId: 'wf 1/x',
  title: 'Operation Starlight',
  description: 'Build the thing',
  chapterName: 'IST Chapter',
  totalSteps: 2,
  completedSteps: 1,
  progressPercentage: 50,
  isCompleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  deadline: '2026-11-01T00:00:00.000Z',
  steps: [
    {
      title: 'Assemble frame',
      description: 'Bolt it together',
      status: 'completed',
      sequenceIndex: 0,
      points: 10,
      individualDeadline: '2026-10-20T00:00:00.000Z',
      completedAt: '2026-10-19T00:00:00.000Z',
      assigneeName: 'Ayesha Khan',
      assigneeChapter: 'IST Chapter',
      assignees: [
        { name: 'Ayesha Khan', chapterName: 'IST Chapter' },
        { name: 'Bilal Ahmed', chapterName: null },
      ],
      role: 'Structures Lead',
    },
    {
      title: 'Wire avionics',
      description: '',
      status: 'pending',
      sequenceIndex: 1,
      points: 0,
      individualDeadline: null,
      completedAt: null,
      assigneeName: 'SEDS Member',
      assigneeChapter: null,
      assignees: [{ name: 'SEDS Member', chapterName: null }],
      role: null,
    },
  ],
};

function mockFetchOnce(status: number, body: any) {
  (global as any).fetch = jest.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }));
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });

beforeEach(() => {
  jest.clearAllMocks();
  mockWorkflowId = 'wf 1/x';
});

describe('PublicMissionPage — API-payload rendering', () => {
  it('fetches the encoded missions route once on load and renders its payload', async () => {
    mockFetchOnce(200, { ok: true, mission: MISSION });
    render(<PublicMissionPage />);

    await waitFor(() => expect(screen.getByText('Operation Starlight')).toBeTruthy());

    expect((global as any).fetch).toHaveBeenCalledTimes(1);
    expect((global as any).fetch).toHaveBeenCalledWith('/api/missions/wf%201%2Fx');

    // Workflow-level fields from the payload.
    expect(screen.getAllByText('IST Chapter').length).toBeGreaterThan(0);
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('1 of 2 objectives complete')).toBeTruthy();
    expect(screen.getByText(`Deadline: ${fmt('2026-11-01T00:00:00.000Z')}`)).toBeTruthy();

    // Step-level fields from the payload, incl. co-assignee count and
    // the per-step chapter/role/points the API already resolves
    // server-side (no client users/chapters reads needed).
    expect(screen.getByText('Assemble frame')).toBeTruthy();
    expect(screen.getByText('COMPLETED')).toBeTruthy();
    expect(screen.getByText('Ayesha Khan')).toBeTruthy();
    expect(screen.getByText(/\+ 1 in the loop/)).toBeTruthy();
    expect(screen.getByText('Structures Lead')).toBeTruthy();
    expect(screen.getByText('10 pts')).toBeTruthy();
    expect(screen.getByText('Wire avionics')).toBeTruthy();
    expect(screen.getByText('PENDING')).toBeTruthy();
  });

  it('polls through usePollingRefresh at the 5-minute floor while the mission exists', async () => {
    mockFetchOnce(200, { ok: true, mission: MISSION });
    render(<PublicMissionPage />);
    await waitFor(() => expect(screen.getByText('Operation Starlight')).toBeTruthy());

    expect(mockPolling).toHaveBeenCalled();
    for (const call of mockPolling.mock.calls) {
      expect(call[1]).toBe(5 * 60 * 1000);
    }
    // Enabled on the last render (mission found, not 404).
    expect(mockPolling.mock.calls[mockPolling.mock.calls.length - 1][2]).toBe(true);
  });

  it('a confirmed 404 renders not-found and disables the poller (404-stop preserved)', async () => {
    mockFetchOnce(404, { ok: false, error: 'Mission not found' });
    render(<PublicMissionPage />);

    await waitFor(() => expect(screen.getByText('Mission Not Found')).toBeTruthy());
    await waitFor(() => {
      const last = mockPolling.mock.calls[mockPolling.mock.calls.length - 1];
      expect(last[2]).toBe(false);
    });
  });

  it('a non-404 failure renders Signal Lost and does not stop polling as if deleted', async () => {
    mockFetchOnce(500, { ok: false, error: 'Internal Server Error' });
    render(<PublicMissionPage />);

    await waitFor(() => expect(screen.getByText('Signal Lost')).toBeTruthy());
    expect(screen.queryByText('Mission Not Found')).toBeNull();
    const last = mockPolling.mock.calls[mockPolling.mock.calls.length - 1];
    expect(last[2]).toBe(true);
  });
});

describe('mission page surface — source contracts', () => {
  const readSrc = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');

  const pageSrc = () => readSrc('app/missions/[workflowId]/page.tsx');
  const submitSrc = () =>
    readSrc('app/missions/[workflowId]/submit/[stepIndex]/page.tsx');

  it.each([
    ['public mission page', pageSrc],
    ['mission submit page', submitSrc],
  ])('%s: no direct Firestore reads and no server-only adapter import', (_name, getSrc) => {
    const src = getSrc();
    expect(src).not.toContain("from 'firebase/firestore'");
    expect(src).not.toContain("from '@/firebase'");
    expect(src).not.toContain("from '@/lib/supa'");
    expect(src).not.toMatch(/\bgetDoc\s*\(/);
    expect(src).not.toMatch(/\bgetDocs\s*\(/);
    expect(src).not.toMatch(/\bonSnapshot\s*\(/);
  });

  it('public mission page: sole data source is the missions API route', () => {
    const src = pageSrc();
    expect(src).toContain('fetch(`/api/missions/${encodeURIComponent(workflowId)}`)');
  });

  it('submit page: step data and writes go through API routes only', () => {
    const src = submitSrc();
    expect(src).toContain('/api/missions/');
    expect(src).toContain('/submit/');
    expect(src).toContain("fetch('/api/tasks'");
  });

  it('poller preservation: shared hook, 5-minute interval, 404-stop flag, no raw interval', () => {
    const src = pageSrc();
    expect(src).toContain(
      'usePollingRefresh(fetchMission, 5 * 60 * 1000, !!workflowId && !notFound)',
    );
    expect(src).not.toMatch(/\bsetInterval\s*\(/);
  });
});
