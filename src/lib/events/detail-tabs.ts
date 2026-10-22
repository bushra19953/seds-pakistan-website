// Tab logic for the per-event detail view (/admin/events/[id]).
//
// The detail view folds the two former per-event subroutes into one
// page: registrations (?eventId=) is now the Attendees tab and
// profit-split (?id=) is now the Settlement tab. The old URLs redirect
// here with ?tab= set, so deep links and bookmarks keep landing on the
// right view; Overview is the landing tab when nothing is named.

export type EventDetailTab = 'overview' | 'attendees' | 'settlement';

export const EVENT_DETAIL_TABS: readonly EventDetailTab[] = ['overview', 'attendees', 'settlement'];

export const DEFAULT_EVENT_DETAIL_TAB: EventDetailTab = 'overview';

/** Resolve a raw ?tab= value to a detail tab; anything unknown is Overview. */
export function resolveEventDetailTab(raw: string | null | undefined): EventDetailTab {
  return (EVENT_DETAIL_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as EventDetailTab)
    : DEFAULT_EVENT_DETAIL_TAB;
}
