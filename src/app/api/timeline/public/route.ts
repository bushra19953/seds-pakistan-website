import { NextRequest, NextResponse } from "next/server";
import {
  listTimelineFull,
  listTimelineTeaser,
  toPublicJson,
} from "@/lib/supa-timeline/public-timeline";

/**
 * Public Supabase read route for the timeline surfaces (homepage
 * teaser + /timeline page; seam: src/lib/supa-timeline/public-timeline.ts).
 *
 * GET ?variant=full|teaser — serves the matching read from
 * fs_timeline when the 'timeline' surface is enabled server-side.
 * When the surface is off or Supabase is unavailable it answers
 * 503 { error: "supa_unavailable" } and the client silently keeps
 * its Firestore data: flag OFF is exactly the pre-seam behavior
 * (the events E5 flag-off fallback contract).
 *
 * No auth: the timeline is anonymous-readable in Firestore today,
 * so a service-role server route serving published-only rows
 * reproduces that exposure exactly.
 *
 * Response: a plain JSON array of normalized docs (id + fields)
 * with timestamps serialized to ISO-8601 strings (toPublicJson) —
 * no envelope, so the component only changes its fetch code.
 */

const VIEWS = {
  full: listTimelineFull,
  teaser: listTimelineTeaser,
} as const;

type PublicTimelineView = keyof typeof VIEWS;

export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get("variant") || "full";
  // Own-key check only: a plain VIEWS[view] lookup would resolve
  // inherited Object.prototype members (?variant=toString answered
  // 200 in the events route before this fix was applied there).
  const loader = Object.hasOwn(VIEWS, view) ? VIEWS[view as PublicTimelineView] : undefined;
  if (!loader) {
    return NextResponse.json({ error: "Unknown view" }, { status: 400 });
  }
  const rows = await loader();
  if (!rows) {
    return NextResponse.json({ error: "supa_unavailable" }, { status: 503 });
  }
  return NextResponse.json(toPublicJson(rows));
}
