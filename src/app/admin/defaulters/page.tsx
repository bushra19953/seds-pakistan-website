import { redirect } from 'next/navigation';

// The warnings register lives in the discipline hub now.
// This route is kept only as a redirect for old links/bookmarks.
export default function AdminDefaultersRedirectPage() {
  redirect('/admin/discipline?tab=register');
}
