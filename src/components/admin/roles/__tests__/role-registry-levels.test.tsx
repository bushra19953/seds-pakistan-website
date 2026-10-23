/**
 * LEVELS CONSISTENCY AUDIT — Role Registry LVL count + scope badge pins.
 *
 * The LVL badge must count UNIQUE definition-array keys that exist in
 * ADMIN_PERMISSIONS (inert stored keys and duplicates never count), and
 * the NATIONAL/LOCAL badge must derive from the catalog scope for
 * catalog rows (scopeOf) and from the stored scope field, mapped
 * 'global'/'national' -> NATIONAL, for non-catalog rows.
 *
 * Fixture permission arrays are copied verbatim (as sets) from the
 * live roleDefinitions docs captured in the audit's truth table:
 * president_national 55 raw (29 recognized + 26 inert), superadmin 29,
 * founder_patron 46, chapter_design_chair 5, chapter_events_chair 3 raw
 * (2 recognized + 1 inert: canManageWorkshops).
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

(global as any).React = React;

// jsdom shims for Radix Select / ScrollArea internals.
if (typeof window !== 'undefined') {
  const proto = window.HTMLElement.prototype as any;
  proto.setPointerCapture = proto.setPointerCapture || (() => undefined);
  proto.releasePointerCapture = proto.releasePointerCapture || (() => undefined);
  proto.hasPointerCapture = proto.hasPointerCapture || (() => false);
  proto.scrollIntoView = proto.scrollIntoView || (() => undefined);
  (global as any).ResizeObserver =
    (global as any).ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
}

let mockRoleDefinitions: Array<Record<string, unknown>> = [];

// Probe for the editor drawer: captures the props the registry passes
// so the guardrail pin can prove the RAW array is still handed over.
const drawerPropsBySlug: Record<string, Record<string, unknown>> = {};

const CHAPTER_DOCS = [
  { id: 'seds-ist-chapter', data: () => ({ name: 'IST Chapter' }) },
];

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, name: string) => ({ _name: name })),
  query: jest.fn((ref: unknown) => ref),
  orderBy: jest.fn(() => ({})),
  getDocs: jest.fn(async (ref: { _name?: string }) =>
    ref?._name === 'chapters' ? { docs: CHAPTER_DOCS } : { docs: [] },
  ),
}));

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
  useUser: () => ({
    user: { uid: 'admin-uid', getIdToken: async () => 'test-token' },
  }),
  useCollection: () => ({ data: mockRoleDefinitions, loading: false }),
}));

jest.mock('@/hooks/use-authorization', () => ({
  useAuthorization: () => ({ isAuthorized: true, role: 'president_national' }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/lib/use-memo-firebase', () => ({
  useMemoFirebase: (fn: () => unknown) => fn(),
}));

jest.mock('@/lib/client/firestore-wrapper', () => ({
  setDoc: jest.fn(async () => undefined),
}));

jest.mock('@/components/admin/roles/role-permission-editor', () => ({
  RolePermissionEditor: () => null,
  RolePermissionEditorDrawer: (props: Record<string, unknown>) => {
    if (typeof props.roleSlug === 'string') {
      drawerPropsBySlug[props.roleSlug] = props;
    }
    return null;
  },
}));

jest.mock('@/components/admin/governance/consent-request-picker', () => ({
  ConsentRequestPicker: () => null,
}));

jest.mock('@/components/admin/governance/consent-required-dialog', () => ({
  ConsentRequiredDialog: () => null,
}));

import RoleRegistry from '@/components/admin/roles/role-registry';

// Live president_national definition array: 29 recognized + 26 inert.
const PRESIDENT_NATIONAL_PERMISSIONS = [
  'canAccessAdmin', 'canManagePermissions', 'canManageUsers', 'canManageRoles',
  'canViewAuditLogs', 'canViewHierarchy', 'canManageApplications', 'canManageProjects',
  'canManageTasks', 'canManageResources', 'canManageBlogs', 'canManageEvents',
  'canManageAnnouncements', 'canManagePages', 'canManageGallery', 'canManageChapters',
  'canManagePositions', 'canManageBadges', 'canManageSkills', 'canManageSponsorsPartners',
  'canManageStore', 'canManageSiteSettings', 'canViewEmailLogs', 'canManageBugReports',
  'canManageDefaulters', 'canManageWorkflows', 'canManageChapterApplications',
  'canManageForms', 'canManageCertificates',
  'viewAuditLogs', 'listAuditLogs', 'assignRoles', 'selfRoleChange', 'deleteUser',
  'adjustUserPoints', 'adjustUserBadges', 'manageRoleDefinitions', 'manageTeamMembers',
  'manageRoleHistory', 'manageApplications', 'listApplications', 'manageAdminApplications',
  'manageBlogs', 'manageOwnBlogs', 'manageEvents', 'manageWorkshops', 'manageAnnouncements',
  'manageGallery', 'managePagesContact', 'listEventRegistrations', 'manageProjects',
  'manageTasks', 'manageChapters', 'manageOrganizations', 'manageBadges',
];

// Live superadmin definition array: 29 recognized, 0 inert.
const SUPERADMIN_PERMISSIONS = [
  'canAccessAdmin', 'canManagePermissions', 'canManageUsers', 'canManageRoles',
  'canViewAuditLogs', 'canViewHierarchy', 'canManageApplications', 'canManageProjects',
  'canManageTasks', 'canManageResources', 'canManageBlogs', 'canManageEvents',
  'canManageAnnouncements', 'canManagePages', 'canManageGallery', 'canManageChapters',
  'canManagePositions', 'canManageBadges', 'canManageSkills', 'canManageSponsorsPartners',
  'canManageStore', 'canManageSiteSettings', 'canViewEmailLogs', 'canManageBugReports',
  'canManageDefaulters', 'canManageCertificates', 'canManageWorkflows',
  'canManageChapterApplications', 'canManageForms',
];

// Live founder_patron definition array: the full 46-key universe.
const FOUNDER_PATRON_PERMISSIONS = [
  'canAccessAdmin', 'canManagePermissions', 'canManageUsers', 'canManageRoles',
  'canViewGovernance', 'canViewAuditLogs', 'canViewHierarchy', 'canViewAnalytics',
  'canManageMeetings', 'canSignMinutes', 'canManageApplications', 'canManageCadetships',
  'canManageChapterApplications', 'canManageProjects', 'canManageTasks', 'canManageWorkflows',
  'canManagePrograms', 'canManageResources', 'canManageForms', 'canManageBlogs',
  'canManageEvents', 'canManageAnnouncements', 'canManageTimeline', 'canManagePages',
  'canManageGallery', 'canManageChapters', 'canManagePositions', 'canManageBadges',
  'canManageCertificates', 'canManageSkills', 'canManageSponsorsPartners', 'canManageStore',
  'canManageFinance', 'canApproveMoney', 'canManageSiteSettings', 'canManageOrganizations',
  'canManageElections', 'canRunElections', 'canManageAgm', 'canManageGovernanceRecords',
  'canApproveGovernanceRecords', 'canViewEmailLogs', 'canViewUploads', 'canManageBugReports',
  'canManageDefaulters', 'canManageInbox',
];

const PRESIDENT_NATIONAL = {
  id: 'president_national',
  slug: 'president_national',
  name: 'National President',
  category: 'A',
  scope: 'national',
  permissions: PRESIDENT_NATIONAL_PERMISSIONS,
  isActive: true,
};

const SUPERADMIN = {
  id: 'superadmin',
  slug: 'superadmin',
  name: 'Super Admin',
  category: 'System',
  scope: 'national',
  permissions: SUPERADMIN_PERMISSIONS,
  isActive: true,
};

const FOUNDER_PATRON = {
  id: 'founder_patron',
  slug: 'founder_patron',
  name: 'Founder and Patron-in-Chief',
  category: 'A',
  scope: 'global',
  permissions: FOUNDER_PATRON_PERMISSIONS,
  isActive: true,
};

const CHAPTER_DESIGN_CHAIR = {
  id: 'chapter_design_chair',
  slug: 'chapter_design_chair',
  name: 'Chapter Design and Media Chair',
  category: 'C',
  scope: 'chapter',
  permissions: ['canAccessAdmin', 'canManageTasks', 'canManageWorkflows', 'canManageGallery', 'canManageResources'],
  isActive: true,
};

const CHAPTER_EVENTS_CHAIR = {
  id: 'chapter_events_chair',
  slug: 'chapter_events_chair',
  name: 'Chapter Events Chair',
  category: 'C',
  scope: 'chapter',
  // canManageWorkshops is inert: it exists in live definition data only.
  permissions: ['canAccessAdmin', 'canManageEvents', 'canManageWorkshops'],
  isActive: true,
};

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (!row) throw new Error(`no table row found for ${name}`);
  return row as HTMLElement;
}

function expectRow(name: string, lvl: string, badge: 'NATIONAL' | 'LOCAL') {
  const row = rowFor(name);
  expect(within(row).getByText(lvl)).toBeInTheDocument();
  expect(within(row).getByText(badge)).toBeInTheDocument();
}

beforeEach(() => {
  for (const key of Object.keys(drawerPropsBySlug)) delete drawerPropsBySlug[key];
  mockRoleDefinitions = [];
});

describe('RoleRegistry LVL count + scope badge (levels audit pins)', () => {
  it('president_national: inert keys never count — LVL 29/46, NATIONAL', async () => {
    mockRoleDefinitions = [PRESIDENT_NATIONAL];
    render(<RoleRegistry />);
    await screen.findByText('National President');
    expectRow('National President', 'LVL 29/46', 'NATIONAL');
    expect(within(rowFor('National President')).queryByText('LVL 55/46')).toBeNull();
  });

  it('superadmin: non-catalog stored scope national maps NATIONAL — LVL 29/46', async () => {
    mockRoleDefinitions = [SUPERADMIN];
    render(<RoleRegistry />);
    await screen.findByText('Super Admin');
    expectRow('Super Admin', 'LVL 29/46', 'NATIONAL');
  });

  it('chapter_design_chair: a normal chapter chair is unchanged — LVL 5/46, LOCAL', async () => {
    mockRoleDefinitions = [CHAPTER_DESIGN_CHAIR];
    render(<RoleRegistry />);
    await screen.findByText('Chapter Design and Media Chair');
    expectRow('Chapter Design and Media Chair', 'LVL 5/46', 'LOCAL');
  });

  it('founder_patron: LVL 46/46 NATIONAL and sorts above president_national (raw 55)', async () => {
    mockRoleDefinitions = [PRESIDENT_NATIONAL, FOUNDER_PATRON];
    render(<RoleRegistry />);
    await screen.findByText('Founder and Patron-in-Chief');
    expectRow('Founder and Patron-in-Chief', 'LVL 46/46', 'NATIONAL');
    expectRow('National President', 'LVL 29/46', 'NATIONAL');
    const rows = screen.getAllByRole('row');
    // The founder's data row must be the first data row in the table:
    // the corrected comparator ranks 46 recognized above the raw 55.
    const founderIdx = rows.findIndex((r) => (r.textContent || '').includes('Founder and Patron-in-Chief'));
    const presidentIdx = rows.findIndex((r) => (r.textContent || '').includes('National President'));
    expect(founderIdx).toBe(0);
    expect(presidentIdx).toBeGreaterThan(founderIdx);
  });

  it('chapter_events_chair: the single inert key is excluded — LVL 2/46, LOCAL', async () => {
    mockRoleDefinitions = [CHAPTER_EVENTS_CHAIR];
    render(<RoleRegistry />);
    await screen.findByText('Chapter Events Chair');
    expectRow('Chapter Events Chair', 'LVL 2/46', 'LOCAL');
  });

  it('duplicates and inert keys dedupe to a Set count — LVL 1/46, LOCAL', async () => {
    mockRoleDefinitions = [{
      id: 'levels_probe_role',
      slug: 'levels_probe_role',
      name: 'Levels Probe Role',
      category: 'System',
      scope: 'chapter',
      permissions: ['canManageTasks', 'canManageTasks', 'canManageWorkshops'],
      isActive: true,
    }];
    render(<RoleRegistry />);
    await screen.findByText('Levels Probe Role');
    expectRow('Levels Probe Role', 'LVL 1/46', 'LOCAL');
  });

  it("catalog scope 'none' wins over a misleading stored scope — member LVL 0/46, LOCAL", async () => {
    mockRoleDefinitions = [{
      id: 'member',
      slug: 'member',
      name: 'Full Member',
      category: 'GENERAL_BODY',
      scope: 'global',
      permissions: [],
      isActive: true,
    }];
    render(<RoleRegistry />);
    await screen.findByText('Full Member');
    expectRow('Full Member', 'LVL 0/46', 'LOCAL');
  });

  it('guardrail: the editor drawer still receives the RAW permission array', async () => {
    mockRoleDefinitions = [CHAPTER_EVENTS_CHAIR];
    render(<RoleRegistry />);
    await screen.findByText('Chapter Events Chair');
    expect(drawerPropsBySlug['chapter_events_chair']).toBeDefined();
    expect(drawerPropsBySlug['chapter_events_chair'].initialPermissions).toEqual([
      'canAccessAdmin', 'canManageEvents', 'canManageWorkshops',
    ]);
  });
});

/**
 * ORDERING PINS (2026-10-23 follow-up): the registry sorts catalog rows
 * by ROLE_CATALOG declaration order (the platform hierarchy) — a senior
 * office never renders below a junior one because its grant is smaller
 * (president_national 29 sat below national_vice_president 32 under the
 * count-first sort). Non-catalog rows (legacy spellings, custom roles)
 * follow the whole catalog block, ordered by corrected count.
 */

// Synthetic fixtures: permission sets are slices of the founder's
// 46-key universe, chosen so the counts INVERT the hierarchy order.
const NATIONAL_VICE_PRESIDENT = {
  id: 'national_vice_president',
  slug: 'national_vice_president',
  name: 'National Vice President',
  category: 'B',
  scope: 'national',
  permissions: FOUNDER_PATRON_PERMISSIONS.slice(0, 32), // 32 recognized > president's 29
  isActive: true,
};

const CHIEF_TECHNOLOGY_OFFICER = {
  id: 'chief_technology_officer',
  slug: 'chief_technology_officer',
  name: 'Chief Technology Officer',
  category: 'B',
  scope: 'national',
  permissions: FOUNDER_PATRON_PERMISSIONS.slice(0, 40), // 40 recognized, still junior
  isActive: true,
};

const FULL_MEMBER = {
  id: 'member',
  slug: 'member',
  name: 'Full Member',
  category: 'GENERAL_BODY',
  scope: 'none',
  permissions: [],
  isActive: true,
};

const LEGACY_CHAIR_DESIGN = {
  id: 'chair_design',
  slug: 'chair_design',
  name: 'Chair Design / Media',
  category: 'Operations',
  scope: 'chapter',
  permissions: ['canAccessAdmin', 'canManageTasks', 'canManageWorkflows', 'canManageGallery', 'canManageResources'],
  isActive: true,
};

const NONCATALOG_PROBE_46 = {
  id: 'levels_probe_role',
  slug: 'levels_probe_role',
  name: 'Levels Probe Role',
  category: 'System',
  scope: 'chapter',
  permissions: FOUNDER_PATRON_PERMISSIONS, // full 46, still non-catalog
  isActive: true,
};

const NONCATALOG_PROBE_1 = {
  id: 'levels_probe_role',
  slug: 'levels_probe_role',
  name: 'Levels Probe Role',
  category: 'System',
  scope: 'chapter',
  permissions: ['canManageTasks'],
  isActive: true,
};

function rowIndexOf(name: string): number {
  const rows = screen.getAllByRole('row');
  return rows.findIndex((r) => (r.textContent || '').includes(name));
}

describe('RoleRegistry ordering (catalog hierarchy first)', () => {
  it('founder first, then president above vice president above CTO — count never outranks seniority', async () => {
    // Input deliberately scrambled and count-inverted (29 < 32 < 40).
    mockRoleDefinitions = [CHIEF_TECHNOLOGY_OFFICER, NATIONAL_VICE_PRESIDENT, PRESIDENT_NATIONAL, FOUNDER_PATRON];
    render(<RoleRegistry />);
    await screen.findByText('Founder and Patron-in-Chief');
    expect(rowIndexOf('Founder and Patron-in-Chief')).toBe(0);
    expect(rowIndexOf('National President')).toBeGreaterThan(rowIndexOf('Founder and Patron-in-Chief'));
    expect(rowIndexOf('National Vice President')).toBeGreaterThan(rowIndexOf('National President'));
    expect(rowIndexOf('Chief Technology Officer')).toBeGreaterThan(rowIndexOf('National Vice President'));
  });

  it('every catalog row renders above every non-catalog row, whatever the counts', async () => {
    mockRoleDefinitions = [NONCATALOG_PROBE_46, SUPERADMIN, FULL_MEMBER, PRESIDENT_NATIONAL];
    render(<RoleRegistry />);
    await screen.findByText('Full Member');
    // Catalog block (president idx 5, member idx 36 in the catalog):
    expect(rowIndexOf('National President')).toBeGreaterThan(-1);
    expect(rowIndexOf('Full Member')).toBeGreaterThan(rowIndexOf('National President'));
    // Non-catalog block starts only after the last catalog row,
    // even for a non-catalog row holding the full 46:
    expect(rowIndexOf('Levels Probe Role')).toBeGreaterThan(rowIndexOf('Full Member'));
    expect(rowIndexOf('Super Admin')).toBeGreaterThan(rowIndexOf('Full Member'));
  });

  it('count order is preserved inside the non-catalog block (29 > 5 > 1)', async () => {
    mockRoleDefinitions = [NONCATALOG_PROBE_1, LEGACY_CHAIR_DESIGN, SUPERADMIN];
    render(<RoleRegistry />);
    await screen.findByText('Super Admin');
    expect(rowIndexOf('Super Admin')).toBeGreaterThan(-1);
    expect(rowIndexOf('Chair Design / Media')).toBeGreaterThan(rowIndexOf('Super Admin'));
    expect(rowIndexOf('Levels Probe Role')).toBeGreaterThan(rowIndexOf('Chair Design / Media'));
  });
});
