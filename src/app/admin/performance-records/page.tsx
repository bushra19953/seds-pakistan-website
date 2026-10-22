import { redirect } from 'next/navigation';

// Performance records live in the discipline hub now, as the gated
// Records tab. This route is kept only as a redirect for old
// links/bookmarks.
export default function AdminPerformanceRecordsRedirectPage() {
  redirect('/admin/discipline?tab=records');
}
