/**
 * @jest-environment node
 *
 * W4 primacy contracts — organizations / resources / forms seams.
 * OFF pin: SUPA_PRIMARY unset => PrimaryFirst helpers inert, no adapter
 * write. ON: adapter write lands and returns true; adapter failure
 * THROWS. Everything mocked; zero live reads.
 */

const mockSupa = {
  surfaces: new Set<string>(),
  primary: new Set<string>(),
  fail: false,
  events: [] as string[],
};

jest.mock('@/lib/supa', () => ({
  useSupa: (s: string) => mockSupa.surfaces.has(s),
  isSupaPrimary: (s: string) => mockSupa.surfaces.has(s) && mockSupa.primary.has(s),
  getSupaClient: () => ({}),
  getSupaAdapter: () => ({
    setDoc: async (col: string, id: string) => {
      mockSupa.events.push(`adapter:setDoc:${col}:${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      return { id };
    },
    updateDoc: async (col: string, id: string) => {
      mockSupa.events.push(`adapter:updateDoc:${col}:${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      return { id };
    },
    deleteDoc: async () => undefined,
    listDocs: async () => [],
    getDoc: async () => null,
    countDocs: async () => 0,
  }),
}));

import { setOrganizationPrimaryFirst, organizationsSupaPrimary } from '@/lib/server/organizations-supa';
import { setResourcePrimaryFirst, setCompetitionPrimaryFirst, resourcesSupaPrimary } from '@/lib/server/resources-supa';
import { setFormPrimaryFirst, setFormResponsePrimaryFirst, formsSupaPrimary } from '@/lib/server/forms-supa';

beforeEach(() => {
  mockSupa.surfaces = new Set(['organizations', 'resources', 'forms']);
  mockSupa.primary = new Set();
  mockSupa.fail = false;
  mockSupa.events = [];
});

describe('OFF pin (dual-write state: surfaces on, primacy off)', () => {
  it('all helpers inert', async () => {
    expect(organizationsSupaPrimary()).toBe(false);
    expect(resourcesSupaPrimary()).toBe(false);
    expect(formsSupaPrimary()).toBe(false);
    await expect(setOrganizationPrimaryFirst('o1', {})).resolves.toBe(false);
    await expect(setResourcePrimaryFirst('r1', {})).resolves.toBe(false);
    await expect(setCompetitionPrimaryFirst('c1', {})).resolves.toBe(false);
    await expect(setFormPrimaryFirst('f1', {})).resolves.toBe(false);
    await expect(setFormResponsePrimaryFirst('f1', 'resp1', {})).resolves.toBe(false);
    expect(mockSupa.events).toEqual([]);
  });
});

describe('ON', () => {
  beforeEach(() => {
    mockSupa.primary = new Set(['organizations', 'resources', 'forms']);
  });

  it('writes land on the right collections/paths', async () => {
    await expect(setOrganizationPrimaryFirst('o1', { name: 'Org' })).resolves.toBe(true);
    await expect(setResourcePrimaryFirst('r1', { title: 'R' })).resolves.toBe(true);
    await expect(setCompetitionPrimaryFirst('c1', { title: 'C' })).resolves.toBe(true);
    await expect(setFormPrimaryFirst('f1', { title: 'F' })).resolves.toBe(true);
    await expect(setFormResponsePrimaryFirst('f1', 'resp1', { data: {} })).resolves.toBe(true);
    expect(mockSupa.events).toEqual([
      'adapter:setDoc:organizations:o1',
      'adapter:setDoc:resources:r1',
      'adapter:setDoc:competitions:c1',
      'adapter:setDoc:forms:f1',
      'adapter:setDoc:forms/f1/responses:resp1',
    ]);
  });

  it('adapter failure throws', async () => {
    mockSupa.fail = true;
    await expect(setOrganizationPrimaryFirst('o1', {})).rejects.toThrow('simulated adapter failure');
    await expect(setFormPrimaryFirst('f1', {})).rejects.toThrow('simulated adapter failure');
    await expect(setFormResponsePrimaryFirst('f1', 'resp1', {})).rejects.toThrow('simulated adapter failure');
  });

  it('per-surface isolation: only the named token goes primary', async () => {
    mockSupa.primary = new Set(['forms']);
    await expect(setOrganizationPrimaryFirst('o1', {})).resolves.toBe(false);
    await expect(setResourcePrimaryFirst('r1', {})).resolves.toBe(false);
    await expect(setFormPrimaryFirst('f1', {})).resolves.toBe(true);
  });
});
