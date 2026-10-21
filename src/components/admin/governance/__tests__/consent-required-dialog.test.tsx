/**
 * Consent-required dialog tests (spec B.7 UI cases).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConsentRequiredDialog } from '@/components/admin/governance/consent-required-dialog';
import type { ConsentGateErrorBody } from '@/lib/client/consent-gate-error';

function body(reason: string): ConsentGateErrorBody {
  return {
    error: 'CONSENT_REQUIRED',
    code: 'CONSENT_REQUIRED',
    matter: 'catb_officer',
    reason,
    subject: { type: 'user_role', targetUid: 'user-1', roleKey: 'president_national', action: 'appoint' },
    consentRequestId: 'cr-1',
    fileRequestUrl:
      '/admin/governance/consents/new?matter=catb_officer&subjectType=user_role&subject=%7B%7D',
  };
}

it.each([
  ['refused', 'Consent was refused for this act.'],
  ['deemed_withheld', 'Consent was deemed withheld for this act.'],
  ['already_consumed', 'The selected consent has already been used for another act.'],
  ['conditional_unmet', 'Consent was given with conditions that have not been confirmed as met.'],
  ['missing', 'No consent request was selected.'],
  ['expired', 'The selected consent has expired.'],
])('renders the reason line for %s', (reason, line) => {
  render(<ConsentRequiredDialog open body={body(reason)} onClose={jest.fn()} />);
  expect(screen.getByText('Founder Consent required')).toBeTruthy();
  expect(screen.getByText(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
});

it('names the Reserved Matter in the body', () => {
  render(<ConsentRequiredDialog open body={body('refused')} onClose={jest.fn()} />);
  expect(
    screen.getByText(/Appointing or removing a national officer \(Category B\)/),
  ).toBeTruthy();
});

it('file-request button uses the supplied deep link', () => {
  render(<ConsentRequiredDialog open body={body('missing')} onClose={jest.fn()} />);
  const link = screen.getByText('File a consent request') as HTMLAnchorElement;
  expect(link.href).toContain('/admin/governance/consents/new?matter=catb_officer');
});

it('has no proceed-anyway action', () => {
  render(<ConsentRequiredDialog open body={body('refused')} onClose={jest.fn()} />);
  const buttons = screen.getAllByRole('button');
  for (const b of buttons) {
    expect(b.textContent ?? '').not.toMatch(/proceed|continue anyway|ignore/i);
  }
  expect(screen.queryByText(/proceed anyway/i)).toBeNull();
});

it('Cancel calls onClose', () => {
  const onClose = jest.fn();
  render(<ConsentRequiredDialog open body={body('refused')} onClose={onClose} />);
  fireEvent.click(screen.getByText('Cancel'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
