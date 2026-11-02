/**
 * Regression: admin Edit dialog must load for task docs whose stored shape
 * does not match the form's contract (MSG22, Bushra proof tasks).
 *
 * Docs written outside the /api/tasks zod schemas (direct console writes,
 * legacy shapes, synthetic proof tasks) can carry a single resource object
 * instead of an array, a bare URL string, null resource entries, or a
 * non-string title/description. Before the fix, TaskForm dereferenced those
 * shapes directly (.trim() on title/description, .map() on
 * assigneeIds/resources) and threw during the first render, so the Edit
 * dialog never appeared for those tasks while the task list (which never
 * touches these fields) rendered fine.
 *
 * Each case below crashed before the fix and must render after it.
 * Where the malformed value still carries user data (a proof link), the
 * dialog must preserve it, not drop it.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
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
  { uid: 'u-bushra', displayName: 'Bushra Rahman', email: 'bushra@example.com', chapterId: 'seds-ist-chapter', role: 'member', additionalRoles: [], isOnVacation: false },
];

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

function baseProps(overrides: Record<string, any> = {}) {
  return {
    onSubmit: jest.fn(),
    submitLabel: 'Update Task',
    editMode: true,
    initialValues: {
      title: 'Email Premium Proof',
      description: 'Proof that premium email delivery works',
      assigneeIds: ['u-bushra'],
      completionBadgeId: '',
      points: 10,
      chapterId: '',
      penaltyPoints: 5,
      workflowBonusPoints: 10,
      guidance: undefined,
      resources: [],
      reviewerId: '',
      projectId: undefined,
      status: 'pending',
      deadline: '2026-11-15T12:00',
      report: '',
      availabilityConfirmed: true,
      resolutionNote: '',
      ...overrides,
    },
  } as any;
}

describe('TaskForm with malformed persisted doc shapes (MSG22)', () => {
  it('renders when resources is a single object, and keeps the proof link', () => {
    render(
      <TaskForm
        {...baseProps({
          resources: { title: 'Proof', url: 'https://example.com/proof', type: 'link' },
        })}
      />,
    );
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://example.com/proof')).toBeInTheDocument();
  });

  it('renders when resources is a bare URL string, and keeps the link', () => {
    render(
      <TaskForm
        {...baseProps({
          resources: 'https://example.com/proof',
        })}
      />,
    );
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://example.com/proof')).toBeInTheDocument();
  });

  it('renders when resources contains null entries, dropping only the nulls', () => {
    render(
      <TaskForm
        {...baseProps({
          resources: [null, { title: 'Proof', url: 'https://example.com/proof', type: 'link' }],
        })}
      />,
    );
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://example.com/proof')).toBeInTheDocument();
  });

  it('renders when title/description are non-strings, falling back to empty', () => {
    render(
      <TaskForm
        {...baseProps({
          title: { text: 'Email Premium Proof' },
          description: { text: 'Proof that premium email delivery works' },
        })}
      />,
    );
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('renders when assigneeIds is a single string', () => {
    render(
      <TaskForm
        {...baseProps({
          assigneeIds: 'u-bushra',
        })}
      />,
    );
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
  });

  it('renders workflow steps whose resources contain null entries', () => {
    render(
      <TaskForm
        {...baseProps({})}
        initialWorkflowSteps={[
          {
            id: 'step-1',
            title: 'Proof step',
            description: '',
            assigneeId: 'u-bushra',
            assigneeIds: ['u-bushra'],
            resources: [null, { title: 'Proof', url: 'https://example.com/proof', type: 'link' }],
          },
        ]}
      />,
    );
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://example.com/proof')).toBeInTheDocument();
  });

  it('well-formed docs are unchanged', () => {
    render(
      <TaskForm
        {...baseProps({
          resources: [{ title: 'Proof', url: 'https://example.com/proof', type: 'link' }],
        })}
      />,
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Email Premium Proof');
    expect(screen.getByDisplayValue('https://example.com/proof')).toBeInTheDocument();
  });
});
