"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/firebase";
import { hasSufficientRole, UserRole } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { serverTimestamp, Timestamp } from 'firebase/firestore';
;
import { Card, CardContent } from "@/components/ui/card";
import { syncEventToProduct } from "@/app/actions/store";
import { serverWrite } from '@/lib/client/server-write';
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import EventForm from "@/components/admin/events/event-form";
import { pktWallTimeToUtcMs } from "@/lib/events/datetime";
import { eventProductLinkFromPayload } from "@/lib/events/product-link";

// Helper to create an announcement is deprecated; Replaced by the Global Broadcast API.

export default function CreateEventPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const { toast } = useToast();
  const router = useRouter();

  if (userLoading) return <div>Loading...</div>;

  const handleCreate = async (payload: any) => {
    if (!user) {
      toast({ title: "Error", description: "You must be logged in to create an event.", variant: "destructive" });
      return;
    }

    try {
      const slug: string = (payload.title || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");

      if (!slug) {
        toast({ title: "Error", description: "Title is required to create a slug.", variant: "destructive" });
        return;
      }

      // Form date strings are Asia/Karachi wall times; convert with the
      // fixed +05:00 offset so the stored instant does not depend on the
      // browser's timezone (src/lib/events/datetime.ts).
      const startMs = payload.startDate ? pktWallTimeToUtcMs(payload.startDate) : null;
      const endMs = payload.endDate ? pktWallTimeToUtcMs(payload.endDate) : null;
      const startAt = startMs != null ? Timestamp.fromMillis(startMs) : null;
      const endAt = endMs != null ? Timestamp.fromMillis(endMs) : null;

      if (startAt && endAt && endAt.toMillis() < startAt.toMillis()) {
        toast({ title: "Error", description: "End date must be after start date.", variant: "destructive" });
        return;
      }

      const toCreate = {
        id: slug,
        slug,
        ...payload,
        startAt,
        endAt,
        deleted: false,
        attendeeIds: [],
        editors: [user.uid],
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      // WS10: the write runs server-side (POST /api/admin/events/write).
      // toCreate stays intact for the syncEventToProduct call below;
      // the route copy drops the non-JSON fields — startAt/endAt
      // travel as epoch millis, createdAt/updatedAt are stamped by
      // the route.
      const routeData: Record<string, any> = { ...toCreate };
      delete routeData.startAt;
      delete routeData.endAt;
      delete routeData.createdAt;
      delete routeData.updatedAt;
      await serverWrite('/api/admin/events/write', 'POST', {
        op: 'set',
        id: slug,
        data: routeData,
        timestampFields: ['createdAt', 'updatedAt'],
        millisFields: { startAt: startMs, endAt: endMs },
      });

      // Sync with Store if paid. EV-P07: the form payload nests payment
      // state under paymentDetails — there is no top-level payload.isPaid,
      // so the old gate never fired and the product link never persisted.
      // Derive the link explicitly (lib/events/product-link) and hand the
      // sync the flat fields it reads (isPaid / amountInput / currency).
      const productLink = eventProductLinkFromPayload(payload);
      if (productLink.isPaid) {
        try {
          const syncRes = await syncEventToProduct(
            {
              ...toCreate,
              ...payload,
              isPaid: true,
              amountInput: productLink.amount != null ? String(productLink.amount) : '',
              currency: productLink.currency || 'PKR',
            },
            productLink.productId,
          );
          if (syncRes.success) {
            // WS10: product-link write through the same route.
            await serverWrite('/api/admin/events/write', 'POST', {
              op: 'update', id: slug, data: { productId: syncRes.id },
            });
          }
        } catch (err) {
          console.error('Failed to sync event with store:', err);
        }
      }

      // Trigger global broadcast and event promo announcement
      if (payload.visibility === 'public' && payload.status === 'published') {
        try {
          const token = await user.getIdToken();
          await fetch('/api/events/publish', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ eventId: slug })
          });
        } catch (err) {
          console.error('Failed to trigger global broadcast', err);
        }
      }

      toast({ title: "Success", description: "Event created successfully!" });
      router.push("/admin/events");
    } catch (error) {
      console.error("Error creating event:", error);
      toast({ title: "Error", description: "Failed to create event. Please try again.", variant: "destructive" });
    }
  };

  return (
    <AuthorizationGate permission="canManageEvents">
      <div className="container mx-auto py-8">
        <h1 className="text-3xl font-bold mb-6">Create New Event</h1>
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
          <CardContent className="pt-6">
            <EventForm submitLabel="Create Event" onSubmit={handleCreate} />
          </CardContent>
        </Card>
      </div>
    </AuthorizationGate>
  );
}
