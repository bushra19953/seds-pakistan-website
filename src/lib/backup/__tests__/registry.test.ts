/**
 * Workstream F: backup registry completeness.
 *
 * The registry must cover every Firestore collection in the repo-derived
 * inventory (ws-f spec section 2.4) plus the collections created by the
 * earlier bylaws phases and by this programme itself. The defect being
 * repaired: the old browser backup exported 5 collections, one of them
 * the wrong one ("auditLogs" instead of the canonical "audit_logs").
 */
import { BACKUP_COLLECTIONS, collectionsForBackup } from '../registry';

// Transcribed from ws-f spec section 2.4 (the code-derived inventory).
const SPEC_INVENTORY = [
  'users', 'blogs', 'events', 'forms', 'auditLogs', 'audit_logs', 'roles',
  'roleHistory', 'positions', 'applications', 'chapters',
  'chapter_applications', 'warnings', 'warningConfig', 'tasks', 'workflows',
  'workflow_members', 'workflow_audits', 'workflow_presence',
  'workflow_typing', 'submissions', 'universal_submissions', 'points_ledger',
  'points_audit', 'leave_requests', 'leave_audit', 'certificates',
  'certificate_public', 'badges', 'skills', 'competitions', 'eventTickets',
  'registrations', 'orders', 'products', 'projects', 'organizations',
  'partners', 'sponsors_partners', 'leads', 'sourcing_inquiries',
  'sourcing_rfqs', 'messages', 'notifications', 'announcements', 'timeline',
  'pages', 'legalDocuments', 'settings', 'permissions', 'roleDefinitions',
  'role_permissions', 'role_requests', 'reporting_relationships',
  'resources', 'teamMembers', 'upload_logs', 'galleryAssets', 'bug_reports',
  'client_errors', 'contactSubmissions', 'contactRateLimits', 'email_logs',
  'pageVisits', 'analyticsEvents', 'cache', 'dlq_points_retry',
  'auction_bids', 'rewards', 'invites', 'drafts', 'authority_refresh',
];

// Collections created by earlier phases / this programme (spec 2.4 tail).
const PHASE_ADDED = [
  'governance_records', 'role_history', 'decisions', 'consents',
  'compliance_obligations', 'finance_budgets', 'ledger_entries',
  'finance_reconciliations', 'backup_runs', 'retention_policies',
  'erasure_requests',
];

describe('BACKUP_COLLECTIONS registry', () => {
  const names = BACKUP_COLLECTIONS.map((e) => e.name);

  it('covers every collection in the spec 2.4 inventory', () => {
    for (const name of SPEC_INVENTORY) {
      expect(names).toContain(name);
    }
  });

  it('covers the phase-added and programme collections', () => {
    for (const name of PHASE_ADDED) {
      expect(names).toContain(name);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('backs up the canonical audit_logs as full (the C6 fix)', () => {
    const entry = BACKUP_COLLECTIONS.find((e) => e.name === 'audit_logs');
    expect(entry?.backupClass).toBe('full');
  });

  it('keeps legacy auditLogs exactly once, marked legacy-deprecated', () => {
    const matches = BACKUP_COLLECTIONS.filter((e) => e.name === 'auditLogs');
    expect(matches).toHaveLength(1);
    expect(matches[0].backupClass).toBe('legacy-deprecated');
  });

  it('marks the specced ephemeral collections as ephemeral', () => {
    for (const name of [
      'workflow_presence',
      'workflow_typing',
      'contactRateLimits',
      'cache',
      'dlq_points_retry',
      'authority_refresh',
    ]) {
      expect(
        BACKUP_COLLECTIONS.find((e) => e.name === name)?.backupClass,
      ).toBe('ephemeral');
    }
  });

  it('collectionsForBackup(false) excludes ephemeral but keeps the rest', () => {
    const withoutEphemeral = collectionsForBackup(false).map((e) => e.name);
    expect(withoutEphemeral).not.toContain('workflow_presence');
    expect(withoutEphemeral).not.toContain('cache');
    expect(withoutEphemeral).toContain('audit_logs');
    expect(withoutEphemeral).toContain('users');
    const withEphemeral = collectionsForBackup(true).map((e) => e.name);
    expect(withEphemeral).toContain('workflow_presence');
  });
});
