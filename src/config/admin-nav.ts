import type { UserRole } from "@/lib/roles";
import type { PermissionKey } from "@/config/permissions.config";

export type AdminNavItem = {
  label: string;
  path: string;
  icon?: string; // lucide icon name (optional)
  minRole?: UserRole; // legacy role gating (kept for backward compat)
  requiredPermission?: PermissionKey; // permission-based gating (preferred)
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

// Hierarchical navigation defining the Information Architecture for admin.
// This serves as the single source of truth for sidebar rendering.
// Each item can optionally require a permission — if set, the item is hidden
// unless the user's role has that permission in permissions.config.ts.
export const adminNav: AdminNavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", path: "/admin", icon: "LayoutDashboard", requiredPermission: "canAccessAdmin" },
      { label: "Issue Hub", path: "/admin/bugs", icon: "Bug", requiredPermission: "canManageBugReports" },
      { label: "Site Settings", path: "/admin/site-settings", icon: "Settings", requiredPermission: "canManageSiteSettings" },
      { label: "Audit Logs", path: "/admin/audit-logs", icon: "FileLock", requiredPermission: "canViewAuditLogs" },
    ],
  },
  {
    label: "People",
    items: [
      { label: "Users", path: "/admin/users", icon: "Users", requiredPermission: "canManageUsers" },
      { label: "Roles", path: "/admin/roles", icon: "Shield", requiredPermission: "canManageRoles" },
      { label: "Defaulters", path: "/admin/defaulters", icon: "AlertTriangle", requiredPermission: "canManageDefaulters" },
      { label: "Warning Settings", path: "/admin/warning-settings", icon: "Settings", requiredPermission: "canManageUsers" },
    ],
  },
  {
    label: "Action Center",
    items: [
      { label: "Universal Inbox", path: "/admin/submissions", icon: "Inbox", requiredPermission: "canManageApplications" },
      { label: "Sourcing Bridge", path: "/admin/sourcing", icon: "Compass", requiredPermission: "canAccessAdmin" },
    ],
  },
  {
    label: "Content",
    items: [
      { label: "Blogs", path: "/admin/blog", icon: "Newspaper", requiredPermission: "canManageBlogs" },
      { label: "Events", path: "/admin/events", icon: "Calendar", requiredPermission: "canManageEvents" },
      { label: "AI Sponsor Match", path: "/admin/events/sponsor-match", icon: "Sparkles", requiredPermission: "canManageEvents" },
      { label: "Announcements", path: "/admin/announcements", icon: "Megaphone", requiredPermission: "canManageAnnouncements" },
      { label: "Pages", path: "/admin/pages", icon: "FileText", requiredPermission: "canManagePages" },
      { label: "Contact Page", path: "/admin/pages/contact", icon: "Phone", requiredPermission: "canManagePages" },
      { label: "Resources & Opportunities", path: "/admin/resources", icon: "BookOpen", requiredPermission: "canManageResources" },
      { label: "CRM Console", path: "/admin/crm", icon: "Target", requiredPermission: "canManageSponsorsPartners" },
      { label: "Gallery", path: "/admin/gallery", icon: "Image", requiredPermission: "canManageGallery" },
    ],
  },
  {
    label: "Projects & Tasks",
    items: [
      { label: "Projects", path: "/admin/projects", icon: "FolderKanban", requiredPermission: "canManageProjects" },
      { label: "Tasks", path: "/admin/tasks", icon: "CheckCircle", requiredPermission: "canManageTasks" },
      { label: "Workflows", path: "/admin/workflows", icon: "Network", requiredPermission: "canManageWorkflows" },
    ],
  },
  {
    label: "Programs",
    items: [
      { label: "Timeline", path: "/admin/timeline", icon: "Clock", requiredPermission: "canManageTimeline" },
    ],
  },
  {
    label: "Organization",
    items: [
      { label: "Org Chart", path: "/admin/hierarchy", icon: "GitMerge", requiredPermission: "canViewHierarchy" },
      { label: "Positions", path: "/admin/positions", icon: "Briefcase", requiredPermission: "canManagePositions" },
      { label: "Skills", path: "/admin/skills", icon: "Sparkles", requiredPermission: "canManageSkills" },
      { label: "Badges", path: "/admin/badges", icon: "Award", requiredPermission: "canManageBadges" },
      { label: "Certificates", path: "/admin/certificates", icon: "IdCard", requiredPermission: "canManageCertificates" },
      { label: "Chapters", path: "/admin/chapters", icon: "Building2", requiredPermission: "canManageChapters" },
      { label: "Organizations", path: "/admin/organizations", icon: "Users", requiredPermission: "canManageChapters" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Mission Command", path: "/admin/mission-command", icon: "Rocket", requiredPermission: "canAccessAdmin" },
      { label: "Induction Apps", path: "/admin/applications", icon: "UserPlus", requiredPermission: "canManageApplications" },
      { label: "Chapter Applications", path: "/admin/chapter-applications", icon: "Building2", requiredPermission: "canManageChapterApplications" },
      { label: "Forms", path: "/admin/forms", icon: "FileSpreadsheet", requiredPermission: "canManageForms" },
      { label: "Backup & Restore", path: "/admin/backup-restore", icon: "Database", requiredPermission: "canManagePermissions" },
      { label: "Analytics", path: "/admin/analytics", icon: "BarChart2", requiredPermission: "canViewAuditLogs" },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Superadmin", path: "/admin/superadmin", icon: "Crown", requiredPermission: "canManagePermissions" },
      { label: "Role Privileges", path: "/admin/role-privileges", icon: "Shield", requiredPermission: "canManagePermissions" },
      { label: "Email Logs", path: "/admin/email-logs", icon: "Mail", requiredPermission: "canViewEmailLogs" },
      { label: "Uploads", path: "/admin/uploads", icon: "Database", requiredPermission: "canViewUploads" },
      { label: "Store", path: "/admin/store", icon: "ShoppingCart", requiredPermission: "canManageStore" },
      { label: "Financial Setup", path: "/admin/seed", icon: "Coins", requiredPermission: "canManageStore" },
    ],
  },
];
