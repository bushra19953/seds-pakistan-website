"use client";
import { useEffect, useRef } from "react";
import { useFirestore } from "@/firebase";
import { useUser } from "@/firebase";
import { collection, query, orderBy, limit } from "firebase/firestore";
import { useSafeFirestoreSubscription } from "@/hooks/use-safe-firestore-subscription";
import { useEnhancedToast } from "@/hooks/use-enhanced-toast";

export default function UserNotificationsListener() {
  const firestore = useFirestore();
  const { user } = useUser();
  const { showSuccessToast } = useEnhancedToast();
  const seen = useRef<Set<string>>(new Set());
  const enableRealtimeNotifications = String(process.env.NEXT_PUBLIC_REALTIME_ENABLED).toLowerCase() === 'true';
  const q = user && firestore ? query(collection(firestore, "users", user.uid, "notifications"), orderBy("createdAt", "desc"), limit(20)) : null as any;
  const sub = useSafeFirestoreSubscription<any>(q, { enabled: enableRealtimeNotifications && !!q });
  const mountTime = useRef<number>(Date.now());

  useEffect(() => {
    const items = sub.data || [];
    for (const d of items) {
      const id = d.id || "";
      if (!id || seen.current.has(id)) continue;
      seen.current.add(id);

      if (!d?.createdAt) continue;

      let notifTime = 0;
      if (typeof d.createdAt.toMillis === 'function') {
        notifTime = d.createdAt.toMillis();
      } else if (d.createdAt.seconds) {
        notifTime = d.createdAt.seconds * 1000;
      } else if (d.createdAt instanceof Date) {
        notifTime = d.createdAt.getTime();
      } else if (typeof d.createdAt === 'number') {
        notifTime = d.createdAt;
      }

      // Ignore notifications that are older than 15 seconds from the moment this component mounted
      if (notifTime > 0 && notifTime < mountTime.current - 15000) {
        continue;
      }

      if (d.type === "ticket_issued") {
        showSuccessToast(`🎟️ Ticket Issued - Congrats!`, {
          description: d.message || `Your ticket for "${d.eventTitle || 'the event'}" is ready.`,
          action: d.ticketId ? {
            label: "View Ticket",
            onClick: () => window.location.href = `/events/ticket/${d.ticketId}`
          } : undefined
        });
      } else {
        const title = d.type === "task-complete" ? "Task Complete" : "Notification";
        const desc = d.message || (d.badgeId ? `+${d.points} points · ${d.badgeId}` : `+${d.points} points`);
        showSuccessToast(`${title}: ${desc}`);
      }
    }
  }, [sub.data, showSuccessToast]);
  return null;
}
