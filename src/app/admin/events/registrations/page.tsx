import { redirect } from 'next/navigation';

/**
 * Attendee management is now the "Attendees" tab of the per-event
 * detail view (/admin/events/[id]?tab=attendees). This route stays
 * alive as a redirect so bookmarks and older links land on the right
 * tab of the right event.
 */
export default async function EventRegistrationsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ eventId?: string }>;
}) {
  const { eventId } = await searchParams;
  redirect(eventId ? `/admin/events/${eventId}?tab=attendees` : '/admin/events');
}
