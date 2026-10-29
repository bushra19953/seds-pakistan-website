/**
 * ApplicationList filter/export pins (founder report 2026-10-29: with a
 * status filter active, the CSV export contained ALL applications
 * instead of the filtered set).
 *
 * One source of truth: the Export CSV payload must be exactly the list
 * the table is displaying. These tests render ApplicationList for real
 * on both data paths and pin, with the Pending filter active:
 *   (a) the visible table shows only pending rows;
 *   (b) the exported CSV contains only pending rows.
 *
 * The Firestore path is fed the FULL mixed set (worst case: the query
 * constraint ignored), so the pin covers the client-side filter that
 * both display and export consume. The Supa path's fetch mirrors the
 * live route's proven behavior (no query = full set, ?status=pending =
 * pending rows only). Only the dropdown widget, data sources and the
 * download plumbing are mocked; the list, filter and export logic are
 * the real components.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

(globalThis as any).React = React;

// --- Controllable data sources ----------------------------------------------

const ROWS = [
  { id: 'app-p1', fullName: 'Pending One', email: 'p1@example.com', university: 'IST', status: 'pending', created_at: '2026-10-27T10:00:00.000Z' },
  { id: 'app-p2', fullName: 'Pending Two', email: 'p2@example.com', university: 'IST', status: 'pending', created_at: '2026-10-28T10:00:00.000Z' },
  { id: 'app-a1', fullName: 'Approved One', email: 'a1@example.com', university: 'IST', status: 'approved', created_at: '2026-10-26T10:00:00.000Z' },
  { id: 'app-r1', fullName: 'Rejected One', email: 'r1@example.com', university: 'IST', status: 'rejected', created_at: '2026-10-25T10:00:00.000Z' },
];

let supaClientOn = false;

jest.mock('@/lib/applications-client-supa', () => ({
  applicationsSupaClientEnabled: () => supaClientOn,
}));

jest.mock('@/firebase/provider', () => ({
  useFirestore: () => ({}),
}));

jest.mock('@/firebase/firestore/use-collection', () => ({
  useCollection: () => ({ data: ROWS, loading: false, error: null }),
}));

jest.mock('@/hooks/use-universities', () => ({
  useUniversities: () => ({ universities: [] }),
}));

jest.mock('@/hooks/use-polling-refresh', () => ({
  usePollingRefresh: () => undefined,
  MIN_POLL_INTERVAL_MS: 300000,
}));

// Native-select shim for the Radix Select primitives, so the filter
// state can be driven deterministically in jsdom. SelectItem children
// become real <option>s; changing the native select fires the same
// onValueChange the Radix widget would.
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
      <select
        data-testid="select-shim"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
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

// --- Helpers -----------------------------------------------------------------

let capturedBlob: Blob | null = null;

beforeEach(() => {
  capturedBlob = null;
  (URL as any).createObjectURL = jest.fn((blob: Blob) => {
    capturedBlob = blob;
    return 'blob:mock';
  });
  (URL as any).revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (global as any).fetch;
});

function statusSelect(): HTMLSelectElement {
  const selects = screen.getAllByTestId('select-shim') as HTMLSelectElement[];
  const found = selects.find((s) => Array.from(s.options).some((o) => o.value === 'under_review'));
  if (!found) throw new Error('status select not found');
  return found;
}

function readBlobText(blob: Blob): Promise<string> {
  // jsdom's Blob has no .text(); FileReader is the portable reader.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function exportAndReadCsv(): Promise<string[]> {
  fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
  expect(capturedBlob).not.toBeNull();
  const text = await readBlobText(capturedBlob!);
  return text.split('\n');
}

describe('ApplicationList: the export is the filtered list', () => {
  it('Firestore path: Pending filter narrows the table AND the export to pending rows only', async () => {
    supaClientOn = false;
    render(<ApplicationList selectedApplicationId={null} onSelectApplication={() => undefined} />);

    // Full set visible before filtering.
    expect(await screen.findByText('Approved One')).toBeTruthy();

    fireEvent.change(statusSelect(), { target: { value: 'pending' } });

    await waitFor(() => expect(screen.queryByText('Approved One')).toBeNull());
    expect(screen.queryByText('Rejected One')).toBeNull();
    expect(screen.getByText('Pending One')).toBeTruthy();
    expect(screen.getByText('Pending Two')).toBeTruthy();

    const lines = await exportAndReadCsv();
    // header + exactly the 2 pending rows
    expect(lines).toHaveLength(3);
    const body = lines.slice(1).join('\n');
    expect(body).toContain('Pending One');
    expect(body).toContain('Pending Two');
    expect(body).not.toContain('Approved One');
    expect(body).not.toContain('Rejected One');
    // every exported data row carries the pending status
    for (const line of lines.slice(1)) {
      expect(line).toContain('pending');
      expect(line).not.toContain('approved');
      expect(line).not.toContain('rejected');
    }
  });

  it('Supa path: filter is pushed to the route and the export matches the displayed pending rows', async () => {
    supaClientOn = true;
    const fetchMock = jest.fn(async (url: string) => {
      const isPending = String(url).includes('status=pending');
      const docs = isPending ? ROWS.filter((r) => r.status === 'pending') : ROWS;
      return { ok: true, json: async () => ({ applications: docs }) } as any;
    });
    (global as any).fetch = fetchMock;

    render(<ApplicationList selectedApplicationId={null} onSelectApplication={() => undefined} />);
    expect(await screen.findByText('Approved One')).toBeTruthy();

    fireEvent.change(statusSelect(), { target: { value: 'pending' } });

    // The list passes through its loading state before the narrowed
    // fetch lands; wait for the pending rows themselves.
    expect(await screen.findByText('Pending One')).toBeTruthy();
    expect(screen.queryByText('Approved One')).toBeNull();
    // the route was asked for the narrowed set
    expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes('/api/admin/applications?status=pending'))).toBe(true);

    const lines = await exportAndReadCsv();
    expect(lines).toHaveLength(3);
    const body = lines.slice(1).join('\n');
    expect(body).toContain('Pending One');
    expect(body).toContain('Pending Two');
    expect(body).not.toContain('Approved One');
    expect(body).not.toContain('Rejected One');
  });
});
