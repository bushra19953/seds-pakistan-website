'use client';

/**
 * crm-supa-client — the client-side half of the Cluster F (CRM) seam.
 *
 * Browser code may import ONLY this module from the CRM seam: it holds
 * no adapter import (the service_role key must never ship to the
 * browser). When the NEXT_PUBLIC 'crm' hint is ON, client surfaces read
 * partners through GET /api/admin/partners/list, which re-checks the
 * server flag useSupa('crm') and answers 503 when it is off — a stale
 * or forged hint can never widen access. ANY failure (503, network,
 * non-OK) reports `failed` and the caller falls back to its Firestore
 * read byte-identically.
 *
 * Shape: the Firestore path runs rows through the partners converter
 * (src/lib/partners.ts fromFirestore), which fills related-party
 * defaults, forces financials currency 'PKR', maps legacy
 * interactionHistory onto timeline, and derives lastActivityAt. The API
 * returns raw stored rows, so toPartnerRecordShape re-applies exactly
 * those defaults here; timestamps arrive as ISO strings, which the CRM
 * surfaces' safeDate() already accepts (string branch).
 */

import { useEffect, useRef, useState } from 'react';
import { isClientSupaSurfaceOn } from '@/lib/client-supa-flags';
import type { PartnerRecord } from '@/lib/partners';

export const CRM_CLIENT_SURFACE = 'crm';

/** Client hint: NEXT_PUBLIC_SUPA_SURFACES lists 'crm'. Read at call time. */
export function crmSupaClientEnabled(): boolean {
  return isClientSupaSurfaceOn(CRM_CLIENT_SURFACE);
}

/**
 * Re-apply the partners converter's defaults to a raw stored row, so a
 * seam-served record is indistinguishable in shape from a
 * converter-served one. Pure; exported for contracts.
 */
export function toPartnerRecordShape(raw: Record<string, any>): PartnerRecord {
  const interactionHistory = Array.isArray(raw.interactionHistory)
    ? raw.interactionHistory
    : typeof raw.interactionHistory === 'string' && raw.interactionHistory.trim() !== ''
      ? [{ note: String(raw.interactionHistory), author: 'system', timestamp: null }]
      : [];
  return {
    ...raw,
    id: raw.id,
    organizationName: raw.organizationName,
    financials: raw.financials
      ? { ...raw.financials, currency: 'PKR' as const }
      : raw.financials,
    isRelatedParty: raw.isRelatedParty === true,
    isFounderCommercialEntity: raw.isFounderCommercialEntity ?? false,
    relatedParty: raw.relatedParty ?? null,
    interactionHistory,
    timeline:
      raw.timeline ||
      (Array.isArray(raw.interactionHistory)
        ? raw.interactionHistory.map((h: any, idx: number) => ({
            id: `legacy-${idx}`,
            type: 'note',
            direction: 'sent',
            content: h?.note || '',
            timestamp: h?.timestamp || null,
            author: h?.author || 'Legacy',
          }))
        : []),
    lastActivityAt:
      raw.lastActivityAt ||
      (raw.updatedAt ? new Date(raw.updatedAt).toISOString() : new Date().toISOString()),
    lastActivityType: raw.lastActivityType || 'System Update',
    nextActions: Array.isArray(raw.nextActions) ? raw.nextActions : [],
    carriesConditions: raw.carriesConditions === true,
  } as PartnerRecord;
}

async function fetchPartnersViaApi(opts?: {
  status?: string | null;
}): Promise<PartnerRecord[]> {
  const { getAuth } = await import('firebase/auth');
  const currentUser = getAuth().currentUser;
  if (!currentUser) throw new Error('Not signed in');
  const token = await currentUser.getIdToken();
  const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : '';
  const res = await fetch(`/api/admin/partners/list${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`partners list failed (${res.status})`);
  const body = (await res.json()) as { partners?: Array<Record<string, any>> };
  if (!Array.isArray(body.partners)) throw new Error('partners list: bad shape');
  return body.partners.map(toPartnerRecordShape);
}

/**
 * One-shot whole-collection fetch through the seam route (sponsor-match
 * panel). Throws on any failure; the caller falls back to Firestore.
 */
export async function fetchAllPartnersViaCrmSeam(opts?: {
  status?: string | null;
}): Promise<PartnerRecord[]> {
  return fetchPartnersViaApi(opts);
}

/* ------------------------------------------------------------ events */

/**
 * The CRM page's associated-events read rides the E5 admin-events
 * seam (surface 'events-admin', fs_events mirrors): when this hint is
 * ON the page calls GET /api/admin/events/list, which re-checks the
 * server flag and answers 503 when it is off. ANY failure falls back
 * to the page's bounded Firestore fetch. The page consumes only
 * id + title (picker options, associated-event badges), so seam rows
 * (timestamps as ISO strings on the wire) render identically.
 */
export const CRM_EVENTS_SURFACE = 'events-admin';

/** Client hint: NEXT_PUBLIC_SUPA_SURFACES lists 'events-admin'. */
export function crmEventsSupaClientEnabled(): boolean {
  return isClientSupaSurfaceOn(CRM_EVENTS_SURFACE);
}

/**
 * Hard cap on the CRM page's Firestore events FALLBACK fetch. The
 * seam serves the whole collection (adapter keyset-paged, complete);
 * the fallback fires only when the seam is off or has failed, and the
 * cap bounds its worst-case Firestore cost per mount.
 */
export const CRM_EVENTS_FALLBACK_LIMIT = 1000;

/**
 * One-shot whole-collection events fetch through the admin-events
 * seam route. Throws on any failure; the caller falls back to its
 * bounded Firestore fetch.
 */
export async function fetchEventsViaCrmSeam(): Promise<Array<Record<string, any>>> {
  const { getAuth } = await import('firebase/auth');
  const currentUser = getAuth().currentUser;
  if (!currentUser) throw new Error('Not signed in');
  const token = await currentUser.getIdToken();
  const res = await fetch('/api/admin/events/list', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`events list failed (${res.status})`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('events list: bad shape');
  return body as Array<Record<string, any>>;
}

export interface CrmPartnersPoll {
  data: PartnerRecord[] | null;
  loading: boolean;
  failed: boolean;
}

/**
 * Polling read for the CRM list (listener B2 port: the unbounded
 * onSnapshot listener becomes token-verified polling of the seam route
 * — the listeners program's ruling: no browser realtime, movers poll).
 * When `enabled` is false the hook stays inert and the caller uses its
 * Firestore listener exactly as before.
 */
export function useCrmPartnersPoll(enabled: boolean, intervalMs = 30_000): CrmPartnersPoll {
  const [state, setState] = useState<CrmPartnersPoll>({
    data: null,
    loading: enabled,
    failed: false,
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) {
      setState({ data: null, loading: false, failed: false });
      return () => {
        aliveRef.current = false;
      };
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = async () => {
      try {
        const partners = await fetchPartnersViaApi();
        if (!aliveRef.current) return;
        setState({ data: partners, loading: false, failed: false });
      } catch {
        if (!aliveRef.current) return;
        setState((s) => ({ data: s.data, loading: false, failed: true }));
      }
    };
    void run();
    timer = setInterval(() => void run(), intervalMs);
    return () => {
      aliveRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return state;
}
