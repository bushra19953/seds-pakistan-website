import type { EventVisibility } from '@/types/event';

/**
 * Public-page access guard for events (EV-P32).
 *
 * The public event detail page historically hid only unpublished and
 * deleted events; it never consulted the `visibility` field, so a
 * PUBLISHED members-only or private event rendered in full for any
 * visitor who had the address. This module is the single decision the
 * detail page and its OG-metadata data path now share.
 *
 * Visibility vocabulary (types/event.ts, admin event form):
 * - 'public'  — anyone may view. This is also the field's default:
 *   the form seeds and falls back to 'public' when the stored doc
 *   carries no value (event-form.tsx defaultValues / initialData),
 *   and no writer can store a value outside the enum (zod schema),
 *   so a missing or out-of-vocabulary value resolves to 'public'.
 * - 'members' — any signed-in account may view; anonymous visitors
 *   may not. Only 'public' + 'published' events are ever broadcast
 *   (admin/events/new/page.tsx), which confirms 'members' sits
 *   behind the sign-in boundary.
 * - 'private' — only the event's author and events admins may view.
 *   There is no broader audience for it anywhere in the codebase;
 *   the public page's existing author/admin concept (canEdit) is
 *   the matching signed-in state.
 *
 * Status gate (unchanged from the page's historical behaviour):
 * an event renders only when published (status 'published' or the
 * legacy published:true flag) and not soft-deleted.
 */

export interface EventAccessEvent {
    status?: string;
    published?: boolean;
    deleted?: boolean;
    visibility?: EventVisibility | string;
    authorUid?: string;
    createdByUid?: string;
    createdBy?: string;
}

export interface EventViewer {
    /** Signed-in user's uid, or null for an anonymous visitor. */
    uid: string | null;
    /** True when the viewer's role is chair_events or above. */
    isEventsAdmin: boolean;
}

export function getEventVisibility(event: EventAccessEvent | null | undefined): EventVisibility {
    const v = event?.visibility;
    return v === 'members' || v === 'private' ? v : 'public';
}

export function isEventPublished(event: EventAccessEvent | null | undefined): boolean {
    return !!event && (event.status === 'published' || event.published === true);
}

export function eventAuthorUid(event: EventAccessEvent | null | undefined): string | undefined {
    return event?.authorUid ?? event?.createdByUid ?? event?.createdBy;
}

/**
 * May this viewer see the event's content on the public detail page?
 * A false result must be rendered as the page's Not Found treatment
 * so the event's existence is not leaked.
 */
export function canViewEventOnPublicPage(
    event: EventAccessEvent | null | undefined,
    viewer: EventViewer,
): boolean {
    if (!event || !isEventPublished(event) || event.deleted === true) return false;

    const visibility = getEventVisibility(event);
    if (visibility === 'public') return true;
    if (!viewer.uid) return false;
    if (visibility === 'members') return true;

    // 'private': the author and events admins only.
    if (viewer.isEventsAdmin) return true;
    const authorUid = eventAuthorUid(event);
    return !!authorUid && authorUid === viewer.uid;
}

/**
 * May an anonymous server surface (OG/Twitter metadata) expose this
 * event's title, description, and image? That is exactly the
 * anonymous 'public' case; members/private/deleted/unpublished
 * events must present as generic, as if they were not there.
 */
export function isPubliclyExposableEvent(event: EventAccessEvent | null | undefined): boolean {
    return canViewEventOnPublicPage(event, { uid: null, isEventsAdmin: false });
}
