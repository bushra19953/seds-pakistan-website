"use client";
import { OptimizedProfile } from "@/components/profile/optimized-profile";
import { Button } from "@/components/ui/button";
import { useFirestore, useUser } from "@/firebase";
import { doc, getDoc } from "firebase/firestore";
import { serverWrite } from "@/lib/client/server-write";
import { useCallback, useState, useEffect, use as usePromise } from "react";
import { useRouter } from "next/navigation";

export default function PublicUnifiedProfilePage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = usePromise(params);
  const firestore = useFirestore();
  const { user } = useUser();
  const router = useRouter();
  const [votingUp, setVotingUp] = useState(false);
  const [votingDown, setVotingDown] = useState(false);
  const [hasVoted, setHasVoted] = useState(false);

  useEffect(() => {
    let mounted = true;
    const checkVote = async () => {
      if (!firestore || !uid || !user) return;
      try {
        const voteRef = doc(firestore, "users", uid, "votes", user.uid);
        const snap = await getDoc(voteRef);
        if (mounted) setHasVoted(snap.exists());
      } catch {}
    };
    checkVote();
    return () => { mounted = false; };
  }, [firestore, uid, user]);

  const handleUpvote = useCallback(async () => {
    if (!uid) return;
    if (votingUp) return;
    if (!user) {
      router.push(`/auth/login?redirect=/profile/unified/${uid}`);
      return;
    }
    if (hasVoted) return;
    try {
      setVotingUp(true);
      // WS10: the vote transaction runs server-side
      // (POST /api/users/vote); a 409 surfaces as an
      // 'already_voted' error, handled by the catch below exactly
      // as the client transaction's error was.
      await serverWrite('/api/users/vote', 'POST', { targetUid: uid, type: 'up' });
      setHasVoted(true);
    } catch (e) {
      if (String((e as any)?.message || "").includes("already_voted")) {
        // ignore
      } else {
        console.error("Failed to upvote", e);
      }
    } finally {
      setVotingUp(false);
    }
  }, [firestore, uid, votingUp, user, router, hasVoted]);

  const handleDownvote = useCallback(async () => {
    if (!uid) return;
    if (votingDown) return;
    if (!user) {
      router.push(`/auth/login?redirect=/profile/unified/${uid}`);
      return;
    }
    if (hasVoted) return;
    try {
      setVotingDown(true);
      // WS10: same server vote route as the upvote.
      await serverWrite('/api/users/vote', 'POST', { targetUid: uid, type: 'down' });
      setHasVoted(true);
    } catch (e) {
      if (String((e as any)?.message || "").includes("already_voted")) {
        // ignore
      } else {
        console.error("Failed to downvote", e);
      }
    } finally {
      setVotingDown(false);
    }
  }, [firestore, uid, votingDown, user, router, hasVoted]);
  return (
    <div className="container mx-auto px-6 py-10">
      <div className="flex items-center justify-end gap-2 mb-4">
        <Button variant="default" size="sm" onClick={handleUpvote} disabled={votingUp || hasVoted || !user}>Upvote</Button>
        <Button variant="outline" size="sm" onClick={handleDownvote} disabled={votingDown || hasVoted || !user}>Downvote</Button>
      </div>
      <OptimizedProfile uid={uid} showProjects={true} showLayout={true} simpleLayout={false} />
    </div>
  );
}
