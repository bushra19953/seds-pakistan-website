"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser, useDoc, useFirestore } from "@/firebase";
import { hasSufficientRole, UserRole } from "@/lib/roles";
import Footer from "@/components/layout/footer";
import StarryBackground from "@/components/starry-background";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { type NextPage } from "next";
import EventForm from "@/components/admin/events/event-form";
import { useToast } from "@/hooks/use-toast";
import { doc, serverTimestamp, Timestamp } from 'firebase/firestore';
;
import { syncEventToProduct } from "@/app/actions/store";
import { updateDoc } from '@/lib/client/firestore-wrapper';
import AuthorizationGate from "@/components/admin/AuthorizationGate";

function EditEventContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();
  const [isDeleting, setIsDeleting] = useState(false);

  const eventDocRef = useMemo(() => {
    if (!id) return null;
    return doc(firestore, "events", id);
  }, [firestore, id]);
  const { data: event, loading: eventLoading } = useDoc(eventDocRef);

  if (eventLoading) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>Loading event...</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 container mx-auto py-8 px-4">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
            <CardContent className="py-12 text-center">
              <h2 className="text-2xl font-bold mb-4">Event Not Found</h2>
              <p className="text-muted-foreground mb-6">The event you are looking for does not exist or you may not have access.</p>
              <Button asChild>
                <Link href="/admin/events">Back to Events</Link>
              </Button>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  const authorUid = (event as any)?.authorUid ?? (event as any)?.createdByUid ?? (event as any)?.createdBy;
  const canEdit = !!user && (authorUid === user.uid || (!!role && hasSufficientRole(role as UserRole, "chair_events" as UserRole)));
  if (!canEdit) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center">
        <StarryBackground />
        <p>You do not have permission to edit this event.</p>
      </div>
    );
  }

  const handleUpdate = async (payload: any) => {
    if (!id) return;
    try {
      const ref = doc(firestore, "events", id);

      const startAt = payload.startDate ? Timestamp.fromDate(new Date(payload.startDate)) : undefined;
      const endAt = payload.endDate ? Timestamp.fromDate(new Date(payload.endDate)) : undefined;

      const updatePayload: any = { ...payload };
      // Normalize fields for Firestore
      delete updatePayload.startDate;
      delete updatePayload.endDate;

      if (startAt) updatePayload.startAt = startAt;
      if (endAt) updatePayload.endAt = endAt;

      updatePayload.updatedAt = serverTimestamp();

      await updateDoc(ref, updatePayload);

      // Sync with Store if paid
      if (payload.isPaid) {
        try {
          const syncRes = await syncEventToProduct({ ...event, ...payload, id }, payload.productId);
          if (syncRes.success && syncRes.id !== payload.productId) {
            await updateDoc(ref, { productId: syncRes.id });
          }
        } catch (err) {
          console.error('Failed to sync event with store:', err);
        }
      }

      toast({ title: "Success", description: "Event updated successfully!" });
      router.push("/admin/events");
    } catch (error) {
      console.error("Error updating event:", error);
      toast({ title: "Error", description: "Failed to update event. Please try again.", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!confirm("Are you sure you want to delete this event? This will hide it from listings.")) return;
    try {
      setIsDeleting(true);
      const ref = doc(firestore, "events", id);
      await updateDoc(ref, {
        deleted: true,
        status: 'archived',
        showInTicker: false,
        deletedAt: serverTimestamp(),
        deletedByUid: user?.uid || null,
      });
      toast({ title: "Event Deleted", description: "The event has been marked as deleted." });
      router.push("/admin/events");
    } catch (error) {
      console.error("Error deleting event:", error);
      toast({ title: "Error", description: "Failed to delete event.", variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-8 px-4">
        <Button asChild variant="outline" className="mb-4">
          <Link href="/admin/events"><ArrowLeft className="h-4 w-4 mr-2" /> Back to Events</Link>
        </Button>
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
          <CardHeader>
            <CardTitle>Edit Event</CardTitle>
            <CardDescription>Update event details</CardDescription>
          </CardHeader>
          <CardContent>
            <EventForm submitLabel="Save Changes" initialData={event} onSubmit={handleUpdate} />
            <div className="flex justify-end mt-4">
              <Button 
                type="button" 
                variant="destructive" 
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting..." : "Delete Event"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}

const EditEventPage: NextPage = () => {
  return (
    <AuthorizationGate permission="canManageEvents">
      <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading...</p></div>}>
        <EditEventContent />
      </Suspense>
    </AuthorizationGate>
  );
};

export default EditEventPage;