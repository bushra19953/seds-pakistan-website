/**
 * Welcome page callbackUrl handling (security audit 2026-10-28,
 * item 19): the page used to pass `searchParams.get('callbackUrl')`
 * RAW to router.push on both the submit and Skip paths — a signed-in
 * user landing on /welcome?callbackUrl=https://evil.com was sent
 * off-site on the first click. It now resolves the target through the
 * shared validator (src/lib/safe-redirect.ts) with '/profile' as the
 * fallback.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockQuery = '';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockQuery),
}));

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'user-1', email: 'member@example.com', displayName: 'Test Member' },
    isLoading: false,
  }),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  doc: () => ({}),
  serverTimestamp: () => 'ts',
  // Profile exists but is incomplete (no university/department), so the
  // page renders the form instead of bouncing to /profile.
  getDoc: jest.fn(async () => ({
    exists: () => true,
    data: () => ({}),
  })),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  updateDoc: jest.fn(async () => undefined),
}));

jest.mock('@/hooks/use-enhanced-toast', () => ({
  useEnhancedToast: () => ({ showToast: jest.fn() }),
}));

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}));

// The repo's jest tsconfig compiles JSX to the classic runtime, and
// the page does not import React (Next's automatic runtime covers
// production), so expose it globally for the compiled createElement
// calls.
(globalThis as any).React = React;

import WelcomePage from '../page';

async function renderAndSkip() {
  render(<WelcomePage />);
  const skip = await screen.findByText(/Skip for now/);
  fireEvent.click(skip);
  await waitFor(() => expect(mockPush).toHaveBeenCalled());
}

describe('WelcomePage callbackUrl validation', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockQuery = '';
  });

  it('sends an absolute-URL callbackUrl to the /profile fallback', async () => {
    mockQuery = 'callbackUrl=' + encodeURIComponent('https://evil.com');
    await renderAndSkip();
    expect(mockPush).toHaveBeenCalledWith('/profile');
  });

  it('sends a protocol-relative callbackUrl to the /profile fallback', async () => {
    mockQuery = 'callbackUrl=' + encodeURIComponent('//evil.com');
    await renderAndSkip();
    expect(mockPush).toHaveBeenCalledWith('/profile');
  });

  it('sends an encoded protocol-relative callbackUrl to the fallback', async () => {
    // URLSearchParams decodes %252f once, leaving %2f%2fevil.com for
    // the validator, whose own decode pass must still reject it.
    mockQuery = 'callbackUrl=' + encodeURIComponent('%2f%2fevil.com');
    await renderAndSkip();
    expect(mockPush).toHaveBeenCalledWith('/profile');
  });

  it('honours a legitimate internal callbackUrl', async () => {
    mockQuery =
      'callbackUrl=' + encodeURIComponent('/events/abc?action=checkout');
    await renderAndSkip();
    expect(mockPush).toHaveBeenCalledWith('/events/abc?action=checkout');
  });

  it('defaults to /profile when no callbackUrl is present', async () => {
    await renderAndSkip();
    expect(mockPush).toHaveBeenCalledWith('/profile');
  });
});
