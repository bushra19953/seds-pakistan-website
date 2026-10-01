import { Firestore, collection, getDocs } from "firebase/firestore";
import { USER_ROLES, FOUNDER_UID } from "./roles";

export interface RoleOption {
  key: string;
  label: string;
}

/**
 * Unified Role Discovery Engine
 * ════════════════════════════
 * Merges hardcoded roles with dynamic Firestore definitions.
 * Favors database labels for standard slugs.
 * Case-insensitively de-duplicates to prevent UI clutter.
 */
export async function getUnifiedRoleOptions(firestore: Firestore, uid?: string): Promise<RoleOption[]> {
  try {
    // 1. Fetch Dynamic Definitions
    const defsSnap = await getDocs(collection(firestore, "roleDefinitions"));
    const fromDefinitions = defsSnap.empty
      ? []
      : defsSnap.docs.map((d) => {
          const data = d.data();
          return {
            key: normalizeRoleSlug(data?.slug || d.id || ""),
            label: String(data?.name || data?.slug || d.id || "").trim()
          };
        });

    // 2. Map Hardcoded Canonical Roles
    const canonical: RoleOption[] = Object.keys(USER_ROLES).map((k) => ({
      key: normalizeRoleSlug(k),
      label: USER_ROLES[k as keyof typeof USER_ROLES]
    }));

    // 3. Merge with Precedence (Database > Hardcoded)
    const map = new Map<string, RoleOption>();

    // Initial fill from hardcoded
    for (const opt of canonical) {
      if (!opt.key) continue;
      map.set(opt.key, opt);
    }

    // Overwrite/Augment from Database
    for (const opt of fromDefinitions) {
      if (!opt.key) continue;
      // Database definition always wins for the same slug
      map.set(opt.key, opt);
    }

    // 4. Final Processing: Show slugs in labels and sort
    const finalOptions: RoleOption[] = Array.from(map.values())
      .map(opt => ({
        key: opt.key,
        label: `${opt.label} (${opt.key})`
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    // 5. Dictator Rule: Filter out reserved roles for regular users
    const reserved = ['superadmin', 'president_national'];
    let result = finalOptions.filter(opt => !reserved.includes(opt.key));

    // If it is the Founder, we manually add reserved options to their display/filter options.
    if (uid === FOUNDER_UID) {
        result.unshift({ key: 'president_national', label: 'Pakistan President (president_national)' });
        result.unshift({ key: 'superadmin', label: 'Super Admin (superadmin)' });
    }

    // FINAL DE-DUPLICATION: Strictly enforce one entry per slug
    const finalMap = new Map<string, RoleOption>();
    for (const opt of result) {
      if (finalMap.has(opt.key)) continue;
      finalMap.set(opt.key, opt);
    }

    return Array.from(finalMap.values());
  } catch (e) {
    console.error("[UnifiedRoles] Failed to sync roles:", e);
    // Fallback to purely hardcoded
    const base = Object.keys(USER_ROLES).map((k) => ({
      key: k,
      label: USER_ROLES[k as keyof typeof USER_ROLES]
    }));
    
    const filtered = base.filter(opt => !['superadmin', 'president_national'].includes(opt.key));
    if (uid === FOUNDER_UID) {
        filtered.unshift({ key: 'president_national', label: 'Pakistan President' });
    }
    
    return filtered.sort((a, b) => a.label.localeCompare(b.label));
  }
}

/**
 * Normalizes a role slug to the canonical format (lowercase, underscores).
 * TRIPLE-LOCK ENFORCEMENT:
 * 1. Lowercase + Trim
 * 2. Non-alphanumeric -> Underscore
 * 3. Multi-underscore Collapse
 * 4. Leading/Trailing strip
 */
export function normalizeRoleSlug(role: string): string {
  if (!role) return 'member';

  let slug = role.toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_') // Replace EVERYTHING not alphanumeric with underscore
    .replace(/_+/g, '_')       // Collapse multiple underscores
    .replace(/^_+|_+$/g, '');  // Strip leading/trailing underscores

  // Semantic Redirect Map (Canonical Merging)
  const REDIRECTS: Record<string, string> = {
    'pakistan_president': 'president_national',
    'pakistan_national_president': 'president_national',
    'presidential_national': 'president_national',
    'president': 'president_chapter',
    'advisor_faculty_head': 'advisor',
    'chair_alumni_legacy_network': 'chair_alumni',
    'chair_design_media': 'chair_design',
    'chair_ethics_sustainability': 'chair_ethics',
    'marketingoutreach_head': 'marketing_head',
    'hr_or_membership_director': 'hr_director',
    'super_admin': 'superadmin',
    'chair_events_committee': 'chair_events',
    'chair_marketing_communications': 'chair_marketing',
    'chair_outreach_committee': 'chair_outreach',
    'chair_projects_committee': 'chair_projects',
    'chair_recruitment_membership': 'chair_recruitment',
    'chair_sponsorship_finance': 'chair_sponsorship',
    'cubesatcansat_team': 'cubesat_team'
  };

  return REDIRECTS[slug] || slug;
}
