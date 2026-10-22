/**
 * People admin hub tabs (/admin/users).
 *
 * The Users, Roles, and Role Privileges surfaces were unified into one
 * page: the Directory tab is the full user management table, and the
 * Role Registry tab is the role catalog that used to live on
 * /admin/roles (which now redirects to /admin/users?tab=roles).
 */
export type PeopleHubTab = 'directory' | 'roles';

export function resolvePeopleHubTab(raw: string | null | undefined): PeopleHubTab {
  return raw === 'roles' ? 'roles' : 'directory';
}

export function peopleHubTabUrl(tab: PeopleHubTab): string {
  return tab === 'roles' ? '/admin/users?tab=roles' : '/admin/users';
}
