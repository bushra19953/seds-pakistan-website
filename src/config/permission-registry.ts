/**
 * Permission Registry for SEDS Pakistan Admin Modules
 * ═══════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH for all administrative capabilities.
 * Every admin page, sidebar link, and API route should reference keys from here.
 *
 * Adding a new admin page? Add a PermissionKey here first, then add role mappings
 * in permissions.config.ts. The role-privileges UI auto-discovers these.
 */

export type PermissionKey =
  // ── System ──
  | 'canAccessAdmin'
  | 'canManagePermissions'
  | 'canManageUsers'
  | 'canManageRoles'
  // ── Oversight ──
  | 'canViewAuditLogs'
  | 'canViewHierarchy'
  | 'canViewAnalytics'
  // ── Operations ──
  | 'canManageApplications'
  | 'canManageChapterApplications'
  | 'canManageProjects'
  | 'canManageTasks'
  | 'canManageWorkflows'
  | 'canManagePrograms'
  | 'canManageResources'
  | 'canManageForms'
  // ── Content ──
  | 'canManageBlogs'
  | 'canManageEvents'
  | 'canManageAnnouncements'
  | 'canManageTimeline'
  | 'canManagePages'
  | 'canManageGallery'
  // ── Organization ──
  | 'canManageChapters'
  | 'canManagePositions'
  | 'canManageBadges'
  | 'canManageCertificates'
  | 'canManageSkills'
  | 'canManageSponsorsPartners'
  | 'canManageStore'
  | 'canManageSiteSettings'
  | 'canManageOrganizations'
  // ── Communication ──
  | 'canViewEmailLogs'
  | 'canManageBugReports'
  | 'canManageDefaulters'
  | 'canManageInbox';

export interface PermissionDefinition {
  label: string;
  description: string;
  category: 'System' | 'Oversight' | 'Operations' | 'Content' | 'Organization' | 'Communication';
}

export const ADMIN_PERMISSIONS: Record<PermissionKey, PermissionDefinition> = {
  // ── System ──
  canAccessAdmin: { label: 'Admin Panel Access', description: 'Access the leadership dashboard', category: 'System' },
  canManagePermissions: { label: 'Manage Permissions', description: 'Configure role-based access control', category: 'System' },
  canManageUsers: { label: 'Manage Users', description: 'Assign roles and manage user directory', category: 'System' },
  canManageRoles: { label: 'Manage Roles', description: 'Create and delete system role definitions', category: 'System' },

  // ── Oversight ──
  canViewAuditLogs: { label: 'Audit Logs', description: 'Monitor system-wide activity', category: 'Oversight' },
  canViewHierarchy: { label: 'View Org Chart', description: 'Visualize reporting relationships', category: 'Oversight' },
  canViewAnalytics: { label: 'Analytics', description: 'View system performance and engagement metrics', category: 'Oversight' },

  // ── Operations ──
  canManageApplications: { label: 'Induction Applications', description: 'Process member induction requests', category: 'Operations' },
  canManageChapterApplications: { label: 'Chapter Applications', description: 'Review chapter establishment requests', category: 'Operations' },
  canManageProjects: { label: 'Project Management', description: 'Oversee organizational projects', category: 'Operations' },
  canManageTasks: { label: 'Global Tasks', description: 'Assign and review tasks for any user', category: 'Operations' },
  canManageWorkflows: { label: 'Workflows', description: 'Create and manage multi-step workflows', category: 'Operations' },
  canManagePrograms: { label: 'Programs', description: 'Oversee long-term organizational programs', category: 'Operations' },
  canManageResources: { label: 'Resources & Opportunities', description: 'Curate learning and repo links', category: 'Operations' },
  canManageForms: { label: 'Forms & Surveys', description: 'Create and manage custom forms', category: 'Operations' },

  // ── Content ──
  canManageBlogs: { label: 'Blog System', description: 'Full control over news and articles', category: 'Content' },
  canManageEvents: { label: 'Events & Workshops', description: 'Schedule and manage event registrations', category: 'Content' },
  canManageAnnouncements: { label: 'Announcements', description: 'Post global network notifications', category: 'Content' },
  canManageTimeline: { label: 'Mission Timeline', description: 'Manage organizational milestones and history', category: 'Content' },
  canManagePages: { label: 'Site Pages', description: 'Edit static content pages', category: 'Content' },
  canManageGallery: { label: 'Photo Gallery', description: 'Manage media and event photos', category: 'Content' },

  // ── Organization ──
  canManageChapters: { label: 'Chapters', description: 'Manage chapter registry and leads', category: 'Organization' },
  canManagePositions: { label: 'Positions', description: 'Manage organizational titles', category: 'Organization' },
  canManageBadges: { label: 'Badges & Rewards', description: 'Award recognition to members', category: 'Organization' },
  canManageCertificates: { label: 'Certificates', description: 'Issue and manage certificates', category: 'Organization' },
  canManageSkills: { label: 'Skill Tags', description: 'Manage the organization skill map', category: 'Organization' },
  canManageSponsorsPartners: { label: 'Partners (CRM)', description: 'Manage sponsors, AI matching, and external partners', category: 'Organization' },
  canManageStore: { label: 'Store Management', description: 'Manage store and financial setup', category: 'Organization' },
  canManageSiteSettings: { label: 'Global Settings', description: 'Modify site settings and system backups', category: 'Organization' },
  canManageOrganizations: { label: 'External Organizations', description: 'Manage directory of partner organizations', category: 'Organization' },

  // ── Communication ──
  canViewEmailLogs: { label: 'Email Logs', description: 'View email delivery history and status', category: 'Communication' },
  canManageBugReports: { label: 'Bug Reports', description: 'Manage the Issue Hub and bug reports', category: 'Communication' },
  canManageDefaulters: { label: 'Defaulters', description: 'Manage defaulters and warning settings', category: 'Communication' },
  canManageInbox: { label: 'Universal Inbox', description: 'Manage and respond to all system submissions', category: 'Communication' },
};

/**
 * Role Scopes define the visibility boundaries for the Mission Command Terminal.
 * 'global': Sees all data across all chapters (National Command).
 * 'chapter': Sees only data associated with their own chapterId.
 */
export const DEFAULT_ROLE_SCOPES: Record<string, 'global' | 'chapter'> = {
  superadmin: 'global',
  president_national: 'global',
  vice_president: 'global',
  general_secretary: 'global',
  projects_director: 'global',
  marketing_head: 'global',
  hr_director: 'global',
  treasurer: 'global',
  advisor: 'global',
};

export function getRoleScope(role: string, customScope?: 'global' | 'chapter'): 'global' | 'chapter' {
  if (customScope) return customScope;
  return DEFAULT_ROLE_SCOPES[role] || 'chapter';
}
