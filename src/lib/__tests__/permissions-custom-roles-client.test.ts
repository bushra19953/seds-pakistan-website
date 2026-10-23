/**
 * @jest-environment node
 *
 * PERM-RESOLUTION (Custom Roles Fix Program) - client half of the
 * one-answer contract (plan T11-T12, contracts Section 4.4).
 *
 * The client session injects roleDefinitions/{slug}.permissions as
 * overrides (user-provider.tsx) and src/config/permissions.ts
 * hasPermission consults those overrides first. For a custom subject the
 * overrides ARE the whole answer (the static config can never name a
 * custom slug), so the client must agree with the server reading the
 * same definition array - including the SEC-03 point 4 resolution-time
 * strip of the Reserved Powers keys (canManagePermissions,
 * canManageRoles) for custom_ subjects, via BOTH routes into them:
 * injectRoleOverrides must not store them for a custom role, and
 * hasPermission must refuse them for a custom subject even under their
 * legacy spellings ('assignRoles', 'selfRoleChange').
 *
 * The override map is module-level state, so every case loads a fresh
 * copy of the module via jest.isolateModules.
 */

const CUSTOM = 'custom_poster_team_lead';

interface ClientPerms {
  hasPermission: (role: string | null, permission: string) => boolean;
  injectRoleOverrides: (role: never, customPermissions: string[]) => void;
}

function freshClientPerms(): ClientPerms {
  let mod: ClientPerms | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@/config/permissions') as ClientPerms;
  });
  if (!mod) throw new Error('failed to load @/config/permissions in isolation');
  return mod;
}

describe('client hasPermission - custom subject (plan T11/T12)', () => {
  it('T11a (SEC-03 point 4): injected reserved keys are stripped for a custom role; real grants survive', () => {
    const client = freshClientPerms();
    client.injectRoleOverrides(
      CUSTOM as never,
      ['canManageRoles', 'canManagePermissions', 'canManageTasks'],
    );
    expect(client.hasPermission(CUSTOM, 'canManageTasks')).toBe(true);
    expect(client.hasPermission(CUSTOM, 'canManageRoles')).toBe(false);
    expect(client.hasPermission(CUSTOM, 'canManagePermissions')).toBe(false);
  });

  it('T11a-legacy (SEC-03 point 4): reserved keys stay refused under legacy spellings for a custom subject', () => {
    const client = freshClientPerms();
    client.injectRoleOverrides(
      CUSTOM as never,
      ['canManageRoles', 'canManagePermissions', 'canManageTasks'],
    );
    // LEGACY_KEY_MAP: assignRoles -> canManageRoles,
    // selfRoleChange -> canManagePermissions.
    expect(client.hasPermission(CUSTOM, 'assignRoles')).toBe(false);
    expect(client.hasPermission(CUSTOM, 'selfRoleChange')).toBe(false);
    // A legacy spelling of a granted key still resolves.
    expect(client.hasPermission(CUSTOM, 'manageTasks')).toBe(true);
  });

  it('T11b: the strip is custom-only - a catalog role keeps today\u2019s override behaviour', () => {
    const client = freshClientPerms();
    client.injectRoleOverrides('chapter_president' as never, [
      'canManageRoles',
      'canManagePermissions',
    ]);
    expect(client.hasPermission('chapter_president', 'canManageRoles')).toBe(true);
    expect(client.hasPermission('chapter_president', 'canManagePermissions')).toBe(true);
  });

  it('T12: with no overrides injected, a custom subject is denied every key', () => {
    const client = freshClientPerms();
    for (const key of [
      'canAccessAdmin',
      'canManageTasks',
      'canManageEvents',
      'canManageUsers',
      'canManageRoles',
      'canManagePermissions',
    ]) {
      expect(client.hasPermission(CUSTOM, key)).toBe(false);
    }
  });

  it('client agrees with the definition array exactly: granted keys true, absent keys false', () => {
    const client = freshClientPerms();
    client.injectRoleOverrides(CUSTOM as never, ['canManageEvents', 'canManageUsers']);
    expect(client.hasPermission(CUSTOM, 'canManageEvents')).toBe(true);
    expect(client.hasPermission(CUSTOM, 'canManageUsers')).toBe(true);
    expect(client.hasPermission(CUSTOM, 'canManageTasks')).toBe(false);
    expect(client.hasPermission(CUSTOM, 'canAccessAdmin')).toBe(false);
  });
});

// Plan T13 is intentionally NOT a test here: the user-provider fallback
// reachability change (definition doc without an array reaches the
// role_permissions fallback) has no component harness in this repo; per
// the plan it is covered by code inspection plus the live-verification
// plan (globals/live-verification-plan.md). Recorded in test-status.md.
