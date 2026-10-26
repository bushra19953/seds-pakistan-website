/**
 * Consent picker tests (spec B.7 UI cases).
 */

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: { getIdToken: async () => 'token-1' }, role: null, isLoading: false }),
}));

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConsentRequestPicker } from '@/components/admin/governance/consent-request-picker';
import type { ConsentSubjectRef } from '@/lib/server/consent-gate-types';

const SUBJECT: ConsentSubjectRef = {
  type: 'user_role',
  targetUid: 'user-1',
  roleKey: 'president_national',
  action: 'appoint',
};

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

function mockFetch(payload: unknown, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: async () => payload,
  }) as never;
}

function renderPicker(onChange = jest.fn()) {
  render(
    <ConsentRequestPicker
      matterKey="catb_officer"
      subjectRef={SUBJECT}
      value={null}
      onChange={onChange}
    />,
  );
  return onChange;
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('lists only decided requests (pending and refused are filtered out)', async () => {
  mockFetch({
    requests: [
      { id: 'cr-1', requestNumber: 'FC-2026-0001', status: 'consented', expiresAt: FUTURE },
      { id: 'cr-2', requestNumber: 'FC-2026-0002', status: 'pending' },
      { id: 'cr-3', requestNumber: 'FC-2026-0003', status: 'refused' },
      { id: 'cr-4', requestNumber: 'FC-2026-0004', status: 'deemed_withheld' },
    ],
  });
  renderPicker();
  const select = await screen.findByLabelText('Decided consent request');
  await waitFor(() =>
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toContain('cr-1'),
  );
  const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
  expect(values).not.toContain('cr-2');
  expect(values).not.toContain('cr-3');
  expect(values).not.toContain('cr-4');
});

it('disables expired options with an Expired marker', async () => {
  mockFetch({
    requests: [
      { id: 'cr-1', requestNumber: 'FC-2026-0001', status: 'consented', expiresAt: PAST },
    ],
  });
  renderPicker();
  const option = (await screen.findByText(/Expired/)) as HTMLOptionElement;
  expect(option.disabled).toBe(true);
});

it('disables conditional options whose conditions are unconfirmed', async () => {
  mockFetch({
    requests: [
      {
        id: 'cr-1',
        requestNumber: 'FC-2026-0001',
        status: 'conditional',
        conditionsSatisfied: false,
        expiresAt: FUTURE,
      },
    ],
  });
  renderPicker();
  const option = (await screen.findByText(
    /Conditions not yet confirmed/,
  )) as HTMLOptionElement;
  expect(option.disabled).toBe(true);
});

it('empty state offers a file-request link carrying matter and subject', async () => {
  mockFetch({ requests: [] });
  renderPicker();
  expect(await screen.findByText('No decided consent for this act yet.')).toBeTruthy();
  const link = (await screen.findByText('File a consent request')) as HTMLAnchorElement;
  // The link must point at the route that exists (/admin/consents/new);
  // it previously pointed at /admin/governance/consents/new (404).
  expect(link.href).toContain('/admin/consents/new');
  expect(link.href).not.toContain('/admin/governance/consents/new');
  expect(link.href).toContain('matter=catb_officer');
  expect(link.href).toContain('subject=');
  expect(link.href).toContain('subjectType=user_role');
});

it('fetch failure renders the empty state without throwing', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;
  renderPicker();
  expect(await screen.findByText('No decided consent for this act yet.')).toBeTruthy();
});

it('selecting an option calls onChange with the request id', async () => {
  mockFetch({
    requests: [
      { id: 'cr-1', requestNumber: 'FC-2026-0001', status: 'consented', expiresAt: FUTURE },
    ],
  });
  const onChange = renderPicker();
  const select = await screen.findByLabelText('Decided consent request');
  await waitFor(() =>
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.value)).toContain('cr-1'),
  );
  fireEvent.change(select, { target: { value: 'cr-1' } });
  expect(onChange).toHaveBeenCalledWith('cr-1');
});
