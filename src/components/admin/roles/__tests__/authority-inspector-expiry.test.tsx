/**
 * Authority Inspector grant expiry (EXPIRY-UI plan 7.4, sections 4.3/4.4,
 * contracts 1.4 + 2.2):
 * - The ExpiryDateField mounts ONLY for a custom_ selection; catalog
 *   selections never see it and submit expiresAt as undefined, so the
 *   catalog write body stays identical to before this item.
 * - Selecting a custom role whose definition carries defaultTermDays
 *   prefills end-of-day(now + days) while the field is untouched.
 * - A cleared field submits explicit null (no expiry); a filled field
 *   submits its ISO instant. Both travel as the 4th onAssign argument.
 * - The header "Grant expiry" row renders only when currentExpiresAt
 *   is set, with the honest badge beside it when expiring or expired.
 * - The controlled-open seam: opening with initialRole preselects that
 *   role (the users-table quick menu routes custom picks here, 4.4).
 *
 * The Radix Select is replaced by a native-select double (selection is
 * the only behaviour under test); the Dialog is the real Radix one,
 * with the browser shims the role-registry suite uses.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/components/ui/select', () => {
  const ReactLocal = require('react');
  return {
    Select: ({ value, onValueChange, children }: any) =>
      ReactLocal.createElement(
        'select',
        {
          'data-testid': 'inspector-role-select',
          value: value ?? '',
          onChange: (e: any) => onValueChange(e.target.value),
        },
        children,
      ),
    SelectTrigger: ({ children }: any) => ReactLocal.createElement(ReactLocal.Fragment, null, children),
    SelectValue: ({ placeholder }: any) =>
      ReactLocal.createElement('option', { value: '' }, placeholder),
    SelectContent: ({ children }: any) => ReactLocal.createElement(ReactLocal.Fragment, null, children),
    SelectItem: ({ value, children, disabled }: any) =>
      ReactLocal.createElement('option', { value, disabled }, children),
  };
});

// The real task-form is a very heavy module; only its toDatetimeLocal
// helper is consumed here. This double reproduces that helper exactly
// (local wall-clock YYYY-MM-DDTHH:mm).
jest.mock('@/components/admin/tasks/task-form', () => ({
  toDatetimeLocal: (iso?: string): string => {
    if (!iso || typeof iso !== 'string') return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
}));

import AuthorityInspector from '../authority-inspector';

(globalThis as any).React = React;

const ROLE_OPTIONS = [
  { key: 'member', label: 'Member' },
  { key: 'chapter_secretary', label: 'Chapter Secretary' },
  { key: 'custom_poster_team_lead', label: 'Poster Team Lead (Custom)' },
  { key: 'custom_media_helper', label: 'Media Helper (Custom)' },
];

const JUSTIFICATION = 'Rotating the poster duty for the induction drive.';

function baseProps(overrides: Record<string, any> = {}) {
  return {
    userUid: 'uid-target-123456',
    userName: 'Target Person',
    currentRole: 'member',
    roleOptions: ROLE_OPTIONS,
    onAssign: jest.fn(async () => {}),
    onRevoke: jest.fn(async () => {}),
    onDepart: jest.fn(async () => {}),
    ...overrides,
  };
}

beforeAll(() => {
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

function renderOpen(props: Record<string, any> = {}) {
  const all = baseProps(props);
  const utils = render(<AuthorityInspector {...(all as any)} open={true} onOpenChange={() => {}} />);
  return { ...utils, props: all };
}

function selectRole(key: string) {
  fireEvent.change(screen.getByTestId('inspector-role-select'), { target: { value: key } });
}

function expiryInput() {
  return screen.queryByLabelText(/Grant expiry \(optional\)/) as HTMLInputElement | null;
}

async function fillJustificationAndConfirm() {
  fireEvent.change(screen.getByPlaceholderText(/Why is this authority level being changed/), {
    target: { value: JUSTIFICATION },
  });
  fireEvent.click(screen.getByRole('button', { name: /CONFIRM APPOINTMENT/ }));
}

describe('AuthorityInspector expiry field visibility (plan 4.3)', () => {
  it('shows no expiry field before any selection and none for a catalog selection', async () => {
    renderOpen();
    expect(expiryInput()).toBeNull();
    selectRole('chapter_secretary');
    expect(expiryInput()).toBeNull();
  });

  it('shows the wired datetime-local field for a custom selection', async () => {
    renderOpen();
    selectRole('custom_media_helper');
    const input = expiryInput();
    expect(input).not.toBeNull();
    expect(input!.id).toBe('inspector-grant-expiry');
    expect(input!.type).toBe('datetime-local');
  });
});

describe('AuthorityInspector default-term prefill (contracts 1.4)', () => {
  it('prefills end-of-day(now + defaultTermDays) for a custom role with a default', async () => {
    renderOpen({ customRoleDefaultTermDays: { custom_poster_team_lead: 90 } });
    selectRole('custom_poster_team_lead');
    const input = expiryInput();
    expect(input).not.toBeNull();
    const d = new Date();
    d.setDate(d.getDate() + 90);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:59`;
    expect(input!.value).toBe(expected);
    expect(screen.getByText(/Default term for this role: 90 days/)).toBeInTheDocument();
  });

  it('leaves the field empty for a custom role without a default term', async () => {
    renderOpen({ customRoleDefaultTermDays: { custom_poster_team_lead: 90 } });
    selectRole('custom_media_helper');
    expect(expiryInput()!.value).toBe('');
  });

  it('never overwrites an admin-edited value when the selection changes again', async () => {
    renderOpen({ customRoleDefaultTermDays: { custom_poster_team_lead: 90, custom_media_helper: 30 } });
    selectRole('custom_poster_team_lead');
    fireEvent.change(expiryInput()!, { target: { value: '2027-05-05T10:00' } });
    selectRole('custom_media_helper');
    expect(expiryInput()!.value).toBe('2027-05-05T10:00');
  });
});

describe('AuthorityInspector expiry submission (X11 three-way semantics)', () => {
  it('sends the ISO instant of a filled field as the 4th argument', async () => {
    const { props } = renderOpen();
    selectRole('custom_media_helper');
    fireEvent.change(expiryInput()!, { target: { value: '2027-03-01T09:30' } });
    await fillJustificationAndConfirm();
    await waitFor(() => expect(props.onAssign).toHaveBeenCalledTimes(1));
    expect(props.onAssign).toHaveBeenCalledWith(
      'custom_media_helper',
      JUSTIFICATION,
      undefined,
      new Date('2027-03-01T09:30').toISOString(),
    );
  });

  it('sends explicit null when the admin clears the prefilled field', async () => {
    const { props } = renderOpen({ customRoleDefaultTermDays: { custom_poster_team_lead: 90 } });
    selectRole('custom_poster_team_lead');
    expect(expiryInput()!.value).not.toBe('');
    fireEvent.change(expiryInput()!, { target: { value: '' } });
    await fillJustificationAndConfirm();
    await waitFor(() => expect(props.onAssign).toHaveBeenCalledTimes(1));
    expect(props.onAssign).toHaveBeenCalledWith(
      'custom_poster_team_lead',
      JUSTIFICATION,
      undefined,
      null,
    );
  });

  it('passes undefined expiry for a catalog selection', async () => {
    const { props } = renderOpen();
    selectRole('chapter_secretary');
    await fillJustificationAndConfirm();
    await waitFor(() => expect(props.onAssign).toHaveBeenCalledTimes(1));
    expect(props.onAssign).toHaveBeenCalledWith(
      'chapter_secretary',
      JUSTIFICATION,
      undefined,
      undefined,
    );
  });
});

describe('AuthorityInspector header grant expiry row (plan 4.3)', () => {
  it('renders the row with an honest Expired badge for a past expiry', async () => {
    renderOpen({ currentExpiresAt: '2026-01-15T00:00:00.000Z' });
    expect(screen.getByText(/Grant expiry:/)).toBeInTheDocument();
    expect(screen.getByText(/Expired 2026-01-15/)).toBeInTheDocument();
  });

  it('renders the row without a badge for a distant expiry', async () => {
    renderOpen({ currentExpiresAt: '2027-06-15T00:00:00.000Z' });
    expect(screen.getByText(/Grant expiry:/)).toBeInTheDocument();
    expect(screen.queryByText(/Expired/)).toBeNull();
    expect(screen.queryByText(/Expires in/)).toBeNull();
  });

  it('renders no row when the person holds no expiring grant', async () => {
    renderOpen({ currentExpiresAt: null });
    expect(screen.queryByText(/Grant expiry:/)).toBeNull();
  });
});

describe('AuthorityInspector controlled-open seam (plan 4.4)', () => {
  it('preselects initialRole when opened from the quick menu', async () => {
    const all = baseProps({ initialRole: 'custom_media_helper' });
    render(<AuthorityInspector {...(all as any)} />);
    fireEvent.click(screen.getByRole('button', { name: /AUTHORITY/ }));
    const input = await screen.findByLabelText(/Grant expiry \(optional\)/);
    expect(input).toBeInTheDocument();
    expect((screen.getByTestId('inspector-role-select') as HTMLSelectElement).value).toBe(
      'custom_media_helper',
    );
  });
});
