/**
 * PLAN-gh 8.3: panel, page and block rendering tests from fixture
 * props only. useUser and next/navigation are module-mocked; the
 * panel itself has no fetching or auth, so its assertions run at
 * the lowest level that proves the behaviour.
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
const mockUserState: { user: any } = { user: null };

jest.mock('@/firebase', () => ({
  useUser: () => ({ user: mockUserState.user }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ shareCode: 'AB12CD34EF56' }),
}));

import { GroupBuyTeamPanel } from '@/components/store/group-buy-team-panel';
import { GroupBuyBlock } from '@/components/store/group-buy-block';
import GroupBuyTeamPage from '@/app/group-buy/[shareCode]/page';
import type { PublicGroupBuyState } from '@/lib/server/group-buys';

const NOW_ISO = '2026-10-31T10:00:00.000Z';

function fixtureState(overrides: Partial<PublicGroupBuyState> = {}): PublicGroupBuyState {
  return {
    ok: true,
    shareCode: 'AB12CD34EF56',
    state: 'open',
    product: { id: 'p1', name: 'Widget', imageUrl: null },
    unitPricePkr: 4500,
    deliveryPkr: 300,
    teamSizeTarget: 3,
    seatsFilled: 2,
    seatsLeft: 1,
    opensAt: '2026-10-31T09:00:00.000Z',
    expiresAt: '2026-10-31T12:00:00.000Z',
    serverNow: NOW_ISO,
    openerFirstName: 'Ayesha',
    members: [
      { isOpener: true, seated: true, paymentState: 'paid' },
      { isOpener: false, seated: true, paymentState: 'awaiting_payment' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockUserState.user = null;
});

afterEach(() => cleanup());

describe('panel', () => {
  it('panel open: shows locked price, seats filled of target and a ticking time left', () => {
    render(
      <GroupBuyTeamPanel
        state={fixtureState()}
        isSignedIn
        isMember={false}
        isOpener={false}
        onJoin={jest.fn()}
      />,
    );
    expect(screen.getByText('Locked price: PKR 4500')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 seats filled')).toBeInTheDocument();
    expect(screen.getByText('Time left: 2h 0m')).toBeInTheDocument();
  });

  it('panel open: member list shows Paid and Awaiting payment with no names beyond the opener first name', () => {
    const { container } = render(
      <GroupBuyTeamPanel
        state={fixtureState()}
        isSignedIn
        isMember={false}
        isOpener={false}
        onJoin={jest.fn()}
      />,
    );
    expect(screen.getByText(/Paid/)).toBeInTheDocument();
    expect(screen.getByText(/Awaiting payment/)).toBeInTheDocument();
    expect(container.textContent).toContain("Ayesha's team");
    expect(container.textContent).not.toContain('Khan');
  });

  it('panel expired: shows the exact banner Team did not complete - refunds in process', () => {
    render(
      <GroupBuyTeamPanel
        state={fixtureState({ state: 'expired' })}
        isSignedIn={false}
        isMember={false}
        isOpener={false}
        onJoin={jest.fn()}
      />,
    );
    expect(screen.getByText('Team did not complete - refunds in process')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it('panel completed: shows Team completed. All orders delivered.', () => {
    render(
      <GroupBuyTeamPanel
        state={fixtureState({ state: 'completed' })}
        isSignedIn
        isMember
        isOpener={false}
        onJoin={jest.fn()}
      />,
    );
    expect(screen.getByText('Team completed. All orders delivered.')).toBeInTheDocument();
  });

  it('panel filled: shows the filled banner and no Join button', () => {
    render(
      <GroupBuyTeamPanel
        state={fixtureState({ state: 'filled' })}
        isSignedIn
        isMember={false}
        isOpener={false}
        onJoin={jest.fn()}
      />,
    );
    expect(screen.getByText('Team filled. Orders are being prepared.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it('panel: WhatsApp share href is a wa.me link carrying the team URL and locked price', () => {
    render(
      <GroupBuyTeamPanel
        state={fixtureState()}
        isSignedIn
        isMember={false}
        isOpener={false}
        onJoin={jest.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: 'Share on WhatsApp' });
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('https://wa.me/?text=')).toBe(true);
    const text = decodeURIComponent(href.slice('https://wa.me/?text='.length));
    expect(text).toContain('/group-buy/AB12CD34EF56');
    expect(text).toContain('PKR 4500');
    expect(text).toContain('Widget');
  });
});

describe('page', () => {
  it('panel: signed out Join routes to login with the team page as redirect', async () => {
    mockUserState.user = null;
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => fixtureState(),
    }));
    render(<GroupBuyTeamPage />);
    const join = await screen.findByRole('button', { name: 'Sign in to join' });
    fireEvent.click(join);
    expect(mockPush).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent('/group-buy/AB12CD34EF56')}`,
    );
  });
});

describe('block', () => {
  const blockProps = {
    productId: 'p1',
    productName: 'Widget',
    unitPricePkr: 4500,
    teamSize: 3,
    windowHours: 48,
  };

  it('block: signed out button routes to login with the product page as redirect', () => {
    mockUserState.user = null;
    render(<GroupBuyBlock {...blockProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to start a team' }));
    expect(mockPush).toHaveBeenCalledWith(
      `/login?redirect=${encodeURIComponent('/store/p1')}`,
    );
  });

  it('block: signed in Start a team posts only the productId and routes to checkout with groupBuyId', async () => {
    mockUserState.user = { uid: 'opener-1', getIdToken: async () => 'token-1' };
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, groupBuyId: 'gb-1' }),
    }));
    (global as any).fetch = fetchMock;
    render(<GroupBuyBlock {...blockProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start a team' }));
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/checkout?productId=p1&groupBuyId=gb-1'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as any[];
    expect(JSON.parse(init.body)).toEqual({ productId: 'p1' });
    expect(init.headers.authorization).toBe('Bearer token-1');
  });

  it('block: copy states the full refund on an incomplete team and names no discount', () => {
    render(<GroupBuyBlock {...blockProps} />);
    expect(screen.getByText(/refunded in full/)).toBeInTheDocument();
    expect(screen.queryByText(/discount/i)).toBeNull();
  });
});
