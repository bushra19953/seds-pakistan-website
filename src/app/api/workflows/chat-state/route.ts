import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';

/**
 * Token-verified polling route for the Class C chat listener
 * conversions (listeners-ce, surface `live-chat`).
 *
 * Serves, in one bounded fetch, the three Firestore listener payloads
 * of `src/components/workflow/enhanced-workflow-chat.tsx`:
 *   - B17 messages: `messages` where workflowId == ? AND
 *     participantIds array-contains <caller uid>, orderBy createdAt
 *     asc, NO limit — exactly the listener's query. (The full thread
 *     is re-read per poll; that cost is named in the listeners-ce
 *     section report as a flip consideration for the `live-chat`
 *     flag, the same accepted-cost family as the dashboard A3 poll.)
 *   - A19 typing: `workflow_typing` where workflowId == ? AND, when
 *     the caller passes its participant hint, userId in first-10 ids.
 *   - A20 presence: `workflow_presence`, same shape as typing.
 * The dormant WorkflowVisualizer's A18 presence listener polls this
 * route with NO participant hint, matching its unfiltered-by-user
 * Firestore query.
 *
 * Identity law: the caller's uid comes ONLY from the verified
 * Firebase token (verifyAuthentication; Bearer or __session cookie).
 * The messages membership filter is applied against that uid
 * server-side. The `participants` query param is the same UI filter
 * hint the client Firestore queries use (first-10 `userId in` for
 * typing/presence); it is never an identity and grants nothing.
 *
 * Backend selection, per request (the missions-route pattern):
 *   useSupa('workflows') && getSupaClient() -> Supabase adapter
 *     (fs_messages / fs_workflow_typing / fs_workflow_presence);
 *   otherwise, or on any adapter error -> Admin-SDK Firestore with
 *     the listener's exact queries.
 * Response shape is the useCollection/onSnapshot shape the listeners
 * feed: arrays of `{ ...docData, id }` with timestamps serialized to
 * ISO strings. The browser never reads Supabase directly (no-RLS
 * program law) and never subscribes on the ON path.
 */

export const dynamic = 'force-dynamic';

interface SupaAdapterLike {
  listDocs(
    collection: string,
    options?: {
      where?: [string, string, unknown][];
      orderBy?: { field: string; direction?: 'asc' | 'desc' };
    },
  ): Promise<Record<string, unknown>[]>;
}

interface SupaModuleLike {
  useSupa(surface: string): boolean;
  getSupaClient(): unknown | null;
  getSupaAdapter(): SupaAdapterLike;
}

function loadSupa(): SupaModuleLike | null {
  try {
    // STATIC import (live-defect fix, same class as /api/roles/reads):
    // the previous webpackIgnore dynamic import of the '@/lib/supa'
    // alias never resolved in the standalone server bundle, so this
    // loader always returned null in production. Failure semantics
    // are unchanged: supaAdapter() below still gates on useSupa +
    // getSupaClient and converts any throw to null, and
    // getSupaAdapter() over an unconfigured client returns an adapter
    // whose calls throw SupaUnavailableError into that try/catch.
    if (typeof useSupa !== 'function' || typeof getSupaAdapter !== 'function') {
      return null;
    }
    return {
      useSupa,
      getSupaClient: () => getSupaClient(),
      getSupaAdapter: () => getSupaAdapter() as unknown as SupaAdapterLike,
    };
  } catch {
    return null;
  }
}

async function supaAdapter(): Promise<SupaAdapterLike | null> {
  const mod = await loadSupa();
  if (!mod) return null;
  try {
    if (!mod.useSupa('workflows')) return null;
    if (!mod.getSupaClient()) return null;
    return mod.getSupaAdapter();
  } catch {
    return null;
  }
}

/** Firestore values -> JSON-plain: Timestamps/Dates become ISO strings. */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = row;
  return { ...(serializeValue(rest) as Record<string, unknown>), id };
}

export interface ChatStatePayload {
  messages: Array<Record<string, unknown>>;
  typing: Array<Record<string, unknown>>;
  presence: Array<Record<string, unknown>>;
}

async function chatStateViaSupa(
  adapter: SupaAdapterLike,
  workflowId: string,
  uid: string,
  participantIds: string[],
): Promise<ChatStatePayload> {
  const ephemeralWhere: [string, string, unknown][] = [
    ['workflowId', '==', workflowId],
    ...(participantIds.length
      ? [['userId', 'in', participantIds] as [string, string, unknown]]
      : []),
  ];
  const [messages, typing, presence] = await Promise.all([
    adapter.listDocs('messages', {
      where: [
        ['workflowId', '==', workflowId],
        ['participantIds', 'array-contains', uid],
      ],
      orderBy: { field: 'createdAt', direction: 'asc' },
    }),
    adapter.listDocs('workflow_typing', { where: ephemeralWhere }),
    adapter.listDocs('workflow_presence', { where: ephemeralWhere }),
  ]);
  return {
    messages: messages.map(serializeRow),
    typing: typing.map(serializeRow),
    presence: presence.map(serializeRow),
  };
}

async function chatStateViaFirestore(
  workflowId: string,
  uid: string,
  participantIds: string[],
): Promise<ChatStatePayload | null> {
  const db = getDb();
  if (!db) return null;

  const messagesQuery = db
    .collection('messages')
    .where('workflowId', '==', workflowId)
    .where('participantIds', 'array-contains', uid)
    .orderBy('createdAt', 'asc');

  let typingQuery = db.collection('workflow_typing').where('workflowId', '==', workflowId);
  if (participantIds.length) typingQuery = typingQuery.where('userId', 'in', participantIds);

  let presenceQuery = db
    .collection('workflow_presence')
    .where('workflowId', '==', workflowId);
  if (participantIds.length) presenceQuery = presenceQuery.where('userId', 'in', participantIds);

  const [messagesSnap, typingSnap, presenceSnap] = await Promise.all([
    messagesQuery.get(),
    typingQuery.get(),
    presenceQuery.get(),
  ]);

  const toRows = (snap: FirebaseFirestore.QuerySnapshot): Array<Record<string, unknown>> =>
    snap.docs.map((d) => serializeRow({ ...(d.data() as Record<string, unknown>), id: d.id }));

  return {
    messages: toRows(messagesSnap),
    typing: toRows(typingSnap),
    presence: toRows(presenceSnap),
  };
}

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(req: NextRequest) {
  if (!ensureAdminInitialized()) return bad(500, 'Server misconfiguration');
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return bad(401, 'Unauthorized');
  const uid = auth.user.userId;

  const workflowId = req.nextUrl.searchParams.get('workflowId') ?? '';
  if (!workflowId) return bad(400, 'Missing workflowId');
  const participantsRaw = req.nextUrl.searchParams.get('participants') ?? '';
  const participantIds = participantsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  try {
    const adapter = await supaAdapter();
    if (adapter) {
      try {
        return NextResponse.json(await chatStateViaSupa(adapter, workflowId, uid, participantIds));
      } catch (err) {
        console.error('[api/workflows/chat-state] adapter read failed, falling back to Firestore:', err);
      }
    }
    const payload = await chatStateViaFirestore(workflowId, uid, participantIds);
    if (!payload) return bad(500, 'Read failed');
    return NextResponse.json(payload);
  } catch (err) {
    console.error('[api/workflows/chat-state] GET failed:', err);
    return bad(500, 'Read failed');
  }
}
