/**
 * Item 7 (civic surfaces): AGM and election statuses render only as
 * human-readable badge labels, never as the raw stored token. The
 * status lists below mirror the ElectionStatus and AgmStatus unions in
 * src/types/elections.ts; the Record typing on the label maps makes a
 * missing label a compile error, and these tests pin the exact wording.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  AGM_STATUS_LABELS,
  AgmStatusBadge,
  ELECTION_STATUS_LABELS,
  ElectionStatusBadge,
  agmStatusLabel,
  electionStatusLabel,
} from '@/components/elections/status-badge';
import type { AgmStatus, ElectionStatus } from '@/types/elections';

const ELECTION_CASES: [ElectionStatus, string][] = [
  ['draft', 'Draft'],
  ['timetable_published', 'Timetable published'],
  ['nominations_open', 'Nominations open'],
  ['nominations_closed', 'Nominations closed'],
  ['candidates_certified', 'Candidates certified'],
  ['poll_open', 'Poll open'],
  ['poll_closed', 'Poll closed'],
  ['counting', 'Counting'],
  ['counted', 'Counted'],
  ['tie_pending', 'Tie pending'],
  ['declared', 'Result declared'],
  ['challenge_window', 'Challenge window'],
  ['closed', 'Closed'],
  ['cancelled', 'Cancelled'],
];

const AGM_CASES: [AgmStatus, string][] = [
  ['draft', 'Draft'],
  ['notice_due', 'Notice due'],
  ['notice_issued', 'Notice issued'],
  ['held', 'Held'],
  ['minutes_draft', 'Minutes in draft'],
  ['minutes_approved', 'Minutes approved'],
  ['closed', 'Closed'],
  ['cancelled', 'Cancelled'],
];

describe('election status labels', () => {
  it('covers every ElectionStatus value with the pinned label', () => {
    expect(Object.keys(ELECTION_STATUS_LABELS).sort()).toEqual(
      ELECTION_CASES.map(([s]) => s).sort(),
    );
    for (const [status, label] of ELECTION_CASES) {
      expect(electionStatusLabel(status)).toBe(label);
    }
  });

  it('badge renders the label, never the raw token', () => {
    for (const [status, label] of ELECTION_CASES) {
      const { unmount } = render(<ElectionStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      if (status !== label.toLowerCase()) {
        expect(screen.queryByText(status)).toBeNull();
      }
      unmount();
    }
  });
});

describe('AGM status labels', () => {
  it('covers every AgmStatus value with the pinned label', () => {
    expect(Object.keys(AGM_STATUS_LABELS).sort()).toEqual(
      AGM_CASES.map(([s]) => s).sort(),
    );
    for (const [status, label] of AGM_CASES) {
      expect(agmStatusLabel(status)).toBe(label);
    }
  });

  it('badge renders the label, never the raw token', () => {
    for (const [status, label] of AGM_CASES) {
      const { unmount } = render(<AgmStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      if (status !== label.toLowerCase()) {
        expect(screen.queryByText(status)).toBeNull();
      }
      unmount();
    }
  });
});

describe('unknown status fallback', () => {
  it('humanizes instead of leaking the raw token', () => {
    expect(electionStatusLabel('some_future_status')).toBe('Some future status');
    expect(agmStatusLabel('some_future_status')).toBe('Some future status');
    render(<ElectionStatusBadge status="some_future_status" />);
    expect(screen.getByText('Some future status')).toBeTruthy();
    expect(screen.queryByText('some_future_status')).toBeNull();
  });
});
