import { redirect } from 'next/navigation';

// Roles merged into the people-admin surface on /admin/users: the Role
// Registry is its second tab. This route is kept only as a redirect for
// old links/bookmarks (and the sidebar nav item, until nav is updated).
export default function AdminRolesRedirectPage() {
  redirect('/admin/users?tab=roles');
}
