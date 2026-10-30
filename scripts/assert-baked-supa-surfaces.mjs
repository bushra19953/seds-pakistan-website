/**
 * assert-baked-supa-surfaces.mjs — baked-flag parity gate
 * (read-bleed train 2, 2026-10-30).
 *
 * WHY THIS EXISTS: client surface gates read the BUILD-TIME-baked
 * NEXT_PUBLIC_SUPA_SURFACES literal inlined into the client chunks.
 * On 2026-10-29 the P1 bundle's build env silently lost the
 * `applications` token, so /admin/applications ran its old ~76-read
 * Firestore listener for 9.2 hours while every bundle trap check
 * passed — no check asserted the baked literal. This script is that
 * check. Run it against the built chunks BEFORE assembling a bundle
 * and again against the assembled bundle's chunks:
 *
 *   node scripts/assert-baked-supa-surfaces.mjs [chunksDir]
 *   (default chunksDir: .next/static/chunks)
 *
 * Exit 0 = every INTENDED token is present in the baked literal.
 * Exit 1 = no surfaces literal found, or an intended token is
 * missing (the exact failure that shipped on 2026-10-29).
 *
 * THE INTENDED SET is deliberate, not "every token the client gate
 * checks". Tokens are added here only when a flip has been verified
 * seam-ready (see ~/workspace/known_issues/READ_BLEED_TRAIN2_LOG.md
 * for the per-token evidence). Deliberately NOT baked today:
 *   - live-authority — the R1 Role Registry conversion token; a
 *     founder decision, not a bundle accident waiting to happen.
 *   - inbox, projects, elections, events-admin — never baked
 *     historically; each flip needs its own seam-readiness proof.
 * WARNING: `roles` is baked in NEXT_PUBLIC_SUPA_SURFACES ONLY. Never
 * add it to NEXT_PUBLIC_SUPA_PRIMARY in the same motion: four role
 * write flows re-key on rolesSupaPrimary() and would flip from
 * dual-write to adapter-only with no Firestore fallback
 * (src/lib/supa-roles-client-seam.ts:81-95,105-113).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const INTENDED_CLIENT_SUPA_SURFACES = [
  'announcements',
  'admin-audit',
  'admin-analytics',
  'live-admin',
  'forms',
  'resources',
  'crm',
  'events',
  'applications', // restored: silently lost by the 2026-10-29 P1 build
  'notifications', // census 08: bake-ready (route-written in both branches)
  'roles', // census 03/providers: surfaces-only bake-ready; primacy twin held
  'live-chat', // census 06: conversion complete; token was the only gate
];

/** Every token any client gate in the tree checks (parity census). */
export const KNOWN_CLIENT_SUPA_TOKENS = [
  ...INTENDED_CLIENT_SUPA_SURFACES,
  'live-authority',
  'inbox',
  'projects',
  'elections',
  'events-admin',
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith('.js')) yield path;
  }
}

export function extractBakedSurfaces(chunksDir) {
  const known = new Set(KNOWN_CLIENT_SUPA_TOKENS);
  const baked = new Set();
  const literals = new Set();
  for (const file of walk(chunksDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)+/g)) {
      const parts = match[0].split(',');
      const hits = parts.filter((p) => known.has(p));
      // A surfaces literal is a comma list dominated by known tokens;
      // the >=3-known-token bar keeps minified noise out.
      if (hits.length >= 3) {
        literals.add(match[0]);
        for (const p of parts) baked.add(p);
      }
    }
  }
  return { baked, literals };
}

export function assertBakedSurfaces(chunksDir) {
  const { baked, literals } = extractBakedSurfaces(chunksDir);
  const missing = INTENDED_CLIENT_SUPA_SURFACES.filter((t) => !baked.has(t));
  return { ok: literals.size > 0 && missing.length === 0, missing, baked, literals };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunksDir = process.argv[2] ?? '.next/static/chunks';
  const { ok, missing, baked, literals } = assertBakedSurfaces(chunksDir);
  if (literals.size === 0) {
    console.error(`PARITY FAIL: no NEXT_PUBLIC_SUPA_SURFACES literal found under ${chunksDir}`);
    process.exit(1);
  }
  console.log(`baked literals found: ${[...literals].join(' | ')}`);
  console.log(`baked set: ${[...baked].sort().join(',')}`);
  if (!ok) {
    console.error(`PARITY FAIL: intended token(s) missing from the baked literal: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('PARITY OK: every intended client surface token is baked.');
}
