/**
 * /auth/login and /auth/signup are thin forwarders to the unified
 * /auth page. They used to forward callbackUrl / redirect params
 * verbatim; they now forward them only when the shared validator
 * (src/lib/safe-redirect.ts) accepts them, so an unsafe value cannot
 * be laundered through this hop (audit 2026-10-28, item 19). The
 * /auth form validates again before navigating anywhere.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
let mockQuery = '';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockQuery),
}));

// Classic JSX runtime under jest: the pages do not import React
// (Next's automatic runtime covers production), so expose it globally.
(globalThis as any).React = React;

import LoginPage from '../login/page';
import SignupPage from '../signup/page';

describe.each([
  ['login', LoginPage],
  ['signup', SignupPage],
])('/auth/%s forwarder', (_name, Page) => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockQuery = '';
  });

  it('forwards a legitimate callbackUrl to /auth', async () => {
    mockQuery = 'callbackUrl=' + encodeURIComponent('/dashboard');
    render(<Page />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith(
      '/auth?callbackUrl=%2Fdashboard',
    );
  });

  it('drops a protocol-relative callbackUrl instead of forwarding it', async () => {
    mockQuery = 'callbackUrl=' + encodeURIComponent('//evil.com');
    render(<Page />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith('/auth');
  });

  it('drops an absolute-URL redirect param instead of forwarding it', async () => {
    mockQuery = 'redirect=' + encodeURIComponent('https://evil.com');
    render(<Page />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith('/auth');
  });

  it('still forwards the invite param untouched', async () => {
    mockQuery = 'invite=tok123&callbackUrl=' + encodeURIComponent('//evil.com');
    render(<Page />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith('/auth?invite=tok123');
  });
});
