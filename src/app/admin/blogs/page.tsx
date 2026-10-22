import { redirect } from 'next/navigation';

// Blog admin lives under the singular /admin/blog section.
// This plural route is kept only as a redirect for old links/bookmarks.
export default function AdminBlogsRedirectPage() {
  redirect('/admin/blog');
}
