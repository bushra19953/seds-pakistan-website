/**
 * Users table expiry surfaces (EXPIRY-UI plan 7.6, sections 4.4/5.3):
 * - The role cell appends the shared GrantExpiryBadge under the role
 *   pill when the row carries roleExpiresAt, in the same states every
 *   other surface derives; it renders nothing when the value is null.
 * - The quick Change Role menu assigns CATALOG picks immediately via
 *   onChangeRole, but a CUSTOM pick never assigns dialog-free: it
 *   opens the Authority Inspector preselected with that role, so the
 *   expiry step cannot be skipped.
 *
 * Menu/command/dropdown primitives are pass-through doubles and the
 * Authority Inspector is a props-recording stub: routing behaviour is
 * what is under test here; the inspector itself is pinned by its own
 * suite (authority-inspector-expiry).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
  useUser: () => ({ user: { uid: 'uid-admin', getIdToken: jest.fn(async () => 'test-token') } }),
}));

jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true }),
}));

jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
}));

jest.mock('@/components/privacy/masked-contact', () => ({
  MaskedContact: ({ value }: { value: string }) => <span>{value}</span>,
}));

jest.mock('../award-badge-dialog', () => ({ __esModule: true, default: () => null }));
jest.mock('../issue-warning-dialog', () => ({ __esModule: true, default: () => null }));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

jest.mock('@/lib/role-definitions', () => ({
  getCustomRoleDefinitions: jest.fn(async () => []),
}));

jest.mock('@/lib/role-management', () => ({
  revokeRole: jest.fn(async () => true),
  deleteRoleProfile: jest.fn(async () => true),
}));

jest.mock('@/lib/authority-refresh', () => ({
  triggerAuthorityRefresh: jest.fn(async () => {}),
}));

// The inspector stub records the props UserActionsCell hands it so the
// routing assertions can read them back.
const inspectorPropsLog: any[] = [];
jest.mock('@/components/admin/roles/authority-inspector', () => ({
  __esModule: true,
  default: (props: any) => {
    inspectorPropsLog.push(props);
    return props.open ? (
      <div data-testid="inspector-stub" data-initial-role={props.initialRole ?? ''} />
    ) : null;
  },
}));

jest.mock('@/components/ui/dropdown-menu', () => {
  const ReactLocal = require('react');
  const frag = ({ children }: any) => ReactLocal.createElement(ReactLocal.Fragment, null, children);
  return {
    DropdownMenu: frag,
    DropdownMenuTrigger: frag,
    DropdownMenuPortal: frag,
    DropdownMenuSub: frag,
    DropdownMenuContent: ({ children }: any) => ReactLocal.createElement('div', null, children),
    DropdownMenuSubContent: ({ children }: any) => ReactLocal.createElement('div', null, children),
    DropdownMenuLabel: ({ children }: any) => ReactLocal.createElement('div', null, children),
    DropdownMenuSeparator: () => null,
    DropdownMenuSubTrigger: ({ children }: any) => ReactLocal.createElement('div', null, children),
    DropdownMenuItem: ({ children, onClick, disabled }: any) =>
      ReactLocal.createElement('button', { onClick, disabled }, children),
  };
});

jest.mock('@/components/ui/command', () => {
  const ReactLocal = require('react');
  const div = ({ children }: any) => ReactLocal.createElement('div', null, children);
  return {
    Command: div,
    CommandList: div,
    CommandGroup: div,
    CommandInput: (props: any) => ReactLocal.createElement('input', props),
    CommandSeparator: () => null,
    CommandItem: ({ children, onSelect }: any) =>
      ReactLocal.createElement('button', { onClick: () => onSelect && onSelect() }, children),
  };
});

jest.mock('@/components/ui/popover', () => {
  const ReactLocal = require('react');
  const frag = ({ children }: any) => ReactLocal.createElement(ReactLocal.Fragment, null, children);
  return {
    Popover: frag,
    PopoverTrigger: frag,
    PopoverContent: ({ children }: any) => ReactLocal.createElement('div', null, children),
  };
});

jest.mock('@/components/ui/dialog', () => {
  const ReactLocal = require('react');
  const div = ({ children }: any) => ReactLocal.createElement('div', null, children);
  return {
    Dialog: ({ open, children }: any) => (open ? div({ children }) : null),
    DialogContent: div,
    DialogDescription: div,
    DialogFooter: div,
    DialogHeader: div,
    DialogTitle: div,
  };
});

import { buildUserColumns, type UserRow } from '../user-table-columns';

(globalThis as any).React = React;

const DAY = 24 * 60 * 60 * 1000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const dateLabel = (isoStr: string) => {
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const CATALOG_OPTIONS = [{ key: 'chapter_secretary', label: 'Chapter Secretary' }];
const CUSTOM_BY_CHAPTER = {
  'seds-ist-chapter': [{ key: 'custom_poster_team_lead', label: 'Poster Team Lead (Custom)' }],
};

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    uid: 'uid-1',
    displayName: 'Test Person',
    email: 'person@example.com',
    role: 'custom_poster_team_lead',
    chapterId: 'seds-ist-chapter',
    roleExpiresAt: null,
    ...overrides,
  };
}

function renderRoleCell(user: UserRow) {
  const columns = buildUserColumns(CATALOG_OPTIONS, jest.fn(async () => {}), jest.fn(async () => {}), CUSTOM_BY_CHAPTER);
  const roleCol: any = columns.find((c: any) => c.accessorKey === 'role');
  const row: any = {
    getValue: (key: string) => (user as any)[key],
    original: user,
  };
  return render(<>{roleCol.cell({ row })}</>);
}

function renderActionsCell(user: UserRow, onChangeRole: jest.Mock) {
  const columns = buildUserColumns(CATALOG_OPTIONS, onChangeRole, jest.fn(async () => {}), CUSTOM_BY_CHAPTER);
  const actionsCol: any = columns.find((c: any) => c.id === 'actions');
  const row: any = { original: user };
  return render(<>{actionsCol.cell({ row })}</>);
}

beforeEach(() => {
  inspectorPropsLog.length = 0;
});

describe('users table role cell expiry badge (plan 5.3)', () => {
  it('renders nothing when roleExpiresAt is null', () => {
    const { container } = renderRoleCell(makeUser({ roleExpiresAt: null }));
    expect(container.textContent).not.toMatch(/Expires|Expired/);
  });

  it('renders a muted "Expires {date}" badge for a distant expiry', () => {
    const at = iso(90 * DAY);
    renderRoleCell(makeUser({ roleExpiresAt: at }));
    const badge = screen.getByText(`Expires ${dateLabel(at)}`);
    expect(badge.className).toContain('text-muted-foreground');
  });

  it('renders the day count inside 30 days and inside 7 days', () => {
    const at30 = iso(10 * DAY);
    const first = renderRoleCell(makeUser({ roleExpiresAt: at30 }));
    expect(screen.getByText(new RegExp(`Expires in 10d · ${dateLabel(at30)}`))).toBeInTheDocument();
    first.unmount();

    const at7 = iso(3 * DAY);
    renderRoleCell(makeUser({ roleExpiresAt: at7 }));
    const badge = screen.getByText(new RegExp(`Expires in 3d · ${dateLabel(at7)}`));
    expect(badge.className).toContain('text-destructive-text');
  });

  it('renders an honest "Expired {date}" badge for a past expiry', () => {
    const at = iso(-2 * DAY);
    renderRoleCell(makeUser({ roleExpiresAt: at }));
    expect(screen.getByText(`Expired ${dateLabel(at)}`)).toBeInTheDocument();
  });
});

describe('users table quick Change Role routing (plan 4.4)', () => {
  it('assigns a catalog pick immediately through onChangeRole', () => {
    const onChangeRole = jest.fn(async () => {});
    renderActionsCell(makeUser(), onChangeRole);
    fireEvent.click(screen.getByRole('button', { name: /Chapter Secretary/ }));
    expect(onChangeRole).toHaveBeenCalledTimes(1);
    expect(onChangeRole).toHaveBeenCalledWith('uid-1', 'chapter_secretary');
    expect(screen.queryByTestId('inspector-stub')).toBeNull();
  });

  it('routes a custom pick into the inspector preselected instead of assigning', () => {
    const onChangeRole = jest.fn(async () => {});
    renderActionsCell(makeUser(), onChangeRole);
    fireEvent.click(screen.getByRole('button', { name: /Poster Team Lead \(Custom\)/ }));
    expect(onChangeRole).not.toHaveBeenCalled();
    const stub = screen.getByTestId('inspector-stub');
    expect(stub).toBeInTheDocument();
    expect(stub.getAttribute('data-initial-role')).toBe('custom_poster_team_lead');
    const lastProps = inspectorPropsLog[inspectorPropsLog.length - 1];
    expect(lastProps.open).toBe(true);
    expect(lastProps.initialRole).toBe('custom_poster_team_lead');
    // The row's own grant expiry and role catalogue reach the inspector.
    expect(lastProps.currentExpiresAt).toBeNull();
    expect(lastProps.roleOptions.map((o: any) => o.key)).toContain('custom_poster_team_lead');
  });
});
