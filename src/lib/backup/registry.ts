/**
 * Backup collection registry (Workstream F, spec ws-f.md section 2.4).
 *
 * Single source of truth for which Firestore collections the scheduled
 * backup engine exports. Replaces the hardcoded 5-collection list that
 * used to live in src/app/admin/backup-restore/page.tsx, which exported
 * the legacy "auditLogs" side collection and missed the canonical
 * "audit_logs" trail entirely (spec 2.2).
 *
 * SPEC-GAP(F): ws-f.md section 2.4 heads its inventory "Current top-level
 * collections (78)" but the table itself contains exactly 72 rows
 * (numbered 1 to 72). This registry transcribes the 72 rows that actually
 * exist in the table; no names were invented to reach 78.
 *
 * SPEC-GAP(F): the phase-added finance collections are named only
 * generically in ws-f.md section 2.4 ("budget, ledger, reconciliations").
 * They are registered here under their actual Workstream C collection
 * names: finance_budgets, ledger_entries, finance_reconciliations
 * (ws-c.md sections 3.1, 3.2, 3.3).
 */

export type BackupClass = 'full' | 'ephemeral' | 'legacy-deprecated';

export interface BackupCollectionEntry {
  name: string;
  backupClass: BackupClass;
  notes?: string;
}

export const BACKUP_COLLECTIONS: readonly BackupCollectionEntry[] = [
  // --- Spec 2.4 inventory, rows 1-72, in table order ---
  { name: 'users', backupClass: 'full', notes: 'member docs; mirror role store' },
  { name: 'blogs', backupClass: 'full' },
  { name: 'events', backupClass: 'full' },
  { name: 'forms', backupClass: 'full' },
  {
    name: 'auditLogs',
    backupClass: 'legacy-deprecated',
    notes: 'LEGACY side collection; see spec 2.2. Exported until the Phase 2 audit consolidation confirms it is empty/merged, then removed.',
  },
  { name: 'audit_logs', backupClass: 'full', notes: 'canonical audit trail; the C6 defect was backing up auditLogs instead of this' },
  { name: 'roles', backupClass: 'full', notes: 'authoritative role store (Phase 1)' },
  { name: 'roleHistory', backupClass: 'full', notes: 'in firestore.rules; Phase 1 renames/supersedes by role_history' },
  { name: 'positions', backupClass: 'full', notes: 'appointment history' },
  { name: 'applications', backupClass: 'full', notes: 'induction applications, one doc per uid' },
  { name: 'chapters', backupClass: 'full' },
  { name: 'chapter_applications', backupClass: 'full' },
  { name: 'warnings', backupClass: 'full', notes: 'top-level warning/case records' },
  { name: 'warningConfig', backupClass: 'full', notes: 'config doc warningConfig/global' },
  { name: 'tasks', backupClass: 'full' },
  { name: 'workflows', backupClass: 'full' },
  { name: 'workflow_members', backupClass: 'full' },
  { name: 'workflow_audits', backupClass: 'full', notes: 'side audit collection' },
  { name: 'workflow_presence', backupClass: 'ephemeral', notes: 'ephemeral presence' },
  { name: 'workflow_typing', backupClass: 'ephemeral', notes: 'ephemeral typing state' },
  { name: 'submissions', backupClass: 'full' },
  { name: 'universal_submissions', backupClass: 'full' },
  { name: 'points_ledger', backupClass: 'full', notes: 'gamification ledger' },
  { name: 'points_audit', backupClass: 'full', notes: 'side audit collection' },
  { name: 'leave_requests', backupClass: 'full' },
  { name: 'leave_audit', backupClass: 'full', notes: 'side audit collection' },
  { name: 'certificates', backupClass: 'full', notes: 'includes SHA-256 verification codes' },
  { name: 'certificate_public', backupClass: 'full', notes: 'public verification projection' },
  { name: 'badges', backupClass: 'full' },
  { name: 'skills', backupClass: 'full' },
  { name: 'competitions', backupClass: 'full' },
  { name: 'eventTickets', backupClass: 'full' },
  { name: 'registrations', backupClass: 'full', notes: 'event registrations' },
  { name: 'orders', backupClass: 'full', notes: 'store + donations + chapter fees (finance evidence)' },
  { name: 'products', backupClass: 'full' },
  { name: 'projects', backupClass: 'full' },
  { name: 'organizations', backupClass: 'full' },
  { name: 'partners', backupClass: 'full', notes: 'CRM-adjacent' },
  { name: 'sponsors_partners', backupClass: 'full', notes: 'sponsor CRM' },
  { name: 'leads', backupClass: 'full', notes: 'CRM' },
  { name: 'sourcing_inquiries', backupClass: 'full' },
  { name: 'sourcing_rfqs', backupClass: 'full', notes: 'holds benchmarking quote fields' },
  { name: 'messages', backupClass: 'full' },
  { name: 'notifications', backupClass: 'full' },
  { name: 'announcements', backupClass: 'full' },
  { name: 'timeline', backupClass: 'full' },
  { name: 'pages', backupClass: 'full', notes: 'holds live Terms and Privacy Policy docs' },
  { name: 'legalDocuments', backupClass: 'full', notes: 'terms-version source' },
  { name: 'settings', backupClass: 'full' },
  { name: 'permissions', backupClass: 'full', notes: 'live per-role permission grants' },
  { name: 'roleDefinitions', backupClass: 'full' },
  { name: 'role_permissions', backupClass: 'full' },
  { name: 'role_requests', backupClass: 'full' },
  { name: 'reporting_relationships', backupClass: 'full', notes: 'hierarchy edges' },
  { name: 'resources', backupClass: 'full' },
  { name: 'teamMembers', backupClass: 'full' },
  { name: 'upload_logs', backupClass: 'full', notes: 'spec registry entry for table row "uploads / upload_logs"' },
  { name: 'galleryAssets', backupClass: 'full' },
  { name: 'bug_reports', backupClass: 'full' },
  { name: 'client_errors', backupClass: 'full', notes: 'ops telemetry' },
  { name: 'contactSubmissions', backupClass: 'full', notes: 'contains third-party PII' },
  { name: 'contactRateLimits', backupClass: 'ephemeral' },
  { name: 'email_logs', backupClass: 'full', notes: 'side audit collection' },
  { name: 'pageVisits', backupClass: 'full', notes: 'analytics' },
  { name: 'analyticsEvents', backupClass: 'full', notes: 'analytics' },
  { name: 'cache', backupClass: 'ephemeral', notes: 'derived data (leaderboard cache)' },
  { name: 'dlq_points_retry', backupClass: 'ephemeral', notes: 'retry queue' },
  { name: 'auction_bids', backupClass: 'full' },
  { name: 'rewards', backupClass: 'full' },
  { name: 'invites', backupClass: 'full', notes: 'member invites created at shortlist' },
  { name: 'drafts', backupClass: 'full', notes: 'per-user form drafts; personal data' },
  { name: 'authority_refresh', backupClass: 'ephemeral', notes: 'ephemeral signal docs' },

  // --- Phase-added collections, named in the text after the 2.4 table ---
  { name: 'role_history', backupClass: 'full', notes: 'Phase 1 authoritative role history; supersedes roleHistory' },
  { name: 'governance_records', backupClass: 'full', notes: 'Workstream D governance records store' },
  { name: 'finance_budgets', backupClass: 'full', notes: 'Workstream C budgets (named generically as "budget" in ws-f 2.4)' },
  { name: 'ledger_entries', backupClass: 'full', notes: 'Workstream C ledger (named generically as "ledger" in ws-f 2.4)' },
  { name: 'finance_reconciliations', backupClass: 'full', notes: 'Workstream C reconciliations' },
  { name: 'decisions', backupClass: 'full', notes: 'Phase 2 decisions register' },
  { name: 'consents', backupClass: 'full', notes: 'Phase 2 consents' },
  { name: 'compliance_obligations', backupClass: 'full', notes: 'Phase 2 compliance engine' },
  { name: 'backup_runs', backupClass: 'full', notes: 'this workstream: backup run records' },
  { name: 'retention_policies', backupClass: 'full', notes: 'this workstream: retention policy config' },
  { name: 'erasure_requests', backupClass: 'full', notes: 'this workstream: account-erasure requests' },

  // --- Step-16 consolidated update (Supabase migration, conflict C-19):
  // the nine collections the migration dump census proved exist but the
  // spec inventory never listed. Registered once, here, per C-19; the
  // backup engine stays on Firestore as source of record (the migration
  // kit's dump is its twin, not its replacement). ---
  { name: '_archived_applications', backupClass: 'full', notes: 'archived induction applications (dump census 2026-10-25)' },
  { name: 'consent_requests', backupClass: 'full', notes: 'Phase 2 consent requests (dump census 2026-10-25)' },
  { name: 'governance', backupClass: 'full', notes: 'governance config docs (dump census 2026-10-25)' },
  { name: 'group_notifications', backupClass: 'full', notes: 'users/{uid}/notifications subcollection family (dump census 2026-10-25)' },
  { name: 'group_registrations', backupClass: 'full', notes: 'events/{id}/registrations subcollection family (dump census 2026-10-25)' },
  { name: 'intake_config', backupClass: 'full', notes: 'induction intake config (dump census 2026-10-25)' },
  { name: 'intake_windows', backupClass: 'full', notes: 'induction intake windows (dump census 2026-10-25)' },
  { name: 'page_content', backupClass: 'full', notes: 'CMS page content (dump census 2026-10-25)' },
  { name: 'reporting_lines', backupClass: 'full', notes: 'org reporting lines (dump census 2026-10-25)' },
];

/**
 * Collections to export in a backup run.
 *
 * SPEC-GAP(F): includeEphemeral defaults to true (the assignment for this
 * engine), and 'legacy-deprecated' entries are always included: spec 2.2
 * keeps auditLogs exported until the audit consolidation confirms it is
 * empty/merged. Only the 'ephemeral' class is filtered, and only when
 * includeEphemeral is explicitly false.
 */
export function collectionsForBackup(
  includeEphemeral: boolean = true,
): BackupCollectionEntry[] {
  if (includeEphemeral) return [...BACKUP_COLLECTIONS];
  return BACKUP_COLLECTIONS.filter((entry) => entry.backupClass !== 'ephemeral');
}
