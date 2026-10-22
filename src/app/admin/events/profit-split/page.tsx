import { redirect } from 'next/navigation';

/**
 * The venue profit-split ledger is now the "Settlement" tab of the
 * per-event detail view (/admin/events/[id]?tab=settlement). This
 * route stays alive as a redirect so bookmarks and older links land
 * on the right tab of the right event.
 */
export default async function EventProfitSplitRedirect({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  redirect(id ? `/admin/events/${id}?tab=settlement` : '/admin/events');
}
