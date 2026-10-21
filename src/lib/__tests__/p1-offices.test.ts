/**
 * Phase 1 Workstream D - missing offices exist as assignable structures
 * with no holders, and Founder-appointed offices carry the D.2 bundles.
 */
import {
  CANONICAL_ROLES,
  isCatalogRoleKey,
} from '../role-catalog';
import {
  FOUNDER_APPOINTED_OFFICES,
  OFFICE_PERMISSION_SEEDS,
  isFounderAppointedOffice,
} from '../governance/office-permission-seeds';
import { resolveOfficeHolders } from '../governance/offices';

const NEW_OFFICES = [
  'national_treasurer',
  'national_general_secretary',
  'national_membership_director',
  'national_audit_compliance_chair',
  'returning_officer',
  'parliamentarian',
  'regional_coordinator',
] as const;

describe('offices-catalog', () => {
  it('all seven new offices exist as catalog keys', () => {
    for (const key of NEW_OFFICES) {
      expect(isCatalogRoleKey(key)).toBe(true);
      expect(CANONICAL_ROLES[key]).toBeDefined();
    }
  });

  it('no office names a holder: catalog rows carry structure only', () => {
    for (const key of NEW_OFFICES) {
      const row = CANONICAL_ROLES[key] as unknown as Record<string, unknown>;
      expect(row).not.toHaveProperty('holder');
      expect(row).not.toHaveProperty('holderUid');
      expect(row).not.toHaveProperty('uid');
    }
  });

  it('office appointedBy values match the catalog (Art. 7/8)', () => {
    expect(CANONICAL_ROLES.national_treasurer.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.national_general_secretary.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.national_membership_director.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.national_audit_compliance_chair.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.returning_officer.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.parliamentarian.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.regional_coordinator.appointedBy).toBe('FOUNDER');
    expect(CANONICAL_ROLES.faculty_advisor.appointedBy).toBe('FOUNDER');
  });

  it('the eight Founder-appointed offices are exactly the D.2 set', () => {
    expect([...FOUNDER_APPOINTED_OFFICES].sort()).toEqual(
      [...NEW_OFFICES, 'faculty_advisor'].sort(),
    );
    for (const key of FOUNDER_APPOINTED_OFFICES) {
      expect(isFounderAppointedOffice(key)).toBe(true);
    }
    expect(isFounderAppointedOffice('chapter_president')).toBe(false);
  });

  it('regional_coordinator is appointed by the Founder, not the National President (FLAG-D-2)', () => {
    expect(CANONICAL_ROLES.regional_coordinator.appointedBy).toBe('FOUNDER');
  });

  it('every office bundle has canManageRoles absent-or-false and the specced matrix values', () => {
    for (const key of FOUNDER_APPOINTED_OFFICES) {
      const bundle = OFFICE_PERMISSION_SEEDS[key] as unknown as Record<string, boolean>;
      expect(bundle.canManageRoles ?? false).toBe(false);
      expect(bundle.canAccessAdmin).toBe(true);
    }
    // Spot-check the D.2 matrix extremes.
    expect(OFFICE_PERMISSION_SEEDS.national_general_secretary.canManageApplications).toBe(true);
    expect(OFFICE_PERMISSION_SEEDS.national_general_secretary.canManageTasks).toBe(true);
    expect(OFFICE_PERMISSION_SEEDS.returning_officer.canViewChapters).toBe(false);
    expect(OFFICE_PERMISSION_SEEDS.returning_officer.canViewAnalytics).toBe(false);
    expect(OFFICE_PERMISSION_SEEDS.national_treasurer.canManageSponsors).toBe(true);
    expect(OFFICE_PERMISSION_SEEDS.national_treasurer.canManageTasks).toBe(false);
    expect(OFFICE_PERMISSION_SEEDS.regional_coordinator.canManageCompetitions).toBe(true);
    expect(OFFICE_PERMISSION_SEEDS.faculty_advisor.canManageTasks).toBe(true);
  });

  it('single-seat offices carry seats: 1', () => {
    for (const key of NEW_OFFICES) {
      expect(CANONICAL_ROLES[key].seats).toBe(1);
    }
  });
});

describe('office resolution (vacancy semantics, D.4)', () => {
  function fakeDb(rolesDocs: Array<{ id: string; data: Record<string, unknown> }>) {
    return {
      collection: (name: string) => ({
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => ({
            docs:
              name === 'roles'
                ? rolesDocs.filter((d) =>
                    field === 'role'
                      ? d.data.role === value
                      : Array.isArray(d.data.additionalRoles) &&
                        (d.data.additionalRoles as string[]).includes(value as string),
                  ).map((d) => ({ id: d.id, data: () => d.data }))
                : [],
          }),
        }),
        get: async () => ({ docs: [] }),
      }),
    };
  }

  it('a vacant office resolves to holder null without throwing', async () => {
    const res = await resolveOfficeHolders(fakeDb([]) as never, 'national_treasurer');
    expect(res.holder).toBeNull();
    expect(res.conflict).toBe(false);
  });

  it('a single holder resolves by primary role and by additionalRoles', async () => {
    const db = fakeDb([
      { id: 'u1', data: { role: 'national_treasurer' } },
      { id: 'u2', data: { role: 'member', additionalRoles: ['parliamentarian'] } },
    ]);
    const treasurer = await resolveOfficeHolders(db as never, 'national_treasurer');
    expect(treasurer.holder?.uid).toBe('u1');
    const parliamentarian = await resolveOfficeHolders(db as never, 'parliamentarian');
    expect(parliamentarian.holder?.uid).toBe('u2');
  });

  it('two holders surface as a conflict, never a silent pick', async () => {
    const db = fakeDb([
      { id: 'u1', data: { role: 'returning_officer' } },
      { id: 'u2', data: { role: 'member', additionalRoles: ['returning_officer'] } },
    ]);
    const res = await resolveOfficeHolders(db as never, 'returning_officer');
    expect(res.conflict).toBe(true);
    expect(res.holderUids).toEqual(['u1', 'u2']);
  });
});
