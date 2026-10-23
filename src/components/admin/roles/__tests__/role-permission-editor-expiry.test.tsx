/**
 * RolePermissionEditor default term round trip (EXPIRY-UI plan 3.2,
 * contracts 1.2 and 1.4):
 * - The editor saves COMPLETE state in one POST, so the definition
 *   default term must round trip here or it can never be edited after
 *   create and an omitted field risks diverging from the stored doc.
 * - For a custom definition (isCustom true), the stored defaultTermDays
 *   loads into the editor section's field labelled "Default Term (days)"
 *   with id custom-default-term-days (the label/id the editor renders,
 *   pinned by role-permission-editor-custom.test.tsx), and an untouched
 *   save posts the same value back under defaultTermDays. Editing
 *   changes it; clearing sends no positive value (null per contracts
 *   1.2).
 * - For a non-custom definition the field is absent and the save body
 *   carries no defaultTermDays key at all: non-custom saves stay
 *   byte-identical in shape to baseline.
 *
 * No em dashes are used in test names in this file.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mutable holder for the roleDefinitions doc the editor loads.
const mockDefState: { data: Record<string, any> | undefined } = { data: undefined };

jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({
    exists: () => mockDefState.data !== undefined,
    data: () => mockDefState.data,
  })),
  collection: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({ docs: [] })),
  orderBy: jest.fn(() => ({})),
  query: jest.fn((...args: any[]) => args[0]),
}));

jest.mock('firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { getIdToken: jest.fn(async () => 'test-token') },
  }),
}));

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
  useUser: () => ({ user: { uid: 'uid-admin' }, role: 'superadmin' }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/components/admin/governance/consent-request-picker', () => ({
  ConsentRequestPicker: () => null,
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

import { RolePermissionEditor } from '../role-permission-editor';

// The jest tsconfig uses the classic JSX runtime.
(globalThis as any).React = React;

const CUSTOM_SLUG = 'custom_poster_team_lead';

let fetchMock: jest.Mock;

beforeAll(() => {
  // Shims Radix ScrollArea expects from a real browser.
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
  fetchMock = jest.fn(async () => ({
    ok: true,
    json: async () => ({ success: true }),
  }));
  global.fetch = fetchMock as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function saveBodies() {
  return fetchMock.mock.calls
    .filter(([url]: any[]) => url === '/api/admin/role-permissions')
    .map(([, init]: any[]) => JSON.parse((init as any).body));
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
  await waitFor(() => expect(saveBodies().length).toBe(1));
  return saveBodies()[0];
}

describe('RolePermissionEditor default term (custom definition)', () => {
  beforeEach(() => {
    mockDefState.data = {
      description: 'Leads the poster team for events',
      category: 'Custom',
      isActive: true,
      isCustom: true,
      // A valid custom definition must pass the four-part test
      // (parentRoleKey a catalog key + chapterId non-empty); without
      // these the editor treats the doc as malformed and never
      // renders the default term field at all.
      parentRoleKey: 'chapter_design_chair',
      chapterId: 'seds-ist-chapter',
      defaultTermDays: 60,
    };
  });

  it('loads the stored default term into a wired field', async () => {
    render(<RolePermissionEditor roleSlug={CUSTOM_SLUG} roleName="Poster Team Lead" />);
    const input = (await screen.findByLabelText(
      'Default Term (days)',
    )) as HTMLInputElement;
    expect(input.id).toBe('custom-default-term-days');
    await waitFor(() => expect(input.value).toBe('60'));
  });

  it('round trips the loaded value on an untouched save (complete-state regression)', async () => {
    render(<RolePermissionEditor roleSlug={CUSTOM_SLUG} roleName="Poster Team Lead" />);
    const input = (await screen.findByLabelText(
      'Default Term (days)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('60'));
    const body = await save();
    expect(body.role).toBe(CUSTOM_SLUG);
    expect(body.defaultTermDays).toBe(60);
  });

  it('posts an edited default term as a number', async () => {
    render(<RolePermissionEditor roleSlug={CUSTOM_SLUG} roleName="Poster Team Lead" />);
    const input = (await screen.findByLabelText(
      'Default Term (days)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('60'));
    fireEvent.change(input, { target: { value: '30' } });
    const body = await save();
    expect(body.defaultTermDays).toBe(30);
  });

  it('posts no positive default term when the field is cleared', async () => {
    render(<RolePermissionEditor roleSlug={CUSTOM_SLUG} roleName="Poster Team Lead" />);
    const input = (await screen.findByLabelText(
      'Default Term (days)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('60'));
    fireEvent.change(input, { target: { value: '' } });
    const body = await save();
    // Contracts 1.2: defaultTermDays is a positive integer or null.
    // Cleared means null (or the key omitted); never 0 or a stale 60.
    expect(body.defaultTermDays == null).toBe(true);
    expect(body.defaultTermDays).not.toBe(60);
  });
});

describe('RolePermissionEditor default term (non-custom definition)', () => {
  beforeEach(() => {
    mockDefState.data = {
      description: 'Chapter treasurer definition',
      category: 'C',
      isActive: true,
    };
  });

  it('renders no default term field', async () => {
    render(<RolePermissionEditor roleSlug="chapter_treasurer" roleName="Chapter Treasurer" />);
    // Wait for the definition load to land (description fills in).
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Describe what this role does/)).toHaveValue(
        'Chapter treasurer definition',
      ),
    );
    expect(screen.queryByLabelText(/Default Term/)).toBeNull();
  });

  it('keeps the save body free of defaultTermDays', async () => {
    render(<RolePermissionEditor roleSlug="chapter_treasurer" roleName="Chapter Treasurer" />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Describe what this role does/)).toHaveValue(
        'Chapter treasurer definition',
      ),
    );
    const body = await save();
    expect(body.role).toBe('chapter_treasurer');
    expect('defaultTermDays' in body).toBe(false);
  });
});
