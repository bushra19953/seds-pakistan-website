/**
 * Store settings read seam (Cluster M, Group 4) — server-only.
 *
 * Flag: useSupa('store-settings'). Serves exactly one document:
 * settings/payment_methods from fs_settings via adapter.getDoc.
 *
 * Result protocol so the caller can distinguish "fall back" from
 * "document missing":
 *  - { status: 'fallback' }            flag OFF / client unconfigured /
 *                                      adapter error -> caller serves the
 *                                      Firestore read.
 *  - { status: 'ok', data: <doc|null> } adapter answered; data is the raw
 *                                      document body ({ ...data }, no id —
 *                                      the shape snap.data() returns), or
 *                                      null when the doc does not exist.
 *
 * Writes: NONE. payment_methods changes go through the finance approvals
 * flow (destination_change) — MANUAL list, finance cluster. This read
 * must tolerate destinationMeta stamped by approvals: it returns the raw
 * body untouched, so stamped fields pass through to consumers, whose
 * existing merge behavior (checkout: raw set; certificate-settings:
 * merge over DEFAULT_METHODS_SETTINGS) is preserved by the action's
 * callers exactly as today.
 *
 * PRIMACY TOKEN CONTRACT (S-W5, store build): this slice has NO
 * store-owned write point. The only settings/payment_methods write is
 * finance's destination_change APPLY, which must consult
 * isSupaPrimary('store-settings') — the token is owned HERE; when ON
 * the apply writes fs_settings/payment_methods + destinationMeta
 * inside the finance approvals transaction, when OFF it writes
 * Firestore as today. S-W5 was EXECUTED BY THE FINANCE BUILD
 * (feat/supa-cut-finance-build, inside tx_finance_decide_money_
 * approval) and is deliberately NOT re-implemented in the store build;
 * the store-settings primacy token may flip only once that finance
 * build is merged.
 */

import { getSupaAdapter, getSupaClient, useSupa } from './index';

export const STORE_SETTINGS_SURFACE = 'store-settings';

export type PaymentMethodsRead =
  | { status: 'fallback' }
  | { status: 'ok'; data: Record<string, unknown> | null };

export async function readPaymentMethodsViaSupa(): Promise<PaymentMethodsRead> {
  if (!useSupa(STORE_SETTINGS_SURFACE)) return { status: 'fallback' };
  if (!getSupaClient()) return { status: 'fallback' };
  try {
    const doc = (await getSupaAdapter().getDoc('settings', 'payment_methods')) as Record<string, unknown> | null;
    if (!doc) return { status: 'ok', data: null };
    const { id: _id, ...data } = doc;
    return { status: 'ok', data };
  } catch (err) {
    console.error('[store-settings seam] adapter read failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}
