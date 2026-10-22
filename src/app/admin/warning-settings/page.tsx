import { redirect } from 'next/navigation';

// Warning settings merged into the single Discipline Settings screen
// in the discipline hub. This route is kept only as a redirect for
// old links/bookmarks.
export default function AdminWarningSettingsRedirectPage() {
  redirect('/admin/discipline?tab=settings');
}
