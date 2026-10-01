"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMapping } from "./icon-mapping";
import { adminNav, AdminNavItem, AdminNavGroup } from "@/config/admin-nav";
import { useUser } from "@/firebase/auth/use-user";
import { hasSufficientRole } from "@/lib/roles";
import { hasPermission } from "@/config/permissions";

function NavLink({ item, active }: { item: AdminNavItem; active: boolean }) {
  const Icon = item.icon ? IconMapping[item.icon] : null;
  return (
    <Link
      href={item.path}
      prefetch={false}
      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${active
        ? "bg-slate-800 text-white"
        : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
        }`}
    >
      {Icon ? <Icon className="h-4 w-4" /> : null}
      <span>{item.label}</span>
    </Link>
  );
}

export default function AdminSidebar({
  groups = adminNav,
}: {
  groups?: AdminNavGroup[];
}) {
  const pathname = usePathname();
  const { role, allowedPaths } = useUser();

  return (
    <aside className="h-full w-full bg-slate-900/80 p-3">
      <div className="space-y-6">
        {groups.map((group) => {
          // Filter items based on unified hasPermission and explicit path allowance
          const visibleItems = group.items.filter((item) => {
            // 1. Path Gating: If allowedPaths is explicitly set for this role, it acts as a filter
            if (allowedPaths && allowedPaths.length > 0) {
              if (!allowedPaths.includes('all') && !allowedPaths.includes(item.path)) {
                return false;
              }
            }

            // 2. Permission Gating
            if (item.requiredPermission) {
              return hasPermission(role as any, item.requiredPermission);
            }
            if (item.minRole) {
              return role && hasSufficientRole(role, item.minRole);
            }
            return true;
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={group.label}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {group.label}
              </div>
              <div className="space-y-1">
                {visibleItems.map((item) => {
                  const isActive = item.path === "/admin"
                    ? pathname === "/admin"
                    : pathname === item.path || pathname.startsWith(item.path + "/");
                  return (
                    <NavLink
                      key={item.path}
                      item={item}
                      active={isActive}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
