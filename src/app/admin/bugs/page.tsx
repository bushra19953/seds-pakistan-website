import { redirect } from 'next/navigation';

// Issue Hub merged into /admin/bug-reports (same bug_reports collection;
// bug-reports is the superset: admin notes, points bounty, delete, stats).
export default function AdminBugsRedirectPage() {
  redirect('/admin/bug-reports');
}
