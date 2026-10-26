/**
 * @jest-environment node
 *
 * W4 primacy contracts — blog surface.
 * OFF pin: SUPA_PRIMARY unset => PrimaryFirst helpers inert, callers run
 * Firestore-first + best-effort mirror exactly as pre-cutover.
 * ON: adapter write lands FIRST and THROWS on failure (no Firestore
 * write follows); on success the Firestore write runs as best-effort
 * post-commit mirror. Everything mocked; zero live reads.
 */

const mockSupa = {
  enabled: false,
  primary: false,
  fail: false,
  events: [] as string[],
};

jest.mock('@/lib/supa', () => ({
  useSupa: (surface: string) => surface === 'blog' && mockSupa.enabled,
  isSupaPrimary: (surface: string) =>
    surface === 'blog' && mockSupa.enabled && mockSupa.primary,
  getSupaClient: () => ({}),
  getSupaAdapter: () => ({
    setDoc: async (_col: string, id: string) => {
      mockSupa.events.push(`adapter:setDoc:${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      return { id };
    },
    updateDoc: async (_col: string, id: string) => {
      mockSupa.events.push(`adapter:updateDoc:${id}`);
      if (mockSupa.fail) throw new Error('simulated adapter failure');
      return { id };
    },
    listDocs: async () => [],
    getDoc: async () => null,
    countDocs: async () => 0,
    deleteDoc: async () => undefined,
  }),
}));

const mockFs = { events: [] as string[], failSet: false };

function fakeDocRef(id: string) {
  return {
    id,
    set: async () => {
      mockFs.events.push(`firestore:set:${id}`);
      if (mockFs.failSet) throw new Error('simulated firestore failure');
    },
    update: async () => {
      mockFs.events.push(`firestore:update:${id}`);
      if (mockFs.failSet) throw new Error('simulated firestore failure');
    },
  };
}

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => ({
    collection: (_name: string) => ({
      doc: (id?: string) => fakeDocRef(id ?? 'generated-id'),
    }),
  }),
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
}));

import {
  blogSupaPrimary,
  setBlogPrimaryFirst,
  updateBlogPrimaryFirst,
} from '@/lib/server/blog-supa';
import { createBlogPost, updateBlogPost } from '@/lib/server/blog-server';

beforeEach(() => {
  mockSupa.enabled = false;
  mockSupa.primary = false;
  mockSupa.fail = false;
  mockSupa.events = [];
  mockFs.events = [];
  mockFs.failSet = false;
});

describe('blog primacy — OFF pin', () => {
  it('surface ON but SUPA_PRIMARY unset: helpers inert, no adapter write', async () => {
    mockSupa.enabled = true;
    expect(blogSupaPrimary()).toBe(false);
    await expect(setBlogPrimaryFirst('b1', { title: 'x' })).resolves.toBe(false);
    await expect(updateBlogPrimaryFirst('b1', { title: 'x' })).resolves.toBe(false);
    expect(mockSupa.events).toEqual([]);
  });

  it('createBlogPost OFF: Firestore first, mirror second', async () => {
    mockSupa.enabled = true; // dual-write state
    const id = await createBlogPost({ title: 'hello' });
    expect(id).toBe('generated-id');
    expect(mockFs.events).toEqual(['firestore:set:generated-id']);
    expect(mockSupa.events).toEqual(['adapter:setDoc:generated-id']);
  });

  it('createBlogPost fully OFF: Firestore only', async () => {
    const id = await createBlogPost({ title: 'hello' });
    expect(id).toBe('generated-id');
    expect(mockFs.events).toEqual(['firestore:set:generated-id']);
    expect(mockSupa.events).toEqual([]);
  });

  it('updateBlogPost OFF: Firestore update + mirror update', async () => {
    mockSupa.enabled = true;
    await expect(updateBlogPost('b9', { title: 'y' })).resolves.toBe(true);
    expect(mockFs.events).toEqual(['firestore:update:b9']);
    expect(mockSupa.events).toEqual(['adapter:updateDoc:b9']);
  });
});

describe('blog primacy — ON', () => {
  beforeEach(() => {
    mockSupa.enabled = true;
    mockSupa.primary = true;
  });

  it('helpers write adapter and return true', async () => {
    expect(blogSupaPrimary()).toBe(true);
    await expect(setBlogPrimaryFirst('b1', { title: 'x' })).resolves.toBe(true);
    await expect(updateBlogPrimaryFirst('b1', { title: 'x' })).resolves.toBe(true);
    expect(mockSupa.events).toEqual(['adapter:setDoc:b1', 'adapter:updateDoc:b1']);
  });

  it('createBlogPost ON: adapter first, Firestore as mirror', async () => {
    const order: string[] = [];
    mockSupa.events = order;
    mockFs.events = order;
    const id = await createBlogPost({ title: 'hello' });
    expect(id).toBe('generated-id');
    expect(order).toEqual(['adapter:setDoc:generated-id', 'firestore:set:generated-id']);
  });

  it('createBlogPost ON + adapter failure: throws, Firestore never written', async () => {
    mockSupa.fail = true;
    await expect(createBlogPost({ title: 'hello' })).rejects.toThrow('simulated adapter failure');
    expect(mockFs.events).toEqual([]);
  });

  it('createBlogPost ON + Firestore mirror failure: still succeeds', async () => {
    mockFs.failSet = true;
    await expect(createBlogPost({ title: 'hello' })).resolves.toBe('generated-id');
    expect(mockSupa.events).toEqual(['adapter:setDoc:generated-id']);
  });

  it('updateBlogPost ON + adapter failure: throws, Firestore never written', async () => {
    mockSupa.fail = true;
    await expect(updateBlogPost('b9', { title: 'y' })).rejects.toThrow('simulated adapter failure');
    expect(mockFs.events).toEqual([]);
  });
});
