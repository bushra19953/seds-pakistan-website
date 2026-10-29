/**
 * StatusBadge vocabulary pins for the applications domain.
 *
 * Regression: the applications list on /admin/applications renders each
 * row's canonical stored status through StatusBadge. The canonical
 * approved value is 'approved' (the stored status, the API filter value
 * and the admin counts all use it), but STATUS_CONFIG only knew the
 * concept as 'accepted', so normalizeStatus('approved') fell through to
 * its 'pending' default and every approved application rendered a
 * "Pending" badge (observed live: 63 approved rows badged Pending while
 * the filter counts were correct). These tests pin the badge labels to
 * the canonical status values exactly as GET /api/admin/applications
 * serves them.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { StatusBadge, getStatusConfig, isValidStatus } from '@/components/ui/status-badge';

// The applications status vocabulary, canonical values as served by the
// API (and stored in the application documents).
const APPLICATION_CASES: [string, string][] = [
  ['pending', 'Pending'],
  ['under_review', 'Under Review'],
  ['shortlisted', 'Shortlisted'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['on_hold', 'On Hold'],
];

describe('StatusBadge — applications canonical statuses', () => {
  it('renders the correct label for every canonical application status', () => {
    for (const [status, label] of APPLICATION_CASES) {
      const { unmount } = render(<StatusBadge status={status} showTooltip={false} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('approved renders "Approved", never the pending fallback (regression)', () => {
    render(<StatusBadge status="approved" showTooltip={false} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('pending and rejected still render their own labels', () => {
    const { unmount } = render(<StatusBadge status="pending" showTooltip={false} />);
    expect(screen.getByText('Pending')).toBeTruthy();
    unmount();
    render(<StatusBadge status="rejected" showTooltip={false} />);
    expect(screen.getByText('Rejected')).toBeTruthy();
  });

  it('the config layer resolves the canonical values directly', () => {
    for (const [status, label] of APPLICATION_CASES) {
      expect(getStatusConfig(status).label).toBe(label);
      expect(isValidStatus(status)).toBe(true);
    }
  });

  it('pre-existing vocabulary is unchanged (accepted, completed)', () => {
    const { unmount } = render(<StatusBadge status="accepted" showTooltip={false} />);
    expect(screen.getByText('Accepted')).toBeTruthy();
    unmount();
    render(<StatusBadge status="completed" showTooltip={false} />);
    expect(screen.getByText('Completed')).toBeTruthy();
  });
});
