/**
 * grant-expiry shared module (expiry-ui plan section 7.1):
 * - expiryState boundaries mirror the sweep's T-30 / T-7 alert stages.
 * - The badge renders nothing for 'none' and an honest token-styled
 *   label for every other state (ui-review U1/U2/U6).
 * - ExpiryDateField wires Label htmlFor to the control id (U3/U4).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  expiryState,
  GrantExpiryBadge,
  ExpiryDateField,
  isCustomRoleKey,
} from '../grant-expiry';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();

describe('expiryState', () => {
  it('is none for null, empty and unparseable values', () => {
    expect(expiryState(null, NOW)).toBe('none');
    expect(expiryState(undefined, NOW)).toBe('none');
    expect(expiryState('', NOW)).toBe('none');
    expect(expiryState('not-a-date', NOW)).toBe('none');
  });

  it('is set beyond 30 days', () => {
    expect(expiryState(iso(31 * DAY), NOW)).toBe('set');
    expect(expiryState(iso(90 * DAY), NOW)).toBe('set');
  });

  it('is expiring-30 at exactly 30 days and inside the window', () => {
    expect(expiryState(iso(30 * DAY), NOW)).toBe('expiring-30');
    expect(expiryState(iso(8 * DAY), NOW)).toBe('expiring-30');
  });

  it('is expiring-7 at exactly 7 days and inside the window', () => {
    expect(expiryState(iso(7 * DAY), NOW)).toBe('expiring-7');
    expect(expiryState(iso(1 * DAY), NOW)).toBe('expiring-7');
  });

  it('is expired once the instant is reached or passed', () => {
    expect(expiryState(iso(0), NOW)).toBe('expired');
    expect(expiryState(iso(-1 * DAY), NOW)).toBe('expired');
  });
});

describe('GrantExpiryBadge', () => {
  it('renders nothing when there is no expiry', () => {
    const { container } = render(<GrantExpiryBadge expiresAt={null} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a muted "Expires {date}" badge for a distant expiry', () => {
    render(<GrantExpiryBadge expiresAt={iso(90 * DAY)} now={NOW} />);
    const badge = screen.getByText(/Expires 2027-01-21/);
    expect(badge.className).toContain('text-muted-foreground');
  });

  it('renders the day count with the primary-text token inside 30 days', () => {
    render(<GrantExpiryBadge expiresAt={iso(10 * DAY)} now={NOW} />);
    const badge = screen.getByText(/Expires in 10d · 2026-11-02/);
    expect(badge.className).toContain('text-primary-text');
  });

  it('renders the day count with the destructive-text token inside 7 days', () => {
    render(<GrantExpiryBadge expiresAt={iso(3 * DAY)} now={NOW} />);
    const badge = screen.getByText(/Expires in 3d · 2026-10-26/);
    expect(badge.className).toContain('text-destructive-text');
  });

  it('renders an honest muted "Expired {date}" badge after the date, never active wording', () => {
    render(<GrantExpiryBadge expiresAt={iso(-2 * DAY)} now={NOW} />);
    const badge = screen.getByText(/Expired 2026-10-21/);
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.textContent).not.toMatch(/Expires in/);
  });

  it('uses no raw palette classes in any state', () => {
    const { container } = render(
      <>
        <GrantExpiryBadge expiresAt={iso(90 * DAY)} now={NOW} />
        <GrantExpiryBadge expiresAt={iso(10 * DAY)} now={NOW} />
        <GrantExpiryBadge expiresAt={iso(3 * DAY)} now={NOW} />
        <GrantExpiryBadge expiresAt={iso(-1 * DAY)} now={NOW} />
      </>,
    );
    expect(container.innerHTML).not.toMatch(/slate-|indigo-|amber-|green-|red-\d/);
  });
});

describe('ExpiryDateField', () => {
  it('wires the label to a datetime-local control with the given id', () => {
    render(<ExpiryDateField id="grant-expiry-test" value="" onChange={() => {}} />);
    const input = screen.getByLabelText(/Grant expiry \(optional\)/);
    expect(input).toHaveAttribute('type', 'datetime-local');
    expect(input).toHaveAttribute('id', 'grant-expiry-test');
  });

  it('reports edits through onChange and shows the factual helper copy', () => {
    const onChange = jest.fn();
    render(<ExpiryDateField id="grant-expiry-test" value="" onChange={onChange} />);
    const input = screen.getByLabelText(/Grant expiry \(optional\)/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-12-31T23:59' } });
    expect(onChange).toHaveBeenCalledWith('2026-12-31T23:59');
    expect(screen.getByText(/ends automatically on this date/)).toBeInTheDocument();
  });

  it('renders the default hint line when one is provided', () => {
    render(
      <ExpiryDateField
        id="grant-expiry-test"
        value=""
        onChange={() => {}}
        defaultHint="Prefilled from the role default term of 90 days."
      />,
    );
    expect(screen.getByText(/Prefilled from the role default term/)).toBeInTheDocument();
  });
});

describe('isCustomRoleKey', () => {
  it('accepts custom_ slugs with a non-empty remainder', () => {
    expect(isCustomRoleKey('custom_poster_team_lead')).toBe(true);
  });

  it('rejects catalog keys, the bare prefix and non-strings', () => {
    expect(isCustomRoleKey('chapter_design_chair')).toBe(false);
    expect(isCustomRoleKey('custom_')).toBe(false);
    expect(isCustomRoleKey('')).toBe(false);
    expect(isCustomRoleKey(null)).toBe(false);
    expect(isCustomRoleKey(undefined)).toBe(false);
  });
});
