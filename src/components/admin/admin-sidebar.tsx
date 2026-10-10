"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMapping } from "./icon-mapping";
import { adminNav, AdminNavItem, AdminNavGroup } from "@/config/admin-nav";
import { useUser } from "@/firebase/auth/use-user";
import { hasSufficientRole } from "@/lib/roles";
import { hasPermission } from "@/config/permissions";

function NavLink({ item, active, collapsed = false }: { item: AdminNavItem; active: boolean; collapsed?: boolean }) {
  const Icon = item.icon ? IconMapping[item.icon] : null;
  return (
    <Link
      href={item.path}
      prefetch={false}
      title={collapsed ? item.label : undefined}
      aria-label={item.label}
      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${collapsed ? "justify-center px-2" : ""} ${active
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        }`}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

export default function AdminSidebar({
  groups = adminNav,
  collapsed = false,
}: {
  groups?: AdminNavGroup[];
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { role, allowedPaths } = useUser();

  return (
    <aside className={`h-full w-full bg-card/80 ${collapsed ? "p-2" : "p-3"}`}>
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
              {collapsed ? (
                <div className="mb-2 border-b border-border/60" aria-hidden="true" />
              ) : (
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
              )}
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
                      collapsed={collapsed}
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
