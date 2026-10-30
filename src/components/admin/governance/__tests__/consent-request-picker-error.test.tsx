/**
 * Picker load-error state (live defect, 2026-10-30): the picker used to
 * render ANY fetch failure as the empty state, so when the
 * decided-consents endpoint 500'd during the Firestore quota outage the
 * Create New Role form announced "No decided consent for this act yet."
 * while FC-2026-0054 sat decided on file. A failed load must render a
 * distinct error state with a retry; only a successful-but-empty
 * response may render the empty state.
 */

// A STABLE user object: the picker's load effect depends on `user`, so a
// fresh object per render (as in the older picker suite's mock) re-fires
// the fetch on every render and makes load-state assertions racy - the
// flakiness the consent fix report recorded for that suite. One identity
// here keeps each load exactly one fetch, plus one per Retry.
const mockUser = { getIdToken: async () => 'token-1' };
jest.mock('@/firebase', () => ({
  useUser: () => ({ user: mockUser, role: null, isLoading: false }),
}));

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConsentRequestPicker } from '@/components/admin/governance/consent-request-picker';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const SUBJECT: ConsentSubjectRef = {
  type: 'role_definition',
  slug: 'custom_president_s_executive_apprentice',
  action: 'create',
};

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function renderPicker() {
  render(
    <ConsentRequestPicker
      matterKey="role_catalog"
      subjectRef={SUBJECT}
      value={null}
      onChange={jest.fn()}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('renders the load-error state, not the empty state, when the fetch fails', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;
  renderPicker();
  expect(await screen.findByTestId('consent-picker-error')).toBeTruthy();
  expect(screen.queryByText('No decided consent for this act yet.')).toBeNull();
});

it('renders the load-error state when the endpoint answers 500', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Consent lookup failed' }),
  }) as never;
  renderPicker();
  expect(await screen.findByTestId('consent-picker-error')).toBeTruthy();
  expect(screen.queryByText('No decided consent for this act yet.')).toBeNull();
});

it('renders the empty state only for a successful empty response', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ requests: [] }),
  }) as never;
  renderPicker();
  expect(await screen.findByText('No decided consent for this act yet.')).toBeTruthy();
  expect(screen.queryByTestId('consent-picker-error')).toBeNull();
});

it('retry after a failure loads the decided consents', async () => {
  const fetchMock = jest
    .fn()
    .mockRejectedValueOnce(new Error('quota exhausted'))
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        requests: [
          { id: 'fc0054', requestNumber: 'FC-2026-0054', status: 'consented', expiresAt: FUTURE },
        ],
      }),
    });
  global.fetch = fetchMock as never;
  renderPicker();
  fireEvent.click(await screen.findByText('Retry'));
  const select = await screen.findByLabelText('Decided consent request');
  // The select re-renders in its loading shape before the retried fetch
  // resolves; wait for the option itself to land.
  await waitFor(() => {
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('fc0054');
  });
  expect(screen.queryByTestId('consent-picker-error')).toBeNull();
});
