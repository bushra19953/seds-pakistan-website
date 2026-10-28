/**
 * Shared StatusBadge / normalize layer.
 *
 * Regression pinned here: the applications domain stores its decision as
 * 'approved' (see ApplicationListItem in
 * src/components/admin/applications/application-list.tsx), but the badge
 * only knew 'accepted', so normalizeStatus('approved') fell through to
 * the 'pending' default and every approved application rendered a
 * "Pending" badge on /admin/applications. 'approved' is now a
 * first-class status; these tests keep it that way and pin the rest of
 * the application-domain vocabulary to its own labels.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  STATUS_CONFIG,
  StatusBadge,
  getAllStatusTypes,
  getStatusConfig,
  isValidStatus,
} from '@/components/ui/status-badge';

describe("'approved' is a first-class status", () => {
  it('resolves to the "Approved" label, not the pending config', () => {
    const config = getStatusConfig('approved');
    expect(config.label).toBe('Approved');
    expect(config).not.toBe(STATUS_CONFIG.pending);
    expect(config.label).not.toBe(STATUS_CONFIG.pending.label);
    expect(config.bg).not.toBe(STATUS_CONFIG.pending.bg);
  });

  it("reuses the 'accepted' entry's colors and icon", () => {
    const approved = getStatusConfig('approved');
    const accepted = getStatusConfig('accepted');
    expect(approved.bg).toBe(accepted.bg);
    expect(approved.text).toBe(accepted.text);
    expect(approved.border).toBe(accepted.border);
    // Both entries name the same CheckCircle2 import in status-badge.tsx.
    // Identity (toBe) cannot be asserted under jest: jest.setup.js stubs
    // lucide-react with a Proxy that returns a fresh component per access,
    // so compare serializations instead.
    expect(approved.icon).toBeTruthy();
    expect(String(approved.icon)).toBe(String(accepted.icon));
    expect(approved.description).toBe('Application has been approved');
  });

  it('is valid and enumerable like every other status', () => {
    expect(isValidStatus('approved')).toBe(true);
    expect(getAllStatusTypes()).toContain('approved');
    expect(STATUS_CONFIG.approved.label).toBe('Approved');
  });

  it('renders an "Approved" badge (and not "Pending")', () => {
    render(<StatusBadge status="approved" showTooltip={false} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('normalizes case before resolving', () => {
    expect(getStatusConfig('Approved').label).toBe('Approved');
    expect(getStatusConfig('APPROVED').label).toBe('Approved');
  });
});

describe("'accepted' renders exactly as before", () => {
  it('keeps its label, description, and styling', () => {
    const accepted = getStatusConfig('accepted');
    expect(accepted.label).toBe('Accepted');
    expect(accepted.description).toBe('Application has been approved');

    render(<StatusBadge status="accepted" showTooltip={false} />);
    expect(screen.getByText('Accepted')).toBeTruthy();
  });
});

describe('every application-domain status renders its own label', () => {
  const cases: [string, string][] = [
    ['pending', 'Pending'],
    ['under_review', 'Under Review'],
    ['shortlisted', 'Shortlisted'],
    ['on_hold', 'On Hold'],
    ['rejected', 'Rejected'],
    ['approved', 'Approved'],
  ];

  it.each(cases)('getStatusConfig(%s).label === %s', (status, label) => {
    expect(getStatusConfig(status).label).toBe(label);
  });

  it.each(cases)('StatusBadge renders %s as "%s"', (status, label) => {
    render(<StatusBadge status={status} showTooltip={false} />);
    expect(screen.getByText(label)).toBeTruthy();
  });
});

describe('unknown statuses still fall back gracefully', () => {
  it('renders the default badge instead of throwing', () => {
    expect(() =>
      render(<StatusBadge status="totally-unknown-xyz" showTooltip={false} />),
    ).not.toThrow();
    // Documented normalizeStatus default: unknown values render as pending.
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('getStatusConfig does not throw for junk input', () => {
    expect(() => getStatusConfig('totally-unknown-xyz')).not.toThrow();
    expect(getStatusConfig('totally-unknown-xyz').label).toBe('Pending');
  });
});
