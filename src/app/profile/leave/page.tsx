"use client";

import Link from "next/link";
import { LeaveApplyForm } from "@/components/profile/leave-apply-form";
import { Button } from "@/components/ui/button";

/**
 * Member leave apply page at /profile/leave.
 * Renders the leave apply form plus the member's own requests list.
 * All writes go through POST /api/leave. No direct Firestore writes here.
 */
export default function ProfileLeavePage() {
    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
            <Button asChild variant="outline" size="sm">
                <Link href="/profile">Back to profile</Link>
            </Button>
            <LeaveApplyForm />
        </div>
    );
}
