/**
 * Suite G UI: public verification page (spec G.7.3).
 * Renders the API summary (incl. refusal wording and the integrity
 * failure line) and the fixed not-found message.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import VerifyAppointmentPage from '@/app/verify-appointment/[code]/page';

jest.mock('next/navigation', () => ({
  useParams: () => ({ code: 'SEDS-PK-APT-ABC23' }),
}));

const fetchMock = jest.fn();

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('VerifyAppointmentPage', () => {
  it('renders the summary for a current letter', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        found: true,
        instrumentNumber: 'APT-inst-1',
        appointeeName: 'Ayesha Khan',
        roleDisplayName: 'National Treasurer',
        appointedByName: 'Muhammad Zubair Mongol',
        appointedByOffice: 'Founder',
        effectiveFrom: '2026-10-01T04:00:00.000Z',
        ratificationLine: 'Ratified',
        acceptanceFiled: true,
        letterStatus: 'Current',
        integrity: { status: 'passed', line: 'Record integrity check passed.' },
      }),
    );
    render(<VerifyAppointmentPage />);
    expect(await screen.findByText('Ayesha Khan')).toBeTruthy();
    expect(screen.getByText('National Treasurer')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Record integrity check passed.')).toBeTruthy();
  });

  it('renders the refusal wording for a refused appointment', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        found: true,
        instrumentNumber: 'APT-inst-1',
        appointeeName: 'Ayesha Khan',
        roleDisplayName: 'National Treasurer',
        appointedByName: 'Muhammad Zubair Mongol',
        appointedByOffice: 'Founder',
        effectiveFrom: '2026-10-01T04:00:00.000Z',
        ratificationLine:
          'Appointment refused ratification on 15 November 2026; acts before that date remain valid',
        acceptanceFiled: false,
        letterStatus: 'Current',
        integrity: { status: 'passed', line: null },
      }),
    );
    render(<VerifyAppointmentPage />);
    // The line appears in the status badge and the Ratification row.
    const matches = await screen.findAllByText(
      /refused ratification on 15 November 2026/,
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the integrity failure line verbatim', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        found: true,
        instrumentNumber: 'APT-inst-1',
        appointeeName: 'Ayesha Khan',
        roleDisplayName: 'National Treasurer',
        appointedByName: 'Muhammad Zubair Mongol',
        appointedByOffice: 'Founder',
        effectiveFrom: '2026-10-01T04:00:00.000Z',
        ratificationLine: 'Ratified',
        acceptanceFiled: true,
        letterStatus: 'Current',
        integrity: { status: 'failed', line: 'x' },
      }),
    );
    render(<VerifyAppointmentPage />);
    expect(
      await screen.findByText(
        'Record integrity check failed - contact the General Secretary.',
      ),
    ).toBeTruthy();
  });

  it('shows the fixed not-found message', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ found: false, message: 'No appointment letter found for this code.' }, false),
    );
    render(<VerifyAppointmentPage />);
    expect(
      await screen.findByText('No appointment letter found for this code.'),
    ).toBeTruthy();
  });
});
