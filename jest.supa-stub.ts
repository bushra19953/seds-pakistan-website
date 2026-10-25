/**
 * Test stub for '@/lib/supa' (the Supabase adapter), wired in through
 * jest.config.js moduleNameMapper on this base branch ONLY.
 *
 * Why this exists: the supa-events seams bind to the adapter STATICALLY
 * (E3 form: `import { getSupaAdapter, getSupaClient, useSupa } from
 * '@/lib/supa'`), but src/lib/supa does not exist on this branch — it
 * lands as merge step 0 from feat/supa-adapter. Without a resolvable
 * module, every suite that loads a seam (including the pre-existing
 * registration route suites, which know nothing about Supabase) fails
 * module resolution.
 *
 * This stub is the safe default: surface flags follow SUPA_SURFACES
 * (comma list, '*' = all, case-insensitive — the adapter's semantics;
 * default OFF) and no client is configured, so seams report
 * "unavailable" and callers run Firestore byte-identically. Suites that
 * exercise the flag-on path declare their own jest.mock('@/lib/supa')
 * factory, which overrides this mapper entry.
 *
 * MERGE TIME: when feat/supa-adapter lands, delete this file and its
 * moduleNameMapper line in jest.config.js; the seams then bind to the
 * real adapter with no code change.
 */

export function useSupa(surface: string): boolean {
  const raw = process.env.SUPA_SURFACES;
  if (!raw) return false;
  const surfaces = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return surfaces.includes('*') || surfaces.includes(String(surface).toLowerCase());
}

export function getSupaClient(): null {
  return null;
}

export function getSupaAdapter(): never {
  throw new Error('jest.supa-stub: no adapter configured (mock @/lib/supa in the suite)');
}
