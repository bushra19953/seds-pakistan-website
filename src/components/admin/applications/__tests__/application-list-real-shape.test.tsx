/**
 * ApplicationList against the API's REAL served row shape.
 *
 * Founder symptom (2026-10-29, verbatim): "pending walay ui me nazar ni
 * aa rhay" — the pending applications do not appear in the UI at all,
 * while the data holds 74 applications: 63 approved / 10 pending /
 * 1 rejected.
 *
 * The fixture (fixtures/applications-api-shape.json) is the live
 * GET /api/admin/applications payload captured the same day, sanitized
 * value-by-value (identifying strings neutralized; each row's exact key
 * set, value types, canonical `status` and ISO timestamps preserved).
 * Driving the real list component with it pins the founder's required
 * end state:
 *   All = 74 rows, Pending = 10, Approved = 63, Rejected = 1, and every
 *   row's badge text equals its canonical status label.
 * On the pre-badge-fix component this suite fails the badge counts
 * (approved rows render "Pending"); on a build that dropped pending
 * rows it would fail the row counts.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

(globalThis as any).React = React;

import fixtureRows from './fixtures/applications-api-shape.json';

jest.mock('@/lib/applications-client-supa', () => ({
  applicationsSupaClientEnabled: () => true,
}));

jest.mock('@/firebase/provider', () => ({
  useFirestore: () => ({}),
}));

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: () => ({ data: undefined, loading: false, error: null }),
}));

jest.mock('@/hooks/use-universities', () => ({
  useUniversities: () => ({ universities: [] }),
}));

jest.mock('@/hooks/use-polling-refresh', () => ({
  usePollingRefresh: () => undefined,
  MIN_POLL_INTERVAL_MS: 300000,
}));

// Same native-select shim as the export/filter suite (deterministic
// filter driving in jsdom); the list logic itself is fully real.
jest.mock('@/components/ui/select', () => {
  const ReactLocal = require('react');
  const collectOptions = (node: any): any[] => {
    const out: any[] = [];
    ReactLocal.Children.forEach(node, (child: any) => {
      if (!child || typeof child !== 'object') return;
      if (child.props && child.props.value && child.type && (child.type as any).__isSelectItemShim) {
        out.push(child);
      }
      if (child.props && child.props.children) out.push(...collectOptions(child.props.children));
    });
    return out;
  };
  const Select = ({ value, onValueChange, children }: any) => {
    const options = collectOptions(children);
    return (
      <select data-testid="select-shim" value={value} onChange={(e) => onValueChange(e.target.value)}>
        {options.map((o: any) => (
          <option key={o.props.value} value={o.props.value}>
            {o.props.children}
          </option>
        ))}
      </select>
    );
  };
  const SelectItem = ({ value, children }: any) => <option value={value}>{children}</option>;
  (SelectItem as any).__isSelectItemShim = true;
  return {
    Select,
    SelectItem,
    SelectTrigger: ({ children }: any) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => <>{children}</>,
  };
});

import { ApplicationList } from '@/components/admin/applications/application-list';

const EXPECTED: Record<string, { rows: number; badge: string }> = {
  all: { rows: 74, badge: '' },
  pending: { rows: 10, badge: 'Pending' },
  approved: { rows: 63, badge: 'Approved' },
  rejected: { rows: 1, badge: 'Rejected' },
};

function statusSelect(): HTMLSelectElement {
  const selects = screen.getAllByTestId('select-shim') as HTMLSelectElement[];
  const found = selects.find((s) => Array.from(s.options).some((o) => o.value === 'under_review'));
  if (!found) throw new Error('status select not found');
  return found;
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
}

function badgeTextOf(row: HTMLTableRowElement): string {
  const cells = row.querySelectorAll('td');
  return (cells[3]?.textContent || '').trim();
}

describe('ApplicationList with the real served shape (74 = 63/10/1)', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn(async (url: string) => {
      const m = String(url).match(/status=([a-z_]+)/);
      const docs = m ? (fixtureRows as any[]).filter((r) => r.status === m[1]) : fixtureRows;
      return { ok: true, json: async () => ({ applications: docs }) } as any;
    });
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  it('All view renders all 74 rows and every badge equals its canonical status', async () => {
    const { container } = render(
      <ApplicationList selectedApplicationId={null} onSelectApplication={() => undefined} />,
    );
    await waitFor(() => expect(bodyRows(container)).toHaveLength(74));

    const counts: Record<string, number> = {};
    for (const row of bodyRows(container)) {
      const t = badgeTextOf(row);
      counts[t] = (counts[t] || 0) + 1;
    }
    expect(counts).toEqual({ Approved: 63, Pending: 10, Rejected: 1 });
  });

  it.each(['pending', 'approved', 'rejected'] as const)(
    'the %s view shows exactly its rows, each badged with its canonical status',
    async (status) => {
      const { container } = render(
        <ApplicationList selectedApplicationId={null} onSelectApplication={() => undefined} />,
      );
      await waitFor(() => expect(bodyRows(container)).toHaveLength(74));

      fireEvent.change(statusSelect(), { target: { value: status } });

      await waitFor(() => expect(bodyRows(container)).toHaveLength(EXPECTED[status].rows));
      for (const row of bodyRows(container)) {
        expect(badgeTextOf(row)).toBe(EXPECTED[status].badge);
      }
    },
  );
});
