/**
 * @jest-environment node
 *
 * W4 primacy contracts — crm surface (seam level).
 * OFF pin: SUPA_PRIMARY unset => PrimaryFirst helpers inert (no port
 * write), mirrors keep their never-throw dual-write behavior.
 * ON: helpers write the port FIRST and THROW on failure.
 * Everything mocked via the seam's test injection points; zero live reads.
 */
import {
  __setCrmSupaEnabledForTests,
  __setCrmSupaPortForTests,
  __setCrmSupaPrimaryForTests,
  crmSupaPrimary,
  deletePartnerPrimaryFirst,
  mirrorPartnerCreate,
  setPartnerPrimaryFirst,
  updatePartnerPrimaryFirst,
  type CrmSupaPort,
} from '@/lib/server/crm-supa';

const events: string[] = [];
let failPort = false;

function fakePort(): CrmSupaPort {
  const wrap = (op: string) => async (...args: any[]) => {
    events.push(`port:${op}:${args[1] ?? args[0]}`);
    if (failPort) throw new Error('simulated port failure');
    return { id: args[1] ?? args[0] };
  };
  return {
    listDocs: async () => [],
    getDoc: async () => null,
    setDoc: wrap('setDoc') as any,
    updateDoc: wrap('updateDoc') as any,
    deleteDoc: wrap('deleteDoc') as any,
  };
}

beforeEach(() => {
  events.length = 0;
  failPort = false;
  __setCrmSupaEnabledForTests(true);
  __setCrmSupaPortForTests(fakePort());
  __setCrmSupaPrimaryForTests(undefined);
});

afterAll(() => {
  __setCrmSupaEnabledForTests(undefined);
  __setCrmSupaPortForTests(undefined);
  __setCrmSupaPrimaryForTests(undefined);
});

describe('crm primacy — OFF pin', () => {
  it('helpers inert when primacy override is off', async () => {
    __setCrmSupaPrimaryForTests(false);
    expect(crmSupaPrimary()).toBe(false);
    await expect(setPartnerPrimaryFirst('p1', { organizationName: 'X' })).resolves.toBe(false);
    await expect(updatePartnerPrimaryFirst('p1', { status: 'active' })).resolves.toBe(false);
    await expect(deletePartnerPrimaryFirst('p1')).resolves.toBe(false);
    expect(events).toEqual([]);
  });

  it('mirror still dual-writes and never throws on port failure', async () => {
    failPort = true;
    await expect(mirrorPartnerCreate('p1', { organizationName: 'X' })).resolves.toBeUndefined();
    expect(events).toEqual(['port:setDoc:p1']);
  });
});

describe('crm primacy — ON', () => {
  beforeEach(() => __setCrmSupaPrimaryForTests(true));

  it('set/update/delete write the port and return true', async () => {
    await expect(setPartnerPrimaryFirst('p1', { organizationName: 'X' })).resolves.toBe(true);
    await expect(updatePartnerPrimaryFirst('p1', { status: 'active' })).resolves.toBe(true);
    await expect(deletePartnerPrimaryFirst('p1')).resolves.toBe(true);
    expect(events).toEqual(['port:setDoc:p1', 'port:updateDoc:p1', 'port:deleteDoc:p1']);
  });

  it('port failure throws (no silent fallback)', async () => {
    failPort = true;
    await expect(setPartnerPrimaryFirst('p1', { organizationName: 'X' })).rejects.toThrow('simulated port failure');
    await expect(updatePartnerPrimaryFirst('p1', {})).rejects.toThrow('simulated port failure');
    await expect(deletePartnerPrimaryFirst('p1')).rejects.toThrow('simulated port failure');
  });
});
