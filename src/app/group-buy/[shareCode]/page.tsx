'use client';

// Team page (PLAN-gh 3.8). Fetches the public state once on mount
// and re-fetches every 60 seconds only while the team is open; the
// countdown ticks locally inside the panel. The public state
// carries no user ids by design, so this page cannot know locally
// whether the viewer is seated: membership is confirmed by the
// join response (409 ALREADY_SEATED), after which the panel shows
// the seated message.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { GroupBuyTeamPanel } from '@/components/store/group-buy-team-panel';
import type { PublicGroupBuyState } from '@/lib/server/group-buys';

export default function GroupBuyTeamPage() {
  const params = useParams();
  const shareCode = String(params?.shareCode ?? '');
  const router = useRouter();
  const { user } = useUser();

  const [state, setState] = useState<PublicGroupBuyState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isMember, setIsMember] = useState(false);
  const stateRef = useRef<PublicGroupBuyState | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/store/group-buys/${shareCode}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const data = (await res.json()) as PublicGroupBuyState;
      stateRef.current = data;
      setState(data);
    } catch {
      setNotFound(true);
    }
  }, [shareCode]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (stateRef.current?.state === 'open') load();
    }, 60000);
    return () => clearInterval(timer);
  }, [load]);

  async function handleJoin() {
    if (!user) {
      router.push(`/login?redirect=${encodeURIComponent(`/group-buy/${shareCode}`)}`);
      return;
    }
    setJoinError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/store/group-buys/${shareCode}/join`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
      });
      const data = (await res.json().catch(() => null)) as
        | { checkoutUrl?: string; error?: string; code?: string }
        | null;
      if (res.ok && data?.checkoutUrl) {
        router.push(data.checkoutUrl);
        return;
      }
      if (data?.code === 'ALREADY_SEATED') {
        setIsMember(true);
        return;
      }
      setJoinError(data?.error ?? 'Could not join this team. Please try again.');
      load();
    } catch {
      setJoinError('Could not join this team. Please try again.');
    }
  }

  if (notFound) {
    return (
      <main>
        <p>This team link is not valid.</p>
        <Link href="/store">Browse the store</Link>
      </main>
    );
  }
  if (!state) {
    return (
      <main>
        <p role="status">Loading team...</p>
      </main>
    );
  }

  return (
    <main>
      <GroupBuyTeamPanel
        state={state}
        isSignedIn={!!user}
        isMember={isMember}
        isOpener={false}
        onJoin={handleJoin}
        onCountdownEnd={load}
      />
      {joinError ? <p role="alert">{joinError}</p> : null}
    </main>
  );
}
