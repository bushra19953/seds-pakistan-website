/**
 * Blog-specific Role-Based Access Control (RBAC) system
 * Extends the existing organizational hierarchy with blog management roles
 */

import { UserRole } from '@/lib/roles';

// Blog-specific roles
export type BlogRole = 
  'blog_administrator' |  // Full control over all blog posts, categories, and user roles
  'blog_editor' |        // Can publish, edit, and delete any author's posts. Can manage categories
  'blog_author' |        // Can create, edit, publish, and delete their own blog posts
  'blog_contributor';    // Can write and save blog posts as drafts, cannot publish

// Extended user role that includes blog permissions
export type ExtendedUserRole = UserRole | BlogRole;

// Blog permissions mapping
export interface BlogPermission {
  canCreate: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canDelete: boolean;
  canManageCategories: boolean;
  canManageAuthors: boolean;
  canModerate: boolean;
}

// Blog role to permission mapping
export const BLOG_ROLE_PERMISSIONS: Record<BlogRole, BlogPermission> = {
  blog_administrator: {
    canCreate: true,
    canEdit: true,
    canPublish: true,
    canDelete: true,
    canManageCategories: true,
    canManageAuthors: true,
    canModerate: true,
  },
  blog_editor: {
    canCreate: true,
    canEdit: true,
    canPublish: true,
    canDelete: true,
    canManageCategories: true,
    canManageAuthors: false,
    canModerate: true,
  },
  blog_author: {
    canCreate: true,
    canEdit: true,
    canPublish: true,
    canDelete: true,
    canManageCategories: false,
    canManageAuthors: false,
    canModerate: false,
  },
  blog_contributor: {
    canCreate: true,
    canEdit: true,
    canPublish: false,
    canDelete: false,
    canManageCategories: false,
    canManageAuthors: false,
    canModerate: false,
  },
};

// Map organizational roles to blog permissions
export const ORG_ROLE_BLOG_PERMISSIONS: Partial<Record<UserRole, BlogPermission>> = {
  superadmin: BLOG_ROLE_PERMISSIONS.blog_administrator,
  president_national: BLOG_ROLE_PERMISSIONS.blog_administrator,
  vice_president: BLOG_ROLE_PERMISSIONS.blog_editor,
  general_secretary: BLOG_ROLE_PERMISSIONS.blog_editor,
  projects_director: BLOG_ROLE_PERMISSIONS.blog_author,
  marketing_head: BLOG_ROLE_PERMISSIONS.blog_author,
  advisor: BLOG_ROLE_PERMISSIONS.blog_editor,
  chair_projects: BLOG_ROLE_PERMISSIONS.blog_author,
  chair_marketing: BLOG_ROLE_PERMISSIONS.blog_author,
  chair_outreach: BLOG_ROLE_PERMISSIONS.blog_author,
  chair_design: BLOG_ROLE_PERMISSIONS.blog_author,
  member: BLOG_ROLE_PERMISSIONS.blog_contributor,
};

/**
 * Get blog permissions for a user based on their role
 */
export function getBlogPermissions(userRole: UserRole | null): BlogPermission {
  if (!userRole) {
    return {
      canCreate: false,
      canEdit: false,
      canPublish: false,
      canDelete: false,
      canManageCategories: false,
      canManageAuthors: false,
      canModerate: false,
    };
  }

  // Check if user has explicit blog role
  const blogRolePermissions = ORG_ROLE_BLOG_PERMISSIONS[userRole];
  if (blogRolePermissions) {
    return blogRolePermissions;
  }

  // Default permissions based on role hierarchy
  if (userRole === 'superadmin' || userRole === 'president_national') {
    return BLOG_ROLE_PERMISSIONS.blog_administrator;
  } else if (userRole === 'vice_president' || userRole === 'general_secretary' || userRole === 'advisor') {
    return BLOG_ROLE_PERMISSIONS.blog_editor;
  } else if (userRole === 'projects_director' || userRole === 'marketing_head' || 
             userRole === 'chair_projects' || userRole === 'chair_marketing' || 
             userRole === 'chair_outreach' || userRole === 'chair_design') {
    return BLOG_ROLE_PERMISSIONS.blog_author;
  } else {
    return BLOG_ROLE_PERMISSIONS.blog_contributor;
  }
}

/**
 * Check if a user can perform a specific blog action
 */
export function canPerformBlogAction(
  userRole: UserRole | null,
  action: 'create' | 'edit' | 'publish' | 'delete' | 'manageCategories' | 'manageAuthors' | 'moderate',
  authorId?: string,
  userId?: string
): boolean {
  const permissions = getBlogPermissions(userRole);
  
  // Map action to permission key
  const actionMap = {
    create: 'canCreate',
    edit: 'canEdit',
    publish: 'canPublish',
    delete: 'canDelete',
    manageCategories: 'canManageCategories',
    manageAuthors: 'canManageAuthors',
    moderate: 'canModerate',
  } as const;

  // Check basic permission
  if (!permissions[actionMap[action]]) {
    return false;
  }

  // For actions that require ownership (edit, delete), check if user owns the content
  if ((action === 'edit' || action === 'delete') && authorId && userId) {
    return permissions[actionMap[action]] && (authorId === userId || permissions.canManageAuthors);
  }

  // For other actions, use the permission directly
  return permissions[actionMap[action]];
}

/**
 * Check if a user is a blog administrator
 */
export function isBlogAdministrator(userRole: UserRole | null): boolean {
  const permissions = getBlogPermissions(userRole);
  return permissions.canManageAuthors && permissions.canManageCategories;
}

/**
 * Check if a user is a blog editor or above
 */
export function isBlogEditorOrAbove(userRole: UserRole | null): boolean {
  const permissions = getBlogPermissions(userRole);
  return permissions.canEdit && permissions.canPublish;
}

/**
 * Check if a user can publish blog posts
 */
export function canPublishBlogPosts(userRole: UserRole | null): boolean {
  const permissions = getBlogPermissions(userRole);
  return permissions.canPublish;
}

/**
 * Get the appropriate blog role for display
 */
export function getBlogRoleDisplayName(userRole: UserRole | null): string {
  if (!userRole) return 'Guest';
  
  const permissions = getBlogPermissions(userRole);
  
  if (permissions.canManageAuthors && permissions.canManageCategories) {
    return 'Blog Administrator';
  } else if (permissions.canPublish && permissions.canEdit) {
    return 'Blog Editor';
  } else if (permissions.canCreate) {
    return 'Blog Author';
  } else {
    return 'Blog Contributor';
  }
}

/**
 * Determine if a user role should have access to blog management features
 */
export function hasBlogManagementAccess(userRole: UserRole | null): boolean {
  return isBlogEditorOrAbove(userRole);
}

/**
 * Determine if a user role should have access to blog creation
 */
export function hasBlogCreationAccess(userRole: UserRole | null): boolean {
  const permissions = getBlogPermissions(userRole);
  return permissions.canCreate;
}