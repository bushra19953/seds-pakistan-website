/**
 * Suite E5 case 22: IntakeCloseLine renders the shared formatter line
 * for the resolved state and renders nothing while loading
 * (Workstream E, spec 6.2/6.3). The hook is mocked; formatter wording
 * itself is covered by the date-utils/format suites.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { IntakeCloseLine } from '@/components/sections/intake-close-line';
import { useIntakeWindow } from '@/hooks/use-intake-window';

jest.mock('@/hooks/use-intake-window', () => ({
  useIntakeWindow: jest.fn(),
}));

const mockHook = useIntakeWindow as jest.Mock;

const BASE_WINDOW = {
  windowId: 'induction-2026-10-fall',
  label: 'Fall Induction',
  kind: 'induction' as const,
  opensAt: '2026-10-01T00:00:00.000Z',
  closesAt: '2026-10-22T18:59:59.000Z',
  isDefault: false,
  serverNow: '2026-10-21T10:00:00.000Z',
};

function hookResult(state: string, window: unknown) {
  return {
    window,
    state,
    loading: state === 'loading',
    error: false,
  };
}

beforeEach(() => {
  mockHook.mockReset();
});

describe('IntakeCloseLine', () => {
  it('renders the close line while open', () => {
    mockHook.mockReturnValue(
      hookResult('open', { ...BASE_WINDOW, state: 'open' }),
    );
    render(<IntakeCloseLine />);
    expect(screen.getByText(/^Applications close /)).toBeTruthy();
    expect(screen.getByText(/PKT\./)).toBeTruthy();
  });

  it('renders the open line while scheduled', () => {
    mockHook.mockReturnValue(
      hookResult('scheduled', { ...BASE_WINDOW, state: 'scheduled' }),
    );
    render(<IntakeCloseLine />);
    expect(screen.getByText(/^Applications open /)).toBeTruthy();
  });

  it('renders the closed line after close', () => {
    mockHook.mockReturnValue(
      hookResult('closed', { ...BASE_WINDOW, state: 'closed' }),
    );
    render(<IntakeCloseLine />);
    expect(screen.getByText(/^Applications closed on /)).toBeTruthy();
  });

  it('renders the neutral closed line when no window exists', () => {
    mockHook.mockReturnValue(hookResult('closed', null));
    render(<IntakeCloseLine />);
    expect(screen.getByText('Applications are now closed.')).toBeTruthy();
  });

  it('renders nothing while loading', () => {
    mockHook.mockReturnValue(hookResult('loading', null));
    const { container } = render(<IntakeCloseLine />);
    expect(container.firstChild).toBeNull();
  });
});
