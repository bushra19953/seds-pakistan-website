/**
 * UX fix program — TaskForm behaviour (F1 validation transparency,
 * F3 workflow-plan construction, F5 availability honesty, F6 points
 * defaults).
 *
 * On the base tree these fail: the missing-items list does not exist
 * (the button disabled silently), penalty/bonus start pre-filled and
 * `Number(x) || undefined` eats a deliberate 0, the availability gate
 * blocks every create with assignees (the server only enforces it for
 * on-site work), the panel is titled "Availability check" and renders
 * an "Unknown" verdict, the Workflow Plan empty state has no way to
 * add a first step, and the parser files steps literally titled
 * "Step 1" behind a button called "Generate Workflow Plan".
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
  { uid: 'u-avail', displayName: 'Avail Person', email: 'avail@example.com', chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
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

function renderForm(props: Partial<React.ComponentProps<typeof TaskForm>> = {}) {
  const onSubmit = jest.fn();
  const utils = render(
    <TaskForm onSubmit={onSubmit} submitLabel="Create Task" {...props} />
  );
  return { onSubmit, ...utils };
}

function fillBasics() {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Poster run' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Print the posters' } });
  fireEvent.change(screen.getByLabelText('Base Points'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('Deadline *'), { target: { value: futureLocal(72) } });
}

describe('TaskForm UX (F1/F3/F5/F6)', () => {
  it('F1: lists exactly what is missing and disables submit on it', () => {
    renderForm();
    expect(screen.getByText('Still needed before you can create')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(expect.arrayContaining(['Title', 'Description', 'Base points', 'Deadline']));
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();
  });

  it('F6: untouched penalty/bonus file the house defaults; the note says so up front', async () => {
    const { onSubmit } = renderForm();
    expect(screen.getByText(/Points defaults:/)).toBeInTheDocument();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.penaltyPoints).toBe(5);
    expect(values.workflowBonusPoints).toBe(10);
  });

  it('F1/F6: a deliberate 0 penalty is filed as 0, not treated as missing', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('Deadline Penalty'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Workflow Bonus'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Create Task' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.penaltyPoints).toBe(0);
    expect(values.workflowBonusPoints).toBe(0);
  });

  it('F5: a remote task with unattested assignees is not blocked', async () => {
    renderForm({
      initialValues: {
        title: 'Remote write-up',
        description: 'Write it from home',
        points: 20,
        deadline: futureLocal(72),
        assigneeIds: ['u-avail'],
        availabilityConfirmed: false,
      },
    });
    expect(await screen.findByText('Leave status')).toBeInTheDocument();
    expect(screen.getByText('No leave recorded')).toBeInTheDocument();
    expect(screen.queryByText('Availability check')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Task' })).not.toBeDisabled();
  });

  it('F5/F1: an on-site task without a location lists it as missing and blocks', () => {
    renderForm({
      initialValues: {
        title: 'Booth duty',
        description: 'Staff the booth',
        points: 20,
        deadline: futureLocal(72),
        assigneeIds: ['u-avail'],
        requiresOnSitePresence: true,
        locationRequired: '',
        availabilityConfirmed: false,
      },
    });
    expect(screen.getByText('On-site location')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Task' })).toBeDisabled();
  });

  it('F3: the empty Workflow Plan offers an Add first step button that works', () => {
    renderForm();
    const addFirst = screen.getByRole('button', { name: 'Add first step' });
    fireEvent.click(addFirst);
    expect(screen.getByLabelText('Step Title')).toBeInTheDocument();
  });

  it('F3: parsing Step N lines files real titles, and the 24h rule becomes visible', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Poster mission' } });
    fireEvent.change(screen.getByLabelText('Base Points'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Step 1: Draft the poster\nStep 2: Print fifty copies' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parse steps from description' }));
    const titleInputs = screen.getAllByLabelText('Step Title') as HTMLInputElement[];
    expect(titleInputs.map((i) => i.value)).toEqual(['Draft the poster', 'Print fifty copies']);
    // Deadline inside 24h: the rule shows in the missing list (F1).
    fireEvent.change(screen.getByLabelText('Deadline *'), { target: { value: futureLocal(1) } });
    expect(screen.getByText(/Workflow deadline at least 24 hours from now/)).toBeInTheDocument();
    expect(screen.getByText(/Workflow deadlines must be at least 24 hours from now/)).toBeInTheDocument();
    // Deadline beyond 24h: the item clears.
    fireEvent.change(screen.getByLabelText('Deadline *'), { target: { value: futureLocal(72) } });
    expect(screen.queryByText(/Workflow deadline at least 24 hours from now/)).not.toBeInTheDocument();
  });
});
