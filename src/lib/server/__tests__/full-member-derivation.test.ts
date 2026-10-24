/**
 * GOV-03 / decision pack item 31 (adopted 2026-10-24): the canonical
 * Full Member derivation is holding the `member` role (Decision 9
 * formally revisited). This suite pins, on the real production modules:
 *  - the election port (createDefaultFullMemberPort) treats a `member`
 *    primary-role holder as a Full Member and a member_basic holder as
 *    not one, and never reads stored membershipClass / fullMember
 *    fields on the users doc;
 *  - the lifecycle derivation (membershipClassOf) agrees: `member` ->
 *    'Full', member_basic -> not 'Full', stored class strings ignored;
 *  - a source guard: no production consumer reads a stored
 *    membershipClass string (or the retired class writer) anymore.
 */

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
      },
    },
  },
}));

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: { send: async () => undefined },
}));

import * as fs from 'fs';
import * as path from 'path';
import { createDefaultFullMemberPort } from '../election-ports';
import { membershipClassOf } from '../lifecycle-adapters';

// --- Minimal fake Firestore: collection().doc(id).get() + collection().get()
type Store = Record<string, Record<string, unknown>>;

function fakeDb(stores: Record<string, Store>) {
  return {
    collection(name: string) {
      const store = stores[name] ?? {};
      return {
        doc: (id: string) => ({
          get: async () => ({
            exists: id in store,
            id,
            data: () => store[id],
          }),
        }),
        get: async () => ({
          docs: Object.entries(store).map(([id, data]) => ({
            id,
            data: () => data,
          })),
        }),
      };
    },
  };
}

describe('election port: Full Member = holding the `member` role', () => {
  it('a `member` role holder is a Full Member; a member_basic holder is not', async () => {
    const db = fakeDb({
      roles: {
        full1: { role: 'member' },
        basic1: { role: 'member_basic' },
      },
      users: {
        full1: { displayName: 'Full One', chapterId: 'ist' },
        basic1: { displayName: 'Basic One', chapterId: 'ist' },
      },
    });
    const port = createDefaultFullMemberPort(db as never);
    await expect(port.isFullMember('full1')).resolves.toBe(true);
    await expect(port.isFullMember('basic1')).resolves.toBe(false);
    await expect(port.getFullMember('full1')).resolves.toMatchObject({
      uid: 'full1',
      displayName: 'Full One',
    });
    await expect(port.getFullMember('basic1')).resolves.toBeNull();
    const list = await port.listFullMembers();
    expect(list.map((m) => m.uid)).toEqual(['full1']);
  });

  it('stored membershipClass / fullMember fields on the users doc confer nothing', async () => {
    const db = fakeDb({
      roles: {
        flagged: { role: 'member_basic' },
        classed: { role: 'member_basic' },
      },
      users: {
        flagged: { displayName: 'Flagged', fullMember: true },
        classed: { displayName: 'Classed', membershipClass: 'full_member' },
        // No roles doc at all, but every legacy marker set:
        ghost: {
          displayName: 'Ghost',
          fullMember: true,
          membershipClass: 'full_member',
        },
      },
    });
    const port = createDefaultFullMemberPort(db as never);
    await expect(port.isFullMember('flagged')).resolves.toBe(false);
    await expect(port.isFullMember('classed')).resolves.toBe(false);
    await expect(port.isFullMember('ghost')).resolves.toBe(false);
    await expect(port.listFullMembers()).resolves.toEqual([]);
  });

  it('a `member` holder is a Full Member even when legacy fields deny it', async () => {
    const db = fakeDb({
      roles: { m: { role: 'member' } },
      users: {
        m: { displayName: 'Real Member', membershipClass: 'Provisional' },
      },
    });
    const port = createDefaultFullMemberPort(db as never);
    await expect(port.isFullMember('m')).resolves.toBe(true);
  });

  it('the users role mirror is the fallback when no roles doc exists', async () => {
    const db = fakeDb({
      roles: {},
      users: { m: { displayName: 'Mirror Member', role: 'member' } },
    });
    const port = createDefaultFullMemberPort(db as never);
    await expect(port.isFullMember('m')).resolves.toBe(true);
  });
});

describe('lifecycle path: membershipClassOf derives from the role', () => {
  it("`member` -> 'Full'; member_basic -> not 'Full'", async () => {
    const db = fakeDb({
      roles: {
        full1: { role: 'member' },
        basic1: { role: 'member_basic' },
      },
      users: { full1: {}, basic1: {} },
    });
    await expect(membershipClassOf(db as never, 'full1')).resolves.toBe('Full');
    await expect(
      membershipClassOf(db as never, 'basic1'),
    ).resolves.toBe('Provisional');
  });

  it('agrees with the election port on the same records', async () => {
    const db = fakeDb({
      roles: {
        a: { role: 'member' },
        b: { role: 'member_basic' },
        c: { role: 'member', membershipClass: 'Full' },
      },
      users: {
        a: { membershipClass: 'Full' },
        b: { membershipClass: 'Full' },
        c: {},
      },
    });
    const port = createDefaultFullMemberPort(db as never);
    for (const uid of ['a', 'b', 'c']) {
      const viaPort = await port.isFullMember(uid);
      const viaLifecycle = (await membershipClassOf(db as never, uid)) === 'Full';
      expect(viaLifecycle).toBe(viaPort);
    }
    // 'b' carries a stored 'Full' class yet is not a Full Member on
    // either path; 'a' is one purely by role.
    await expect(port.isFullMember('a')).resolves.toBe(true);
    await expect(port.isFullMember('b')).resolves.toBe(false);
  });
});

describe('source guard: no production consumer reads a stored membershipClass', () => {
  const root = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const consumers: Record<string, string> = {
    'election-ports': read('src/lib/server/election-ports.ts'),
    'election-roll': read('src/lib/server/election-roll.ts'),
    'lifecycle-adapters': read('src/lib/server/lifecycle-adapters.ts'),
    'lifecycle-probation': read('src/lib/server/lifecycle-probation.ts'),
    'lifecycle-guard': read('src/lib/server/lifecycle-guard.ts'),
    agm: read('src/lib/server/agm.ts'),
    'election-nominations': read('src/lib/server/election-nominations.ts'),
    'elections types': read('src/types/elections.ts'),
    'cadetship decision route': read(
      'src/app/api/cadetships/[id]/decision/route.ts',
    ),
    'cadetship cron stanza': read('src/lib/server/cadetship/cron-stanza.ts'),
    'dues-adapter': read('src/lib/server/cadetship/dues-adapter.ts'),
  };

  it.each(Object.entries(consumers))(
    '%s does not test a stored membershipClass / fullMember field',
    (_name, src) => {
      expect(src).not.toMatch(/\.membershipClass\s*(===|!==|==|!=)/);
      expect(src).not.toMatch(/\.fullMember\s*===\s*true/);
      expect(src).not.toMatch(/['"]full_member['"]/);
    },
  );

  it('the class writer is retired: no export, no throw site, no caller', () => {
    expect(consumers['dues-adapter']).not.toMatch(
      /export\s+async\s+function\s+setMembershipClass/,
    );
    expect(consumers['dues-adapter']).not.toMatch(
      /class\s+MembershipClassUnavailableError/,
    );
    expect(consumers['cadetship decision route']).not.toContain(
      'setMembershipClass(',
    );
    expect(consumers['cadetship cron stanza']).not.toContain(
      'setMembershipClass(',
    );
  });

  it('both derivations pin the `member` role as the test', () => {
    expect(consumers['election-ports']).toContain('primaryRole !== "member"');
    expect(consumers['lifecycle-adapters']).toContain(
      "primaryRole === 'member'",
    );
  });
});
