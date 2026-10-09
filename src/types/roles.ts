// SEDS Pakistan Web Platform - Canonical Role Taxonomy Types
// Spec: SEDS-DEV-SPEC-RBAC-2026-V1.0 (sections 2, 3 and 4)
// Two-tier federation: National Headquarters (Tier A) and
// Local University Chapters (Tier B). Permanent secretariat:
// IST BIC Room 131, Islamabad.

// RoleScope: scope of a user role record (spec section 2.1).
// 'national' operates across the whole federation.
// 'chapter' operates strictly within one university chapter.
export type RoleScope = 'national' | 'chapter';

// CanonicalRole: the canonical role tokens for all five levels.
// Level 1: Platform Administration and Superusers.
// Level 2: National Executive Council (Tier A).
// Level 3: Chapter Executive Boards (Tier B).
// Level 4: Technical Subsystem Engineering Roles.
// Level 5: General Status Roles.
export type CanonicalRole =
  // Level 1: Platform Administration and Superusers
  | 'superadmin'
  | 'developer'
  // Level 2: National Executive Council (Tier A)
  | 'president_national'
  | 'national_vp_engineering'
  | 'national_vp_operations'
  | 'national_vp_marketing'
  | 'national_vp_finance'
  | 'national_vp_membership'
  // Level 3: Chapter Executive Boards (Tier B)
  | 'chapter_president'
  | 'chapter_vp_technical'
  | 'chapter_vp_operations'
  | 'chapter_vp_marketing'
  | 'chapter_treasurer'
  | 'chapter_general_secretary'
  | 'chapter_faculty_advisor'
  // Level 4: Technical Subsystem Engineering Roles
  | 'lead_propulsion'
  | 'lead_structures'
  | 'lead_avionics'
  | 'lead_robotics'
  | 'lead_materials'
  | 'lead_ground_systems'
  // Level 5: General Status Roles
  | 'senior_advisor'
  | 'team_member'
  | 'crucible_candidate'
  | 'applicant'
  | 'alumni'
  | 'guest';

// SubRole: sub-role tokens. Directors and managers reporting under the
// five national VPs, plus technical specialists under the Level 4
// subsystem leads.
export type SubRole =
  // Under national_vp_engineering (Chief Engineer)
  | 'director_aerospace_systems'
  | 'director_autonomous_robotics'
  | 'director_satellite_avionics'
  | 'standards_and_safety_lead'
  // Under national_vp_operations (Executive Lead)
  | 'director_internal_ops'
  | 'hq_facility_manager'
  | 'events_director'
  // Under national_vp_marketing (Communications and Brand Lead)
  | 'director_visual_media'
  | 'director_video_production'
  | 'director_content_and_copy'
  | 'social_media_manager'
  // Under national_vp_finance (Treasury and Sourcing Lead)
  | 'director_china_sourcing'
  | 'director_corporate_sponsorship'
  | 'treasury_auditor'
  // Under national_vp_membership (Talent and Chapters Lead)
  | 'director_talent_intake'
  | 'director_chapter_relations'
  | 'member_success_coordinator'
  // Specialists under the Level 4 subsystem leads
  | 'propulsion_engineer'
  | 'cad_design_engineer'
  | 'embedded_firmware_engineer'
  | 'ros2_autonomy_engineer'
  | 'composites_layup_technician'
  | 'range_safety_officer';

// SubsystemTrack: technical subsystem tracks. Each Level 4 lead owns one
// track; assignee labels on /admin/tasks render as Canonical Title plus
// subsystem.
export type SubsystemTrack =
  | 'propulsion'
  | 'structures'
  | 'avionics'
  | 'robotics'
  | 'materials'
  | 'ground_systems';

// UserRoleProfile: shape of a user role record in Firestore at
// /users/{id}, /teamMembers/{id} and /positions/{id} (spec section 2.1).
// A 'national' record has chapterId null or 'national-headquarters'.
// A 'chapter' record has chapterId linking to /chapters/{chapterId}.
export interface UserRoleProfile {
  role: CanonicalRole;
  subRole?: SubRole;
  scope: RoleScope;
  chapterId: string | null;
  subsystemTrack?: SubsystemTrack;
}
