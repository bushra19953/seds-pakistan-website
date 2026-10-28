/**
 * MandatoryProfileCheck — the WhatsApp gate flash regression pin.
 *
 * The gate reads the number from users/{uid}/private/contact, a
 * DIFFERENT subscription than the users/{uid} doc whose snapshot
 * clears loadingProfile. Before the fix there was no settled state
 * for the contact read, so on every refresh the sequence was:
 * profile lands -> gate judges -> contact still null -> "no number"
 * -> modal paints -> contact lands with the stored number -> modal
 * vanishes. Members with a saved number saw the prompt flash on
 * every refresh (founder report, 2026-10-28).
 *
 * Proven here, with both subscriptions driven by hand:
 *  - after the profile settles but BEFORE the contact read settles,
 *    the modal does NOT render (the flash case);
 *  - once the contact read settles with no number, the modal DOES
 *    render (the genuine case still asks);
 *  - once the contact read settles WITH a number, the modal does
 *    not render;
 *  - a contact read ERROR also settles the gate (the member is
 *    asked, not left in an unjudged state forever).
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';

(globalThis as Record<string, unknown>).React = React;

let profileSnapshotCb: ((snap: any) => void) | null = null;
let contactNextCb: ((contact: any) => void) | null = null;
let contactErrorCb: ((err: any) => void) | null = null;

// Stable identities: the component's effect depends on the user and
// firestore objects, so the mocks must return the same references
// across renders (as the real hooks do), or the effect re-runs and
// resets the settled state on every render.
const mockUser = { uid: 'member-1' };
const mockFirestore = {};

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: mockUser }),
  useFirestore: () => mockFirestore,
}));

jest.mock('firebase/firestore', () => ({
  doc: () => ({}),
  onSnapshot: (_ref: any, onNext: any) => {
    profileSnapshotCb = onNext;
    return () => {};
  },
}));

jest.mock('@/lib/client/user-contact', () => ({
  subscribeOwnContact: (_fs: any, _uid: string, onNext: any, onError: any) => {
    contactNextCb = onNext;
    contactErrorCb = onError;
    return () => {};
  },
  saveOwnContact: jest.fn(async () => {}),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/community',
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/hooks/use-enhanced-toast', () => ({
  useEnhancedToast: () => ({ showToast: jest.fn() }),
}));

import MandatoryProfileCheck from '../mandatory-profile-check';

function settleProfile() {
  act(() => {
    profileSnapshotCb?.({ exists: () => true, data: () => ({ displayName: 'Member One' }) });
  });
}

describe('MandatoryProfileCheck WhatsApp gate', () => {
  beforeEach(() => {
    profileSnapshotCb = null;
    contactNextCb = null;
    contactErrorCb = null;
  });

  test('does not flash while the contact read is still in flight', () => {
    render(<MandatoryProfileCheck />);
    settleProfile();
    // The exact refresh moment that used to paint the modal:
    // profile known, contact not settled yet.
    expect(screen.queryByText('Action Required')).toBeNull();
  });

  test('asks once the contact read settles with no number saved', () => {
    render(<MandatoryProfileCheck />);
    settleProfile();
    act(() => { contactNextCb?.(null); });
    expect(screen.queryByText('Action Required')).not.toBeNull();
  });

  test('stays silent when the settled contact carries a number', () => {
    render(<MandatoryProfileCheck />);
    settleProfile();
    act(() => { contactNextCb?.({ whatsapp: '+92 300 1234567' }); });
    expect(screen.queryByText('Action Required')).toBeNull();
  });

  test('a contact read error settles the gate instead of wedging it', () => {
    render(<MandatoryProfileCheck />);
    settleProfile();
    act(() => { contactErrorCb?.(new Error('permission-denied')); });
    expect(screen.queryByText('Action Required')).not.toBeNull();
  });
});
