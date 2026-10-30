/**
 * Directory zero-records fix, REQ 1 (rendering half): the table
 * surface already accepts an errorMessage prop but never rendered
 * it, so a failed load settled into the "No Users Match Criteria"
 * empty state - visually identical to a genuinely empty directory
 * (the 2026-10-30 incident's settled symptom). With an errorMessage
 * the surface must render a distinct LOAD-FAILED panel with a Retry
 * action instead of the empty state; without one, the classic empty
 * state is unchanged.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { VirtualizedUserTable } from '@/components/admin/users/virtualized-user-table';

(globalThis as Record<string, unknown>).React = React;

jest.mock('@/components/privacy/masked-contact', () => ({
  MaskedContact: () => null,
}));

const COLUMNS = [
  { id: 'displayName', accessorKey: 'displayName', header: 'Name' },
] as any[];

function baseProps(overrides: Record<string, any> = {}) {
  return {
    rows: [],
    columns: COLUMNS,
    loading: false,
    search: '',
    roleFilter: '',
    roleOptions: [],
    chapterFilter: '',
    chapters: [],
    onSearch: jest.fn(),
    handleRoleFilterChange: jest.fn(),
    handleChapterFilterChange: jest.fn(),
    handleClear: jest.fn(),
    handleRoleChange: jest.fn(),
    ...overrides,
  };
}

describe('VirtualizedUserTable load-failed rendering (REQ 1)', () => {
  it('errorMessage + zero rows: renders the LOAD-FAILED panel with Retry, never the empty state', () => {
    const onRetry = jest.fn();
    render(
      <VirtualizedUserTable
        {...baseProps({ errorMessage: 'Failed to load users: Internal server error', onRetry })}
      />,
    );

    const panel = screen.getByTestId('directory-load-failed');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toMatch(/failed to load/i);
    expect(screen.queryByText('No Users Match Criteria')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('no errorMessage + zero rows (control): the classic empty state is unchanged', () => {
    render(<VirtualizedUserTable {...baseProps()} />);
    expect(screen.getByText('No Users Match Criteria')).toBeTruthy();
    expect(screen.queryByTestId('directory-load-failed')).toBeNull();
  });

  it('errorMessage + rows present: rows keep rendering, no failed panel replaces them', () => {
    const rows = [
      { uid: 'u-1', displayName: 'Person One', email: 'one@example.com', whatsapp: '', role: 'member_basic', chapterId: null, isBanned: false },
    ] as any[];
    render(<VirtualizedUserTable {...baseProps({ rows, errorMessage: 'Failed to load users: boom', onRetry: jest.fn() })} />);
    expect(screen.queryByTestId('directory-load-failed')).toBeNull();
    expect(screen.getByText(/Showing/)).toBeTruthy();
  });
});
