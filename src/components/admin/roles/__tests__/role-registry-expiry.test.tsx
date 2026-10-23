/**
 * Role Registry create dialog, default term (EXPIRY-UI plan 3.1 and 3.3,
 * contracts 1.4):
 * - The dialog carries a "Default term (days, optional)" field wired
 *   Label htmlFor + Input id "new-role-default-term" (ui-review U3; the
 *   host dialog's older unwired labels are baseline B1, not copied).
 * - On create, an empty or invalid value omits defaultTermDays from the
 *   POST /api/admin/role-permissions body; a positive integer is sent
 *   as a number under the contracts-pinned key defaultTermDays (days).
 * - The field is labelled a default everywhere: helper copy says it
 *   prefills the grant expiry and each grant can change or clear it
 *   (U6: a definition default is never presented as a holder's expiry).
 * - A registry row whose definition carries a default term shows one
 *   muted line "Default term: {n} days"; rows without one show none.
 *
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mutable holder for the roleDefinitions listener result.
const mockDefsState: { data: any[] } = { data: [] };

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'uid-admin', getIdToken: jest.fn(async () => 'test-token') },
  }),
  useFirestore: () => ({}),
  useCollection: () => ({ data: mockDefsState.data, loading: false }),
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
}));

jest.mock('@/lib/use-memo-firebase', () => ({
  useMemoFirebase: (fn: any) => fn(),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: (permission?: string) =>
    permission ? { isAuthorized: true } : { role: 'superadmin' },
}));

jest.mock('@/lib/unified-roles', () => ({
  getUnifiedRoleOptions: jest.fn(async () => []),
  normalizeRoleSlug: jest.requireActual('@/lib/role-catalog').normalizeRoleSlug,
}));

jest.mock('@/components/admin/governance/consent-request-picker', () => ({
  ConsentRequestPicker: () => null,
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

jest.mock('@/components/admin/roles/role-permission-editor', () => ({
  RolePermissionEditorDrawer: () => null,
}));

import RoleRegistry from '../role-registry';

// The jest tsconfig uses the classic JSX runtime.
(globalThis as any).React = React;

let fetchMock: jest.Mock;

beforeAll(() => {
  // Shims Radix Dialog expects from a real browser (chapter-selector
  // suite pattern).
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
  (Element.prototype as any).hasPointerCapture = jest.fn(() => false);
  (Element.prototype as any).setPointerCapture = jest.fn();
  (Element.prototype as any).releasePointerCapture = jest.fn();
});

beforeEach(() => {
  mockDefsState.data = [];
  fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, role: 'poster_team_lead' }),
  }));
  global.fetch = fetchMock as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function openCreateDialog() {
  render(<RoleRegistry />);
  fireEvent.click(await screen.findByRole('button', { name: /New Role/ }));
  const nameInput = await screen.findByPlaceholderText('e.g., Media Lead, Finance Officer');
  fireEvent.change(nameInput, { target: { value: 'Poster Team Lead' } });
  return screen.getByLabelText('Default term (days, optional)') as HTMLInputElement;
}

function createPostBodies() {
  return fetchMock.mock.calls
    .filter(([url, init]: any[]) => url === '/api/admin/role-permissions' && (init as any)?.method === 'POST')
    .map(([, init]: any[]) => JSON.parse((init as any).body));
}

describe('RoleRegistry create dialog default term', () => {
  it('renders the default term field with a wired label and the pinned id', async () => {
    const input = await openCreateDialog();
    expect(input.id).toBe('new-role-default-term');
    expect(input.type).toBe('number');
    expect(input.min).toBe('1');
  });

  it('labels the field as a default in its helper copy (U6)', async () => {
    await openCreateDialog();
    expect(
      screen.getByText(/Prefills the expiry date when this role is granted/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Each grant can change or clear it/)).toBeInTheDocument();
  });

  it('omits defaultTermDays from the create body when the field is empty', async () => {
    await openCreateDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    await waitFor(() => expect(createPostBodies().length).toBe(1));
    expect('defaultTermDays' in createPostBodies()[0]).toBe(false);
  });

  it('sends a positive integer defaultTermDays in the create body', async () => {
    const input = await openCreateDialog();
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    await waitFor(() => expect(createPostBodies().length).toBe(1));
    expect(createPostBodies()[0].defaultTermDays).toBe(90);
  });

  it('never sends an invalid default term (zero or negative)', async () => {
    const input = await openCreateDialog();
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    // Plan 3.1 allows two honest outcomes: the value is omitted from the
    // body, or submission is blocked with the field left intact. Either
    // way no invalid defaultTermDays may reach the server.
    await waitFor(() => {
      const bodies = createPostBodies();
      if (bodies.length > 0) {
        expect('defaultTermDays' in bodies[0]).toBe(false);
      } else {
        expect(screen.getByLabelText('Default term (days, optional)')).toBeInTheDocument();
      }
    });
    for (const body of createPostBodies()) {
      expect(body.defaultTermDays).toBeUndefined();
    }
  });

  it('never sends an invalid default term (negative)', async () => {
    const input = await openCreateDialog();
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    await waitFor(() => {
      const bodies = createPostBodies();
      if (bodies.length > 0) {
        expect('defaultTermDays' in bodies[0]).toBe(false);
      } else {
        expect(screen.getByLabelText('Default term (days, optional)')).toBeInTheDocument();
      }
    });
    for (const body of createPostBodies()) {
      expect(body.defaultTermDays).toBeUndefined();
    }
  });
});

describe('RoleRegistry row default term line (plan 3.3)', () => {
  it('shows "Default term: {n} days" on a row whose definition carries one', async () => {
    mockDefsState.data = [
      {
        id: 'custom_poster_team_lead',
        slug: 'custom_poster_team_lead',
        name: 'Poster Team Lead',
        category: 'Custom',
        scope: 'chapter',
        permissions: ['canManageTasks'],
        defaultTermDays: 45,
      },
    ];
    render(<RoleRegistry />);
    expect(await screen.findByText('Default term: 45 days')).toBeInTheDocument();
  });

  it('shows no default term line when the definition has none', async () => {
    mockDefsState.data = [
      {
        id: 'custom_poster_team_lead',
        slug: 'custom_poster_team_lead',
        name: 'Poster Team Lead',
        category: 'Custom',
        scope: 'chapter',
        permissions: ['canManageTasks'],
      },
    ];
    render(<RoleRegistry />);
    expect(await screen.findByText('Poster Team Lead')).toBeInTheDocument();
    expect(screen.queryByText(/Default term:/)).toBeNull();
  });
});
