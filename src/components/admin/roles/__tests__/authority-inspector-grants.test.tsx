/**
 * MSG40 — Authority Inspector custom-grant list + Remove.
 *
 * The inspector showed only the member's base role (plus one custom
 * title and one expiry stamp). It must now also list the member's
 * custom-role grants — title + role key each — with a Remove action
 * per grant, driven by the same mandatory-justification rule as every
 * other action in this dialog.
 *
 * Mocks mirror authority-inspector-expiry.test.tsx (native-select
 * double for Radix Select, toDatetimeLocal double for the heavy
 * task-form, real Radix Dialog). New props under test: `grants`
 * (null = still loading, [] = none held) and `onRemoveGrant`.
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
import { toGrantListItems } from '../grant-expiry';

(globalThis as any).React = React;

const ROLE_OPTIONS = [
  { key: 'member', label: 'Member' },
  { key: 'chapter_secretary', label: 'Chapter Secretary' },
  { key: 'custom_deputy_a', label: 'Deputy A (Custom)' },
  { key: 'custom_deputy_b', label: 'Deputy B (Custom)' },
];

const GRANTS = [
  { key: 'custom_deputy_a', title: 'Chapter VP Deputy - Technical Systems' },
  { key: 'custom_deputy_b', title: 'Chapter VP Deputy - Outreach' },
];

const JUSTIFICATION = 'Founder-ordered deputy strip, November 2026 review.';

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

function fillJustification(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/Why is this authority level being changed/), {
    target: { value },
  });
}

function removeButtons() {
  return screen.queryAllByRole('button', { name: /Remove grant / });
}

describe('AuthorityInspector custom-grant list (MSG40)', () => {
  it('lists each grant title + role key with a Remove action', () => {
    renderOpen({ grants: GRANTS, onRemoveGrant: jest.fn(async () => {}) });
    expect(screen.getByText('Chapter VP Deputy - Technical Systems')).toBeInTheDocument();
    expect(screen.getByText('custom_deputy_a')).toBeInTheDocument();
    expect(screen.getByText('Chapter VP Deputy - Outreach')).toBeInTheDocument();
    expect(screen.getByText('custom_deputy_b')).toBeInTheDocument();
    expect(removeButtons()).toHaveLength(2);
  });

  it('shows an honest empty line when no custom grants are held', () => {
    renderOpen({ grants: [], onRemoveGrant: jest.fn(async () => {}) });
    expect(screen.getByText('No custom grants held.')).toBeInTheDocument();
    expect(removeButtons()).toHaveLength(0);
  });

  it('shows a loading line, not an empty line, while grants are unknown', () => {
    renderOpen({ grants: null, onRemoveGrant: jest.fn(async () => {}) });
    expect(screen.getByText('Loading custom grants…')).toBeInTheDocument();
    expect(screen.queryByText('No custom grants held.')).toBeNull();
    expect(removeButtons()).toHaveLength(0);
  });

  it('Remove is disabled until the mandatory justification reaches 10 chars', () => {
    renderOpen({ grants: GRANTS, onRemoveGrant: jest.fn(async () => {}) });
    const button = screen.getByRole('button', { name: 'Remove grant custom_deputy_a' });
    expect(button).toBeDisabled();
    fillJustification('short');
    expect(button).toBeDisabled();
    fillJustification(JUSTIFICATION);
    expect(button).not.toBeDisabled();
  });

  it('Remove calls onRemoveGrant with the grant slug and the justification', async () => {
    const onRemoveGrant = jest.fn(async () => {});
    renderOpen({ grants: GRANTS, onRemoveGrant });
    fillJustification(JUSTIFICATION);
    fireEvent.click(screen.getByRole('button', { name: 'Remove grant custom_deputy_a' }));
    await waitFor(() => {
      expect(onRemoveGrant).toHaveBeenCalledWith('custom_deputy_a', JUSTIFICATION);
    });
    expect(onRemoveGrant).toHaveBeenCalledTimes(1);
  });

  it('renders no Remove buttons when the caller supplies no removal handler', () => {
    renderOpen({ grants: GRANTS });
    expect(removeButtons()).toHaveLength(0);
  });
});

describe('toGrantListItems (MSG40 mapping)', () => {
  const OPTIONS = [
    { key: 'member', label: 'Member (member)' },
    { key: 'custom_deputy_a', label: 'Chapter VP Deputy - Technical Systems (custom_deputy_a)' },
    { key: 'custom_deputy_b', label: 'Deputy B (custom_deputy_b)' },
  ];

  it('maps slugs to definition titles + keys, stripping the label suffix', () => {
    expect(toGrantListItems(['custom_deputy_a', 'custom_deputy_b'], OPTIONS, 'member')).toEqual([
      { key: 'custom_deputy_a', title: 'Chapter VP Deputy - Technical Systems' },
      { key: 'custom_deputy_b', title: 'Deputy B' },
    ]);
  });

  it('keeps an orphan grant listed with its slug as the title', () => {
    expect(toGrantListItems(['custom_orphan_x'], OPTIONS, 'member')).toEqual([
      { key: 'custom_orphan_x', title: 'custom_orphan_x' },
    ]);
  });

  it('drops non-custom slugs, duplicates, and the base-role slug (chart parity)', () => {
    expect(
      toGrantListItems(
        ['custom_deputy_a', 'chapter_events_chair', 'custom_deputy_a', 'member'],
        OPTIONS,
        'member',
      ),
    ).toEqual([{ key: 'custom_deputy_a', title: 'Chapter VP Deputy - Technical Systems' }]);
  });
});
