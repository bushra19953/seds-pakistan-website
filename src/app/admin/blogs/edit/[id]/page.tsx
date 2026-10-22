import { redirect } from 'next/navigation';

// Path-param form of the old editor URL. The canonical editor selects the
// post by query param, so /admin/blogs/edit/<id> lands on
// /admin/blog/edit?id=<id>.
export default async function AdminBlogsEditByIdRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/admin/blog/edit?id=${encodeURIComponent(id)}`);
}
