/**
 * ValidationQueue in-place review dialog.
 *
 * Without an onReview prop, clicking "Review Submission" opens an
 * in-place Dialog (role="dialog") showing the submission payload
 * (report, proof links, points, deadline) instead of navigating away.
 * Approve PATCHes { status: 'completed' }; Reject requires a reason
 * and a future deadline and PATCHes { status: 'changes-requested',
 * feedback_text, reviewDeadline }.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ValidationQueue } from '@/components/profile/validation-queue';

(globalThis as any).React = React;

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'reviewer-1', getIdToken: async () => 'tok' },
  }),
}));

jest.mock('@/hooks/use-enhanced-toast', () => ({
  useEnhancedToast: () => ({
    showSuccessToast: jest.fn(),
    showErrorToast: jest.fn(),
  }),
}));

const ITEM = {
  id: 'task-1',
  title: 'Containerized ROS 2 Gazebo Rover Simulation',
  submitterUid: 'hassan-uid',
  submitterName: 'Hassan Ali',
  submitterRole: 'member_basic',
  workflowId: 'wf-1',
  sequenceIndex: 0,
  points: 150,
  submittedAt: '2026-10-28T10:00:00.000Z',
  deadline: '2026-10-30T18:59:00.000Z',
  via: 'reviewer',
  depth: null,
  report: 'Built and verified the rover simulation end to end.',
  deliverableFiles: [
    { fileName: 'sim-proof.zip', downloadUrl: 'https://example.com/sim-proof.zip' },
  ],
  resourceLinks: 'https://github.com/example/rover-repo',
  hoursWorked: 6,
};

const fetchMock = jest.fn();
let patchBodies: any[] = [];

function formatLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function futureDatetimeValue(daysAhead = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setSeconds(0, 0);
  return formatLocalDatetime(d);
}

function pastDatetimeValue(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setSeconds(0, 0);
  return formatLocalDatetime(d);
}

function getReasonInput(): HTMLElement {
  try {
    return screen.getByLabelText(/Reason for rejection \(required\)/i);
  } catch {
    try {
      return screen.getByLabelText(/Reason for rejection/i);
    } catch {
      const el =
        document.querySelector('textarea[name="reason"]') ||
        document.querySelector('textarea');
      if (!el) throw new Error('Reason textarea not found');
      return el as HTMLElement;
    }
  }
}

function getDeadlineInput(): HTMLElement {
  try {
    return screen.getByLabelText(/New deadline \(required\)/i);
  } catch {
    try {
      return screen.getByLabelText(/New deadline/i);
    } catch {
      const el = document.querySelector('input[type="datetime-local"]');
      if (!el) throw new Error('Deadline datetime-local input not found');
      return el as HTMLElement;
    }
  }
}

async function renderAndOpenDialog() {
  render(<ValidationQueue />);
  const reviewButton = await screen.findByRole('button', {
    name: /Review Submission/i,
  });
  fireEvent.click(reviewButton);
  const dialog = await screen.findByRole('dialog');
  return dialog;
}

beforeEach(() => {
  fetchMock.mockReset();
  patchBodies = [];
  fetchMock.mockImplementation(async (_url: any, init?: any) => {
    if (init?.method === 'PATCH') {
      try {
        patchBodies.push(JSON.parse(init.body));
      } catch {
        patchBodies.push(init.body);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ tasks: [ITEM] }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ValidationQueue review dialog', () => {
  it('a) renders the item and opens an in-place dialog with report and proof links', async () => {
    const dialog = await renderAndOpenDialog();

    expect(dialog).toBeTruthy();
    // Title and submitter inside the dialog
    expect(within(dialog).getByText(ITEM.title)).toBeTruthy();
    expect(within(dialog).getByText(/Hassan Ali/)).toBeTruthy();
    // Report text
    expect(within(dialog).getByText(ITEM.report)).toBeTruthy();
    // Proof links: deliverableFiles downloadUrl + URL from resourceLinks
    const deliverableAnchor = dialog.querySelector(
      'a[href="https://example.com/sim-proof.zip"]',
    );
    expect(deliverableAnchor).toBeTruthy();
    const resourceAnchor = dialog.querySelector(
      'a[href="https://github.com/example/rover-repo"]',
    );
    expect(resourceAnchor).toBeTruthy();
  });

  it('b) Approve PATCHes status completed and removes the item', async () => {
    const dialog = await renderAndOpenDialog();

    const approveButton = within(dialog).getByRole('button', {
      name: /^Approve$/i,
    });
    fireEvent.click(approveButton);

    await waitFor(() => expect(patchBodies.length).toBe(1));
    expect(patchBodies[0]).toEqual({
      taskId: 'task-1',
      updates: { status: 'completed' },
    });

    // Also verify request shape: PATCH to /api/tasks with auth headers
    const patchCall = fetchMock.mock.calls.find(
      (call: any[]) => call[1]?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    expect(patchCall[0]).toBe('/api/tasks');
    expect(patchCall[1].headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });

    await waitFor(() => {
      expect(screen.queryByText(ITEM.title)).toBeNull();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('c) Reject is blocked when only reason or only deadline is provided', async () => {
    const dialog = await renderAndOpenDialog();

    fireEvent.click(
      within(dialog).getByRole('button', { name: /^Reject$/i }),
    );

    const confirmButton = await screen.findByRole('button', {
      name: /Confirm Rejection/i,
    });
    const reasonInput = getReasonInput();
    const deadlineInput = getDeadlineInput();

    // Reason only -> still disabled
    fireEvent.change(reasonInput, {
      target: { value: 'Needs more work.' },
    });
    expect(confirmButton).toBeDisabled();

    // Clear reason, set only a future deadline -> still disabled
    fireEvent.change(reasonInput, { target: { value: '' } });
    fireEvent.change(deadlineInput, {
      target: { value: futureDatetimeValue(1) },
    });
    expect(confirmButton).toBeDisabled();
  });

  it('d) Reject succeeds with reason and future deadline', async () => {
    const dialog = await renderAndOpenDialog();

    fireEvent.click(
      within(dialog).getByRole('button', { name: /^Reject$/i }),
    );

    const reason = 'Simulation diverges from the reference run.';
    const deadlineValue = futureDatetimeValue(1);

    const reasonInput = getReasonInput();
    const deadlineInput = getDeadlineInput();

    fireEvent.change(reasonInput, { target: { value: reason } });
    fireEvent.change(deadlineInput, { target: { value: deadlineValue } });

    const confirmButton = await screen.findByRole('button', {
      name: /Confirm Rejection/i,
    });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());

    fireEvent.click(confirmButton);

    await waitFor(() => expect(patchBodies.length).toBe(1));
    const body = patchBodies[0];
    expect(body.taskId).toBe('task-1');
    expect(body.updates.status).toBe('changes-requested');
    expect(body.updates.feedback_text).toBe(reason);
    expect(Date.parse(body.updates.reviewDeadline)).toBe(
      new Date(deadlineValue).getTime(),
    );

    await waitFor(() => {
      expect(screen.queryByText(ITEM.title)).toBeNull();
    });
  });

  it('e) Reject stays disabled with a past deadline', async () => {
    const dialog = await renderAndOpenDialog();

    fireEvent.click(
      within(dialog).getByRole('button', { name: /^Reject$/i }),
    );

    const reasonInput = getReasonInput();
    const deadlineInput = getDeadlineInput();

    fireEvent.change(reasonInput, {
      target: { value: 'Simulation diverges from the reference run.' },
    });
    fireEvent.change(deadlineInput, {
      target: { value: pastDatetimeValue() },
    });

    const confirmButton = await screen.findByRole('button', {
      name: /Confirm Rejection/i,
    });
    expect(confirmButton).toBeDisabled();
  });

  it('f) long URLs, raw filenames and labeled descriptions render without overflow-prone markup', async () => {
    const LONG_URL =
      'https://drive.google.com/file/d/1zD0e2iBuFSthknfsuIiQfp9vXkLmNoPqRsTuVwXyZ/view?usp=drivesdk';
    const LONG_FILENAME =
      '1793197995278_document_task-lluEEYxzJenDG2tinZnW_11.jpeg';
    const LONG_ITEM = {
      ...ITEM,
      id: 'task-long',
      title: 'Design the Pioneer Cohort Announcement Cards (9:16 Vertical + 1:1 Square)',
      description:
        '72-Hour Crucible task SEDS-TASK-ROV-SRILANKA-001. Pod: 3A. ' +
        'Deliverable: Two announcement cards. ' +
        `Source files, inside the Crucible Resource Package linked as this step's resource: ${LONG_URL} - canvas #030712, background #0B0E14. ` +
        'Reviewer: Muhammad Huzaifah Shujjah. Estimated time: 120 minutes.',
      report: `Both graphics are completed and ready for review. Mirror: ${LONG_URL}`,
      deliverableFiles: [
        {
          fileName: LONG_FILENAME,
          downloadUrl:
            'https://drive.google.com/file/d/19wMwbfiEQne5s3jykHNmp9cq7vq4Ggzi/view?usp=drivesdk',
          sizeBytes: 130777,
          contentType: 'image/jpeg',
        },
      ],
      resourceLinks: LONG_URL,
    };
    fetchMock.mockImplementation(async (_url: any, init?: any) => {
      if (init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ tasks: [LONG_ITEM] }) };
    });

    const dialog = await renderAndOpenDialog();

    // The dialog clips horizontal overflow instead of scrolling sideways.
    expect(dialog.className).toContain('overflow-x-hidden');

    // Description renders in the chunked labeled format, not one raw wall.
    expect(within(dialog).getByText('Deliverable')).toBeTruthy();
    expect(within(dialog).getByText('Two announcement cards.')).toBeTruthy();

    // The report paragraph carries the wrap-anywhere guard for long tokens.
    const reportEl = within(dialog).getByText(LONG_ITEM.report);
    expect(reportEl.className).toContain('[overflow-wrap:anywhere]');

    // Proof file is a clean attachment row: truncated name, full name on
    // title, formatted size — never the raw filename as wrapping link text.
    const fileAnchor = dialog.querySelector(
      'a[href="https://drive.google.com/file/d/19wMwbfiEQne5s3jykHNmp9cq7vq4Ggzi/view?usp=drivesdk"]',
    );
    expect(fileAnchor).toBeTruthy();
    const nameSpan = fileAnchor!.querySelector('span[title]');
    expect(nameSpan).toBeTruthy();
    expect(nameSpan!.getAttribute('title')).toBe(LONG_FILENAME);
    expect(nameSpan!.className).toContain('truncate');
    expect(within(dialog).getByText('128 KB')).toBeTruthy();

    // Resource URL row truncates the same way, full URL on title.
    const urlAnchor = dialog.querySelector(`a[href="${LONG_URL}"]`);
    expect(urlAnchor).toBeTruthy();
    const urlSpan = urlAnchor!.querySelector('span[title]');
    expect(urlSpan).toBeTruthy();
    expect(urlSpan!.getAttribute('title')).toBe(LONG_URL);
    expect(urlSpan!.className).toContain('truncate');

    // Both actions render.
    expect(
      within(dialog).getByRole('button', { name: /^Approve$/i }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: /^Reject$/i }),
    ).toBeTruthy();
  });
});
