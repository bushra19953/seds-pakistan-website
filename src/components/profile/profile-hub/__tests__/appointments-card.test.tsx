/**
 * Suite G UI: AppointmentsCard (spec G.7.2/G.9).
 * Renders nothing without instruments; with one, shows the role, the
 * plain-words ratification line, and the acceptance status with the
 * standing wording ("acceptance outstanding", never "not yet in
 * office"). A rejection note is shown verbatim.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { AppointmentsCard } from '@/components/profile/profile-hub/appointments-card';

jest.mock('@/firebase', () => ({
  useUser: () => ({
    user: { uid: 'appointee-uid', getIdToken: async () => 'tok' },
  }),
}));
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

const fetchMock = jest.fn();

function minePayload(instruments: unknown[]) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ instruments }),
  });
}

const INSTRUMENT = {
  id: 'inst-1',
  roleDisplayName: 'National Treasurer',
  roleKey: 'national_treasurer',
  chapterId: null,
  effectiveFrom: '2026-10-01T04:00:00.000Z',
  appointedAt: '2026-10-01T04:00:00.000Z',
  letterIssued: true,
  letterStatus: 'issued',
  verificationCode: 'SEDS-PK-APT-ABC23',
  ratificationState: 'pending_ratification',
  ratificationLine: 'Pending ratification until 31 October 2026',
  acceptanceStatus: 'awaiting_upload',
  acceptanceCheckNote: null,
};

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('AppointmentsCard', () => {
  it('renders nothing when the member has no instruments', async () => {
    fetchMock.mockImplementation(() => minePayload([]));
    const { container } = render(<AppointmentsCard uid="appointee-uid" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.firstChild).toBeNull();
  });

  it('shows role, ratification line and acceptance outstanding wording', async () => {
    fetchMock.mockImplementation(() => minePayload([INSTRUMENT]));
    render(<AppointmentsCard uid="appointee-uid" />);
    expect(await screen.findByText('National Treasurer')).toBeTruthy();
    expect(
      screen.getByText('Pending ratification until 31 October 2026'),
    ).toBeTruthy();
    expect(screen.getByText('Acceptance outstanding')).toBeTruthy();
    expect(screen.queryByText(/not yet in office/i)).toBeNull();
    expect(screen.getByText('Download letter')).toBeTruthy();
    expect(screen.getByText('Submit signed acceptance')).toBeTruthy();
  });

  it('shows a rejection note verbatim with the upload open again', async () => {
    fetchMock.mockImplementation(() =>
      minePayload([
        {
          ...INSTRUMENT,
          acceptanceStatus: 'rejected',
          acceptanceCheckNote: 'Signature page is illegible; rescan.',
        },
      ]),
    );
    render(<AppointmentsCard uid="appointee-uid" />);
    expect(await screen.findByText(/Signature page is illegible/)).toBeTruthy();
    expect(screen.getByText('Acceptance rejected')).toBeTruthy();
    expect(screen.getByText('Submit signed acceptance')).toBeTruthy();
  });

  it('hides the upload once the acceptance is filed', async () => {
    fetchMock.mockImplementation(() =>
      minePayload([{ ...INSTRUMENT, acceptanceStatus: 'accepted' }]),
    );
    render(<AppointmentsCard uid="appointee-uid" />);
    expect(await screen.findByText('Acceptance filed')).toBeTruthy();
    expect(screen.queryByText('Submit signed acceptance')).toBeNull();
  });
});
