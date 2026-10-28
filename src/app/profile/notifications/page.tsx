"use client";

import Link from "next/link";
import { NotificationPreferences } from "@/components/notifications/notification-preferences";
import { Button } from "@/components/ui/button";

/**
 * Member notification settings at /profile/notifications.
 * This is the page every notification email footer links to. The
 * email toggle rendered here writes users/{uid}.emailNotifications,
 * which the mailer (src/lib/mailer.ts) and the notification service
 * (src/lib/server/notification-service.ts) honor server-side.
 */
export default function ProfileNotificationsPage() {
    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
            <Button asChild variant="outline" size="sm">
                <Link href="/profile">Back to profile</Link>
            </Button>
            <NotificationPreferences />
        </div>
    );
}
