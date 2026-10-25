import { NextRequest, NextResponse } from "next/server";
import {
  listHomepageFeed,
  listPublicEvents,
  listWorkshops,
  toPublicJson,
} from "@/lib/supa-events/public-events";

/**
 * Public Supabase read route for the events list page and the two
 * homepage event sections (events cluster, E4; seam:
 * src/lib/supa-events/public-events.ts).
 *
 * GET ?view=list|workshops|feed — serves the matching read from
 * fs_events when the 'events' surface is enabled server-side. When
 * the surface is off or Supabase is unavailable it answers
 * 503 { error: "supa_unavailable" } and the client silently keeps
 * its Firestore data: flag OFF is exactly today's behavior (the
 * E5 flag-off fallback contract).
 *
 * No auth: firestore.rules gives events `allow read, list: if true`,
 * so these reads are anonymous-readable in Firestore today and a
 * service-role server route reproduces that exposure exactly.
 *
 * Response: a plain JSON array of normalized docs (id + fields) with
 * timestamps serialized to ISO-8601 strings (toPublicJson) — no
 * envelope, so components only change their fetch code.
 */

const VIEWS = {
  list: listPublicEvents,
  workshops: listWorkshops,
  feed: listHomepageFeed,
} as const;

type PublicEventsView = keyof typeof VIEWS;

export async function GET(request: NextRequest) {
  const view = (request.nextUrl.searchParams.get("view") || "list") as PublicEventsView;
  const loader = VIEWS[view];
  if (!loader) {
    return NextResponse.json({ error: "Unknown view" }, { status: 400 });
  }
  const rows = await loader();
  if (!rows) {
    return NextResponse.json({ error: "supa_unavailable" }, { status: 503 });
  }
  return NextResponse.json(toPublicJson(rows));
}
