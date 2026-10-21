import type { ReservedMatter } from '@/types/consent';

// The site-touched Reserved Matters (Phase 2 spec, Section A.3).
// Single source of truth for the seed script (scripts/seed-consent-matters.ts)
// and the Exhibit A form. The consent service validates any submitted
// matterKey against this list, so a Firestore edit cannot invent a
// Reserved Matter. Default gate modes are provisional until decision D3
// and live in data, not code.
export const RESERVED_MATTERS: ReservedMatter[] = [
  { matterKey: 'amend_constitutional_documents', scheduleSection: '3.1(a)', label: 'Amend the Memorandum, constitution, or Reserved Powers Schedule', defaultGateMode: 'record_only' },
  { matterKey: 'amend_layer1_documents', scheduleSection: '3.1(b)', label: 'Amend master architecture, role catalog, decision rights, finance policy', defaultGateMode: 'hard_block' },
  { matterKey: 'change_registered_office', scheduleSection: '3.1(c)', label: 'Change the registered office', defaultGateMode: 'record_only' },
  { matterKey: 'appoint_remove_national_officer', scheduleSection: '3.2(a)', label: 'Appoint or remove a national officer', defaultGateMode: 'hard_block' },
  { matterKey: 'appoint_remove_governor', scheduleSection: '3.2(b)', label: 'Appoint or remove a Governor (Const s.5.2(b))', defaultGateMode: 'hard_block' },
  { matterKey: 'waive_full_member_requirement', scheduleSection: '3.2(c)', label: 'Waive the Full Member requirement for a national officer', defaultGateMode: 'hard_block' },
  { matterKey: 'appoint_founder_executive_director', scheduleSection: '3.2(d)', label: 'Appoint the Founder as Executive Director / set ED remuneration', defaultGateMode: 'record_only' },
  { matterKey: 'call_emergency_meeting', scheduleSection: '3.2(e)', label: 'Call an emergency meeting on 48 hours notice', defaultGateMode: 'record_only' },
  { matterKey: 'circulate_board_resolution', scheduleSection: '3.2(f)', label: 'Circulate a written/electronic Board resolution', defaultGateMode: 'record_only' },
  { matterKey: 'remove_founder', scheduleSection: '3.2(g)', label: 'Remove the Founder (Const s.16.5) - platform record only', defaultGateMode: 'record_only' },
  { matterKey: 'unbudgeted_expenditure', scheduleSection: '3.3(c)', label: 'Expenditure the approved budget does not state', defaultGateMode: 'record_only' },
  { matterKey: 'expenditure_above_threshold', scheduleSection: '3.3(d)', label: 'Expenditure above the threshold (PKR 250,000, Const s.1.3)', defaultGateMode: 'record_only' },
  { matterKey: 'set_membership_dues', scheduleSection: '3.3(e)', label: 'Set annual membership dues and the payment date', defaultGateMode: 'record_only' },
  { matterKey: 'accept_conditional_grant_donation', scheduleSection: '3.3(i)', label: 'Accept a grant or donation carrying a condition', defaultGateMode: 'hard_block' },
  { matterKey: 'ip_decision_or_licence', scheduleSection: '3.4(b)', label: 'IP ownership decision or IP licence', defaultGateMode: 'record_only' },
  { matterKey: 'related_party_contract', scheduleSection: '3.4(c)', label: 'Contract or arrangement with a Related Party', defaultGateMode: 'hard_block' },
  { matterKey: 'chapter_admit_suspend_expel', scheduleSection: '3.5(a)', label: 'Admit, suspend, or expel a chapter', defaultGateMode: 'hard_block' },
  { matterKey: 'external_affiliation_mou', scheduleSection: '3.5(b)', label: 'Affiliate with SEDS Earth / another body, or amend/terminate an affiliation MOU', defaultGateMode: 'record_only' },
];

export const RESERVED_MATTER_KEYS: string[] = RESERVED_MATTERS.map((m) => m.matterKey);

const MATTER_BY_KEY = new Map<string, ReservedMatter>(
  RESERVED_MATTERS.map((m) => [m.matterKey, m]),
);

export function getReservedMatter(matterKey: string): ReservedMatter | undefined {
  return MATTER_BY_KEY.get(matterKey);
}

export function isValidMatterKey(matterKey: string): boolean {
  return MATTER_BY_KEY.has(matterKey);
}
