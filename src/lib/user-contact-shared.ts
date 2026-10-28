/**
 * user-contact-shared.ts — the contact record's shape and projection,
 * shared by the server doorway (src/lib/server/user-contact.ts) and the
 * client owner leg (src/lib/client/user-contact.ts). This module must
 * stay free of server-only and client-only imports: both bundles import
 * it.
 *
 * A user's contact fields live ONLY in the gated document
 * `users/{uid}/private/contact`; the public user document carries none
 * (security audit 2026-10-28, item 6 residual).
 */

/** Field names that make up the contact record, in storage order. */
export const CONTACT_FIELD_NAMES = [
  'email',
  'email_lowercase',
  'whatsapp',
  'whatsappNumber',
  'phone',
  'phoneNumber',
  'contactNumber',
  'cnic',
  'address',
] as const;

export type ContactFieldName = (typeof CONTACT_FIELD_NAMES)[number];

export interface UserContact {
  email?: string;
  email_lowercase?: string;
  whatsapp?: string;
  whatsappNumber?: string;
  phone?: string;
  phoneNumber?: string;
  contactNumber?: string;
  cnic?: string;
  address?: string;
}

function asCleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project an arbitrary record (a user document, a request payload, a
 * stored contact document) down to the contact fields it carries. Empty
 * and non-string values are dropped. The whatsapp/whatsappNumber alias
 * pair is mirrored: when exactly one spelling is present, the other is
 * filled with the same value, preserving the `whatsapp || whatsappNumber`
 * convention every reader already uses. email_lowercase is derived from
 * email whenever email is present, so writers never maintain it by hand.
 */
export function pickContactFields(source: Record<string, unknown> | null | undefined): UserContact {
  const out: UserContact = {};
  if (!source) return out;
  for (const name of CONTACT_FIELD_NAMES) {
    const value = asCleanString(source[name]);
    if (value !== undefined) out[name] = value;
  }
  if (out.whatsapp && !out.whatsappNumber) out.whatsappNumber = out.whatsapp;
  if (out.whatsappNumber && !out.whatsapp) out.whatsapp = out.whatsappNumber;
  if (out.email) out.email_lowercase = out.email.toLowerCase();
  return out;
}

/** True when a projected contact record carries at least one field. */
export function hasContactFields(contact: UserContact): boolean {
  return Object.keys(contact).length > 0;
}

/**
 * Return a copy of a record with every contact field removed. Used by
 * server routes that load a whole user record for other purposes and
 * must never serialize contact data sourced from the public document
 * (post-move there is none; this keeps that true even for legacy rows
 * that have not been stripped yet).
 */
export function stripContactFields<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = { ...record };
  for (const name of CONTACT_FIELD_NAMES) delete out[name];
  return out as T;
}
