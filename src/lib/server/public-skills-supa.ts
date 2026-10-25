/**
 * Public skills route -> Supabase seam (migration step 6 scope: the
 * READ half of the public skills route only).
 *
 * The skills DATA writes (admin skills UI, grant paths, the legacy
 * seed) belong to step 8 (Cluster G) and are NOT mirrored here. This
 * seam serves exactly one read: the full `skills` list behind
 * GET /api/public/skills, whose filtering/sorting stays in the route,
 * unchanged, over whichever source served the rows.
 *
 * Gate: useSupa('public-skills') && getSupaClient() (default OFF).
 *
 * Fallback protocol (three-way, deliberate):
 *  - flag OFF / client unconfigured / adapter error -> 'fallback':
 *    the route runs its existing Firestore path, including the
 *    legacy-seed-on-empty behavior, byte-identically.
 *  - adapter answers with rows -> 'ok': the route filters/sorts those
 *    rows exactly as it does Firestore rows.
 *  - adapter answers EMPTY -> 'fallback': an empty Supabase list most
 *    likely means the bulk load has not landed for this collection,
 *    and falling back preserves the route's never-blank contract
 *    (Firestore path seeds the 18 legacy skills when empty). This is
 *    why this surface is NOT flip-ready until the skills bulk load
 *    exists — see the build report.
 */
import { getSupaAdapter, getSupaClient, useSupa } from '@/lib/supa';
import type { SupaDoc } from '@/lib/supa';

export const PUBLIC_SKILLS_SUPA_SURFACE = 'public-skills';
export const SKILLS_COLLECTION = 'skills';

export function publicSkillsSupaEnabled(): boolean {
  try {
    return useSupa(PUBLIC_SKILLS_SUPA_SURFACE) && !!getSupaClient();
  } catch {
    return false;
  }
}

export type PublicSkillsRead =
  | { status: 'fallback' }
  | { status: 'ok'; docs: SupaDoc[] };

export async function readPublicSkillsViaSupa(): Promise<PublicSkillsRead> {
  if (!publicSkillsSupaEnabled()) return { status: 'fallback' };
  try {
    const docs = await getSupaAdapter().listDocs(SKILLS_COLLECTION);
    if (docs.length === 0) return { status: 'fallback' };
    return { status: 'ok', docs };
  } catch (err) {
    console.error('[public-skills-supa] adapter read failed, falling back to Firestore:', err);
    return { status: 'fallback' };
  }
}
