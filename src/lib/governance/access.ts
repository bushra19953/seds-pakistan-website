// Access tiers for governance records (Workstream D, spec 4.3).
// Server-only: routes call canAccessRecord on every file request.
// File access is governed by accessLevel plus caller rank; the governance
// permission keys never grant file access on their own beyond the tier
// rules below (spec 3.5).

import { FOUNDER_UID, resolveCanonicalRole } from '@/lib/roles';
import type { AccessLevel, GovernanceRecordLinks } from './types';

export interface GovernanceCaller {
  uid: string | null;
  hasProfile: boolean;
  role: string | null;
  chapterId?: string | null;
  permissions: string[];
}

export interface AccessibleRecord {
  accessLevel: AccessLevel;
  links?: GovernanceRecordLinks | null;
}

// ADAPTER(phase1-rank-table): replace with the Phase 1 authoritative rank table when it lands.
// Ranks: R4 = Board level, R3 = national officer / Council level,
// R2 = chapter officer, R1 = subsystem lead / member, R0 = no standing.
// Keys are canonical role tokens from src/types/roles.ts (the canonical
// roles resolved by src/lib/server/permissions.ts).
export const ROLE_RANK: Record<string, number> = {
  // R4 - Board
  superadmin: 4,
  founder_patron: 4,
  developer: 4,
  president_national: 4,
  // R3 - national officers / Council
  national_vp_engineering: 3,
  national_vp_operations: 3,
  national_vp_marketing: 3,
  national_vp_finance: 3,
  national_vp_membership: 3,
  senior_advisor: 3,
  // R2 - chapter officers
  chapter_president: 2,
  chapter_vp_technical: 2,
  chapter_vp_operations: 2,
  chapter_vp_marketing: 2,
  chapter_design_chair: 2,
  chapter_treasurer: 2,
  chapter_general_secretary: 2,
  chapter_faculty_advisor: 2,
  // R1 - leads and members
  lead_propulsion: 1,
  lead_structures: 1,
  lead_avionics: 1,
  lead_robotics: 1,
  lead_materials: 1,
  lead_ground_systems: 1,
  team_member: 1,
  alumni: 1,
  // R0
  crucible_candidate: 0,
  applicant: 0,
  guest: 0,
};

export function getRoleRank(role: string | null | undefined): number {
  if (!role) return 0;
  const raw = role.trim().toLowerCase();
  if (raw in ROLE_RANK) return ROLE_RANK[raw];
  const canonical = resolveCanonicalRole(role);
  return ROLE_RANK[canonical] ?? 0;
}

export function isFounderCaller(caller: GovernanceCaller): boolean {
  return !!caller.uid && caller.uid === FOUNDER_UID;
}

function hasPermission(caller: GovernanceCaller, key: string): boolean {
  return Array.isArray(caller.permissions) && caller.permissions.includes(key);
}

// Spec 4.3 tiers:
// - public: anyone (routes additionally enforce status approved/effective
//   and re-run the redaction guard before serving).
// - members: any signed-in user whose profile exists.
// - board_council: rank R4/R3, or the Founder UID, or
//   canApproveGovernanceRecords.
// - officer_only: rank R3+, or a chapter officer (R2) only when the
//   record's links.chapterId matches the caller's chapter, or the
//   Founder UID, or canManageGovernanceRecords.
export function canAccessRecord(caller: GovernanceCaller, record: AccessibleRecord): boolean {
  switch (record.accessLevel) {
    case 'public':
      return true;
    case 'members':
      return !!caller.uid && caller.hasProfile;
    case 'board_council': {
      if (!caller.uid) return false;
      if (isFounderCaller(caller)) return true;
      if (hasPermission(caller, 'canApproveGovernanceRecords')) return true;
      return getRoleRank(caller.role) >= 3;
    }
    case 'officer_only': {
      if (!caller.uid) return false;
      if (isFounderCaller(caller)) return true;
      if (hasPermission(caller, 'canManageGovernanceRecords')) return true;
      const rank = getRoleRank(caller.role);
      if (rank >= 3) return true;
      if (rank === 2) {
        const recordChapter = record.links?.chapterId || null;
        return !!recordChapter && !!caller.chapterId && recordChapter === caller.chapterId;
      }
      return false;
    }
    default:
      return false;
  }
}
