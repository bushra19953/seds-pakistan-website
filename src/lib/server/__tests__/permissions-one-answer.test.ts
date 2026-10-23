/**
 * @jest-environment node
 *
 * PERM-RESOLUTION (Custom Roles Fix Program) - THE one-answer matrix.
 *
 * Contracts Section 4.4: "Any key disagreement between client and server
 * for the same holder + key is a defect in whichever side deviates from
 * roleDefinitions/{slug}.permissions."
 *
 * For each fixture definition, the SAME question (holder, key) is asked
 * through every entry point the program names:
 *   1. RAW-TOKEN server path - hasServerPermission(stored custom slug),
 *      the pattern the tasks route already uses (audit B section d);
 *   2. AUTH/HOLDER path - the holder-level resolution behind
 *      verifyAuthentication (contracts 4.4: the mainstream path extends
 *      the roles-doc read to surface held custom slugs; plan section 5
 *      names the entry point hasServerPermissionForUser(db, uid, key)).
 *      If neither that export nor an equivalent holder answer exists,
 *      these rows fail as MISSING IMPLEMENTATION;
 *   3. CLIENT path - injectRoleOverrides(slug, definition.permissions)
 *      then hasPermission(slug, key), the exact shape user-provider.tsx
 *      produces from the same definition doc (audit B).
 *
 * Every row runs WITH the SEC-11 shadow fixture present (a
 * roleDefinitions/member_basic doc carrying a permissions array), so the
 * matrix also proves the floor doc cannot move any answer.
 */

const mockDbHolder: { db: unknown } = { db: null };
jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => mockDbHolder.db,
  ensureAdminInitialized: () => true,
  admin: {
    firestore: {
      FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del' },
    },
  },
}));

import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';
import * as serverPerms from '../permissions';
import type { PermissionKey } from '@/config/permissions.config';

const CUSTOM = 'custom_poster_team_lead';
const CHAPTER = 'seds-ist-chapter';
const HOLDER = 'holder-uid';

type UserScopedFn = (
  db: unknown,
  uid: string,
  permission: PermissionKey,
) => Promise<boolean>;
const hasServerPermissionForUser = (
  serverPerms as unknown as Record<string, unknown>
).hasServerPermissionForUser as UserScopedFn | undefined;

interface ClientPerms {
  hasPermission: (role: string | null, permission: string) => boolean;
  injectRoleOverrides: (role: never, customPermissions: string[]) => void;
}

function clientAnswer(definitionPermissions: string[], key: PermissionKey): boolean {
  let answer: boolean | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const client = require('@/config/permissions') as ClientPerms;
    client.injectRoleOverrides(CUSTOM as never, definitionPermissions);
    answer = client.hasPermission(CUSTOM, key);
  });
  if (answer === undefined) throw new Error('client module failed to load');
  return answer;
}

async function holderAnswer(
  fake: FakeFirestore,
  key: PermissionKey,
): Promise<boolean> {
  if (typeof hasServerPermissionForUser !== 'function') {
    throw new Error(
      'MISSING IMPLEMENTATION: no holder-level permission entry point ' +
        '(hasServerPermissionForUser, plan section 5 / contracts 4.4) - the ' +
        'auth path cannot yet give the same answer as the raw-token path',
    );
  }
  return hasServerPermissionForUser(fake.asDb(), HOLDER, key);
}

const KEYS: PermissionKey[] = [
  'canManageTasks',
  'canManageEvents',
  'canManageUsers',
  'canManageRoles',
  'canManagePermissions',
];

interface Row {
  name: string;
  definitionPermissions: string[];
  expected: Record<PermissionKey, boolean>;
}

const ROWS: Row[] = [
  {
    name: 'definition grants canManageTasks only',
    definitionPermissions: ['canManageTasks'],
    expected: {
      canManageTasks: true,
      canManageEvents: false,
      canManageUsers: false,
      canManageRoles: false,
      canManagePermissions: false,
    },
  },
  {
    name: 'definition grants canManageEvents + canManageUsers',
    definitionPermissions: ['canManageEvents', 'canManageUsers'],
    expected: {
      canManageTasks: false,
      canManageEvents: true,
      canManageUsers: true,
      canManageRoles: false,
      canManagePermissions: false,
    },
  },
  {
    name: 'definition grants nothing (empty array)',
    definitionPermissions: [],
    expected: {
      canManageTasks: false,
      canManageEvents: false,
      canManageUsers: false,
      canManageRoles: false,
      canManagePermissions: false,
    },
  },
  {
    name: 'poisoned definition (Reserved Powers smuggled into the array)',
    definitionPermissions: ['canManageRoles', 'canManagePermissions', 'canManageTasks'],
    expected: {
      canManageTasks: true,
      canManageEvents: false,
      canManageUsers: false,
      canManageRoles: false,
      canManagePermissions: false,
    },
  },
];

describe('one-answer matrix (shadow fixture present in every row)', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      let fake: FakeFirestore;
      beforeEach(() => {
        fake = new FakeFirestore();
        mockDbHolder.db = fake.asDb();
        fake.seed('roleDefinitions', CUSTOM, {
          isCustom: true,
          parentRoleKey: 'chapter_design_chair',
          chapterId: CHAPTER,
          name: 'Poster Team Lead',
          permissions: row.definitionPermissions,
        });
        // SEC-11 shadow: would flip several answers if the floor doc
        // were ever consulted before (or instead of) the custom doc.
        fake.seed('roleDefinitions', 'member_basic', {
          name: 'Basic Member',
          permissions: ['canManageTasks', 'canManageEvents', 'canManageUsers'],
        });
        fake.seed('roles', HOLDER, {
          role: 'member',
          additionalRoles: [CUSTOM],
          chapterId: CHAPTER,
        });
      });

      for (const key of KEYS) {
        it(`${key} -> ${row.expected[key]} on all three paths`, async () => {
          const expected = row.expected[key];
          const rawToken = await serverPerms.hasServerPermission(CUSTOM, key);
          const holder = await holderAnswer(fake, key);
          const client = clientAnswer(row.definitionPermissions, key);
          expect(rawToken).toBe(expected);
          expect(holder).toBe(expected);
          expect(client).toBe(expected);
        });
      }
    });
  }
});
