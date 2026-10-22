import { redirect } from 'next/navigation';

/**
 * The standalone Orders page was folded into Store Central Command
 * (admin nav audit, slice 21): its certificate fulfilment view — list,
 * Mark Paid (order_mark_paid maker-checker request), Mark Printed and
 * Mark Shipped — now lives in the Store Orders tab, pre-filtered to
 * certificates. This route stays as a redirect for old bookmarks.
 */
export default function AdminOrdersPage() {
  redirect('/admin/store?tab=orders&view=certificates');
}
