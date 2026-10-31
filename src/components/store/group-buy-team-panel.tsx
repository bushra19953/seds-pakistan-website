'use client';

// Pure team render (PLAN-gh 3.9): no fetching, no auth. The team
// page owns data and the join POST; this panel only renders the
// public state it is given, so the G1 rendering assertions run as
// component tests without a network fake.
import React, { useEffect, useState } from 'react';
import type { PublicGroupBuyState } from '@/lib/server/group-buys';

export interface GroupBuyTeamPanelProps {
  state: PublicGroupBuyState;
  isSignedIn: boolean;
  isMember: boolean;
  isOpener: boolean;
  onJoin: () => void;
  onCountdownEnd?: () => void;
}

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return '0h 0m';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function GroupBuyTeamPanel({
  state,
  isSignedIn,
  isMember,
  isOpener,
  onJoin,
  onCountdownEnd,
}: GroupBuyTeamPanelProps) {
  const expiresMs = state.expiresAt ? Date.parse(state.expiresAt) : NaN;
  const serverNowMs = Date.parse(state.serverNow);
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    Number.isFinite(expiresMs) ? expiresMs - serverNowMs : 0,
  );

  useEffect(() => {
    if (state.state !== 'open' || !Number.isFinite(expiresMs)) return;
    // Local ticking only: the countdown never hits the network. At
    // zero the owner re-fetches once and renders the server state.
    const startedAt = Date.now();
    const initial = expiresMs - serverNowMs;
    const timer = setInterval(() => {
      const next = initial - (Date.now() - startedAt);
      setRemainingMs(next);
      if (next <= 0) {
        clearInterval(timer);
        onCountdownEnd?.();
      }
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.state, state.expiresAt]);

  const teamUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/group-buy/${state.shareCode}`
      : `/group-buy/${state.shareCode}`;
  const shareHref = `https://wa.me/?text=${encodeURIComponent(
    `Join my team to buy ${state.product.name} for PKR ${state.unitPricePkr}: ${teamUrl}`,
  )}`;

  const endedOn = state.expiresAt
    ? new Date(state.expiresAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  return (
    <section aria-label="Group buy team">
      {state.product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.product.imageUrl} alt={state.product.name} />
      ) : null}
      <h1>{state.product.name}</h1>
      <p>Locked price: PKR {state.unitPricePkr}</p>
      {state.deliveryPkr != null ? <p>Delivery: PKR {state.deliveryPkr} per order</p> : null}
      <p>
        {state.seatsFilled} of {state.teamSizeTarget} seats filled
      </p>

      {state.state === 'open' ? (
        <p>Time left: {formatTimeLeft(remainingMs)}</p>
      ) : null}
      {state.state === 'filled' ? <h2>Team filled. Orders are being prepared.</h2> : null}
      {state.state === 'expired' ? (
        <>
          <h2>Team did not complete - refunds in process</h2>
          {endedOn ? <p>This team ended on {endedOn}</p> : null}
        </>
      ) : null}
      {state.state === 'completed' ? <h2>Team completed. All orders delivered.</h2> : null}
      {state.state === 'cancelled' ? <h2>This team was cancelled.</h2> : null}

      <h3>{state.openerFirstName ? `${state.openerFirstName}'s team` : 'Team members'}</h3>
      <ul>
        {state.members.map((member, index) => (
          <li key={index}>
            {member.isOpener ? 'Team opener: ' : 'Member: '}
            {member.paymentState === 'paid' ? 'Paid' : 'Awaiting payment'}
          </li>
        ))}
      </ul>

      {state.state === 'open' ? (
        isMember ? (
          <p>You have a seat in this team.</p>
        ) : (
          <button type="button" onClick={onJoin}>
            {!isSignedIn
              ? 'Sign in to join'
              : isOpener
                ? 'Complete your checkout'
                : 'Join this team'}
          </button>
        )
      ) : null}

      {state.state !== 'cancelled' ? (
        <a href={shareHref} target="_blank" rel="noopener noreferrer">
          Share on WhatsApp
        </a>
      ) : null}
    </section>
  );
}
