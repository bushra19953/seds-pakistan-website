"use client";

import React, { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import UserSelectionCombobox from "@/components/admin/user-selection-combobox";
import { useUser } from "@/firebase/index";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

export default function UserComboboxDemoPage() {
  const { user } = useUser();
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  return (
    <AuthorizationGate permission="canManageUsers">
      <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle>User Selection Combobox (Demo)</CardTitle>
          <CardDescription>
            Search and select a user from Firestore. This demo is for previewing the reusable component in isolation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!user ? (
            <p className="text-sm text-muted-foreground">Please sign in to list users.</p>
          ) : (
            <div className="space-y-4">
              <UserSelectionCombobox
                selectedUid={selectedUid}
                onSelect={(uid) => setSelectedUid(uid)}
                placeholder="Select a user"
              />
              <p className="text-sm">Selected UID: {selectedUid ?? "None"}</p>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </AuthorizationGate>
  );
}