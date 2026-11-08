/**
 * TelemetryCards (design/dashboard pass): the Overview stat row keeps
 * every label and value string from the pre-design version, renders the
 * completion stat as an accessible progress ring, and mirrors the same
 * layout in the no-data state.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { TelemetryCards } from '@/components/profile/profile-hub/telemetry-cards';
import type { Telemetry } from '@/lib/profile-hub/telemetry';

const TELEMETRY: Telemetry = {
  tasksAssigned: 8,
  tasksCompleted: 6,
  onTimeRate: 0.75,
  onTimeCount: 3,
  lateCount: 1,
  loggedHours: 12,
  totalPoints: 340,
  penaltiesApplied: 20,
  qualityIndex: 82,
  qualityIndexBasis: 'derived',
};

describe('TelemetryCards', () => {
  it('shows all stats with the frozen labels and values', () => {
    render(<TelemetryCards telemetry={TELEMETRY} />);
    expect(screen.getByText('Tasks completed')).toBeTruthy();
    expect(screen.getByText('6 of 8 assigned')).toBeTruthy();
    expect(screen.getByText('On-time rate')).toBeTruthy();
    // '75%' appears twice by design: the ring centre (6 of 8 completed)
    // and the On-time rate value (0.75) coincide in this fixture.
    expect(screen.getAllByText('75%')).toHaveLength(2);
    expect(screen.getByText('3 on time, 1 late')).toBeTruthy();
    expect(screen.getByText('Hours logged')).toBeTruthy();
    expect(screen.getByText('12h')).toBeTruthy();
    expect(screen.getByText('Quality index')).toBeTruthy();
    expect(screen.getByText('82/100')).toBeTruthy();
    expect(screen.getByText('Derived from on-time and completion rates')).toBeTruthy();
    expect(screen.getByText('340 points')).toBeTruthy();
    expect(screen.getByText('Earned across all missions')).toBeTruthy();
    expect(screen.getByText('20 pts deducted')).toBeTruthy();
    expect(screen.getByText('Late and penalty deductions')).toBeTruthy();
  });

  it('renders completion as a progressbar ring at 75%', () => {
    render(<TelemetryCards telemetry={TELEMETRY} />);
    const ring = screen.getByRole('progressbar', { name: 'Tasks completed' });
    expect(ring.getAttribute('aria-valuenow')).toBe('75');
    expect(ring.getAttribute('aria-valuemin')).toBe('0');
    expect(ring.getAttribute('aria-valuemax')).toBe('100');
  });

  it('mirrors the layout with No data yet when telemetry is null', () => {
    render(<TelemetryCards telemetry={null} />);
    expect(screen.getByText('Tasks completed')).toBeTruthy();
    expect(screen.getByText('On-time rate')).toBeTruthy();
    expect(screen.getByText('Hours logged')).toBeTruthy();
    expect(screen.getByText('Quality index')).toBeTruthy();
    expect(screen.getAllByText('No data yet')).toHaveLength(4);
    const ring = screen.getByRole('progressbar', { name: 'Tasks completed' });
    expect(ring.getAttribute('aria-valuenow')).toBe('0');
  });
});
