import { redirect } from 'next/navigation';

// The create editor moved to /admin/blog/new; keep the old URL working.
export default function AdminBlogsNewRedirectPage() {
  redirect('/admin/blog/new');
}
