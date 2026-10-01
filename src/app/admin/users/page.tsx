"use client";

import UserTable from "@/components/admin/users/user-table";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

export default function UsersAdminPage() {
  return (
    <AuthorizationGate permission="canManageUsers">
      <div className="container mx-auto px-6 py-10">
        <h1 className="text-3xl font-bold mb-6">Users Management</h1>
        <UserTable />
      </div>
    </AuthorizationGate>
  );
}
