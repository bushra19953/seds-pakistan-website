/**
 * Regression: workflow edit blocks (live incidents, 2026-11-05).
 *
 * Bug A — near-due workflow edits fully blocked. Opening any step task
 * of a workflow whose deadline is under 24h away showed "Workflow
 * deadline at least 24 hours from now" in the still-needed list and
 * disabled Update Task, so NO edit of any kind could be saved, even
 * edits that touch no deadline. The 24h minimum lead is a CREATE-time
 * rule (and a rule for actually CHANGING a workflow deadline); the
 * form applied it unconditionally in edit mode against the deadline
 * the dialog was merely displaying.
 *
 * Bug B — assignee change on a workflow step task silently failed.
 * Changing the top-level assignee of one step task ran the create-flow
 * cascade in handleAssigneeChange, which cleared the plan assignee of
 * every step whose owner was not in the edited task's own assignee
 * list (in a step-task dialog that list is the step's own roster, not
 * the workflow's). The cleared steps kept their co-assignee arrays, so
 * the form's own missing-items check stayed green and the payload went
 * out with steps[].assigneeId undefined; the server schema requires a
 * non-empty assigneeId per step, so the whole PATCH 400'd and nothing
 * persisted. These tests pin the form-level half: the submitted plan
 * must keep every persisted step's assignee intact.
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { getIdToken: async () => 'test-token' } }),
  useFirestore: () => null,
}));

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: () => ({ data: [], loading: false, error: null }),
}));

jest.mock('@/lib/use-memo-firebase', () => ({
  useMemoFirebase: (fn: any) => fn(),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  query: jest.fn(() => ({})),
  doc: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: [] })),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => ({}) })),
}));

import { TaskForm } from '@/components/admin/tasks/task-form';

const PICKER_ROWS = [
  { uid: 'u-lead', displayName: 'Lead Person', email: 'lead@example.com', chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
  { uid: 'u-old', displayName: 'Old Owner', email: 'old@example.com', chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
  { uid: 'u-new', displayName: 'New Owner', email: 'new@example.com', chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
];

function futureLocal(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  Element.prototype.scrollIntoView = jest.fn();
  (Element.prototype as any).hasPointerCapture = jest.fn(() => false);
  (Element.prototype as any).setPointerCapture = jest.fn();
  (Element.prototype as any).releasePointerCapture = jest.fn();
});

beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ users: PICKER_ROWS }),
  })) as any;
});

afterEach(() => cleanup());

// A persisted 4-step workflow, as the admin tasks page hydrates it into
// the edit dialog of ONE of its step tasks (here: step-2, owned by
// u-old). The other steps belong to other people, exactly like the live
// formation/vote workflows.
const STEPS = [
  { id: 'step-1', title: 'First step', description: 'Do first', assigneeId: 'u-lead', assigneeIds: ['u-lead'] },
  { id: 'step-2', title: 'Second step', description: 'Do second', assigneeId: 'u-old', assigneeIds: ['u-old'] },
  { id: 'step-3', title: 'Third step', description: 'Do third', assigneeId: 'u-lead', assigneeIds: ['u-lead'] },
  { id: 'step-4', title: 'Fourth step', description: 'Do fourth', assigneeId: 'u-new', assigneeIds: ['u-new'] },
];

function stepTaskProps(deadlineHoursFromNow: number) {
  return {
    editMode: true,
    submitLabel: 'Update Task',
    initialValues: {
      title: 'Second step',
      description: 'Do second',
      points: 40,
      penaltyPoints: 5,
      workflowBonusPoints: 10,
      assigneeIds: ['u-old'],
      deadline: futureLocal(deadlineHoursFromNow),
      status: 'pending' as const,
      availabilityConfirmed: true,
      reviewerId: '',
      chapterId: '',
      resources: [],
    },
    initialWorkflowSteps: STEPS.map((s) => ({ ...s, assigneeIds: [...s.assigneeIds] })),
  } as any;
}

describe('Bug A: near-due persisted workflow stays editable', () => {
  it('edit mode: an untouched deadline inside 24h does not block the save', async () => {
    const onSubmitWithPlan = jest.fn(async () => {});
    render(<TaskForm {...stepTaskProps(2)} onSubmit={jest.fn()} onSubmitWithPlan={onSubmitWithPlan} />);
    expect(screen.queryByText(/Workflow deadline at least 24 hours from now/)).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Update Task' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(onSubmitWithPlan).toHaveBeenCalled());
  });

  it('edit mode: changing the deadline to another inside-24h value re-arms the rule', () => {
    render(<TaskForm {...stepTaskProps(2)} onSubmit={jest.fn()} onSubmitWithPlan={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('Deadline *'), { target: { value: futureLocal(3) } });
    expect(screen.getByText(/Workflow deadline at least 24 hours from now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Task' })).toBeDisabled();
  });

  it('create mode: the 24h rule still blocks a workflow deadline inside 24h', () => {
    render(
      <TaskForm
        {...stepTaskProps(2)}
        editMode={false}
        submitLabel="Create Task"
        onSubmit={jest.fn()}
        onSubmitWithPlan={jest.fn()}
      />,
    );
    expect(screen.getByText(/Workflow deadline at least 24 hours from now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();
  });
});

describe('Bug B: top-level assignee change on a step task', () => {
  async function clickPickerRow(name: string) {
    // Only the open popover's rows count: step cards and chips elsewhere
    // in the form also render user names as plain text.
    let item: Element | undefined;
    await waitFor(() => {
      item = Array.from(document.querySelectorAll('[cmdk-item]')).find((el) =>
        el.textContent?.includes(name),
      );
      expect(item).toBeTruthy();
    });
    fireEvent.click(item as Element);
  }

  it('keeps every persisted step assigned in the submitted plan', async () => {
    const onSubmitWithPlan = jest.fn(async () => {});
    render(<TaskForm {...stepTaskProps(72)} onSubmit={jest.fn()} onSubmitWithPlan={onSubmitWithPlan} />);

    // Swap the step task's own assignee: u-old -> u-new.
    fireEvent.click(await screen.findByRole('combobox', { name: 'Select assignees' }));
    await clickPickerRow('New Owner');
    await clickPickerRow('Old Owner');
    expect(await screen.findByText('1 user(s) selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update Task' }));
    await waitFor(() => expect(onSubmitWithPlan).toHaveBeenCalled());

    const [values, steps] = onSubmitWithPlan.mock.calls[0] as any[];
    expect(values.assigneeIds).toEqual(['u-new']);
    // The plan the form hands to the save path must still carry a real
    // assignee for EVERY persisted step: the server schema rejects the
    // whole update when any step arrives without one.
    const byId = Object.fromEntries(steps.map((s: any) => [s.id, s.assigneeId]));
    expect(byId).toEqual({
      'step-1': 'u-lead',
      'step-2': 'u-old',
      'step-3': 'u-lead',
      'step-4': 'u-new',
    });
  });

  it('a rejected save shows the failure inside the dialog, not silence', async () => {
    const onSubmitWithPlan = jest.fn(async () => {
      throw new Error('Invalid assignee for workflow: not in participant list');
    });
    render(<TaskForm {...stepTaskProps(72)} onSubmit={jest.fn()} onSubmitWithPlan={onSubmitWithPlan} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update Task' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Save failed: Invalid assignee for workflow: not in participant list');
    // The dialog stays usable: the admin can fix the input and retry.
    expect(screen.getByRole('button', { name: 'Update Task' })).not.toBeDisabled();
  });
});
