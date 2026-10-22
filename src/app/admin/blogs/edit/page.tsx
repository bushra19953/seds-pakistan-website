import { redirect } from 'next/navigation';

// The edit editor moved to /admin/blog/edit and keeps the ?id= query-param
// shape, so old links like /admin/blogs/edit?id=<id> land on the same post.
export default async function AdminBlogsEditRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  redirect(id ? `/admin/blog/edit?id=${encodeURIComponent(id)}` : '/admin/blog');
}
