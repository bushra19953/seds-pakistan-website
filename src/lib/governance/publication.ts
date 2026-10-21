// Governance publication feature flag (Workstream D, spec 12).
// Publication is held behind this flag pending Decisions 1, 2, 20.
// Default is OFF: only the exact string 'true' enables it.

export const GOVERNANCE_PUBLICATION_ENV = 'GOVERNANCE_PUBLICATION_ENABLED';

export function isGovernancePublicationEnabled(): boolean {
  return process.env.GOVERNANCE_PUBLICATION_ENABLED === 'true';
}
