/**
 * @jest-environment node
 *
 * Tests for GET/POST /api/gallery-assets (src/app/api/gallery-assets/route.ts).
 *
 * GET:
 * (a) Without a status param the route defaults to status=published and only
 *     published assets are returned.
 * (b) ?status=all returns every asset without a status filter.
 * (c) When the composite (status + updatedAt) index is missing, the indexed
 *     query throws and the route falls back to the filter-only query instead
 *     of returning 500.
 *
 * POST:
 * (a) assetUrl must end in .glb or .gltf (case-insensitive); anything else is
 *     a 400 with no Firestore write.
 * (b) A missing status defaults to "published" on the stored document.
 * (c) Unauthenticated callers get 401; authenticated callers without the
 *     manageGallery permission get 403.
 */

const mockState = {
  assets: [
    {
      id: 'asset-pub-1',
      data: { title: 'Published One', status: 'published', updatedAt: 3 },
    },
    {
      id: 'asset-draft-1',
      data: { title: 'Draft One', status: 'draft', updatedAt: 2 },
    },
    {
      id: 'asset-pub-2',
      data: { title: 'Published Two', status: 'published', updatedAt: 1 },
    },
  ] as Array<{ id: string; data: Record<string, unknown> }>,
  indexMissing: false,
  queryCalls: [] as string[],
  authResult: {
    authenticated: true,
    user: { userId: 'test-uid', role: 'admin' },
  } as any,
  permissionGranted: true,
  addedAssets: [] as Array<Record<string, unknown>>,
  auditEntries: [] as Array<Record<string, unknown>>,
};

function toSnap(rows: typeof mockState.assets) {
  const sorted = [...rows].sort(
    (a, b) => Number(b.data.updatedAt) - Number(a.data.updatedAt)
  );
  return {
    docs: sorted.map((r) => ({ id: r.id, data: () => r.data })),
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name === 'audit_logs') {
      return {
        add: async (doc: Record<string, unknown>) => {
          mockState.auditEntries.push(doc);
          return { id: 'audit-1' };
        },
      };
    }
    // galleryAssets collection.
    return {
      add: async (doc: Record<string, unknown>) => {
        mockState.addedAssets.push(doc);
        return { id: 'new-asset-id' };
      },
      orderBy: (_field: string, _dir: string) => ({
        limit: (_n: number) => ({
          get: async () => {
            mockState.queryCalls.push('orderBy.limit');
            return toSnap(mockState.assets);
          },
        }),
      }),
      where: (field: string, _op: string, value: string) => {
        const rows = mockState.assets.filter(
          (a) => a.data[field] === value
        );
        return {
          orderBy: (_f: string, _d: string) => ({
            limit: (_n: number) => ({
              get: async () => {
                mockState.queryCalls.push('where.orderBy.limit');
                if (mockState.indexMissing) {
                  throw new Error(
                    'The query requires an index. You can create it here.'
                  );
                }
                return toSnap(rows);
              },
            }),
          }),
          // Fallback query: filter only, no orderBy (used when the
          // composite index does not exist yet).
          limit: (_n: number) => ({
            get: async () => {
              mockState.queryCalls.push('where.limit');
              return toSnap(rows);
            },
          }),
        };
      },
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: jest.fn(() => mockDb),
}));

jest.mock('@/lib/auth-middleware', () => ({
  verifyAuthentication: jest.fn(async () => mockState.authResult),
}));

jest.mock('@/config/permissions', () => ({
  hasPermission: jest.fn(
    (_role: unknown, _permission: string) => mockState.permissionGranted
  ),
}));

import { GET, POST } from '@/app/api/gallery-assets/route';
import { NextRequest } from 'next/server';

function getRequest(url: string) {
  return new NextRequest(url, { method: 'GET' });
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/gallery-assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Mars Rover Model',
    assetUrl: 'https://cdn.example.com/models/rover.glb',
    description: 'A 3D model of the mission rover.',
    ...overrides,
  };
}

beforeEach(() => {
  mockState.indexMissing = false;
  mockState.queryCalls = [];
  mockState.addedAssets = [];
  mockState.auditEntries = [];
  mockState.authResult = {
    authenticated: true,
    user: { userId: 'test-uid', role: 'admin' },
  };
  mockState.permissionGranted = true;
  jest.clearAllMocks();
});

describe('GET /api/gallery-assets', () => {
  it('returns only published assets when no status param is given', async () => {
    const res = await GET(getRequest('http://localhost/api/gallery-assets'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i: any) => i.status === 'published')).toBe(true);
    // Sorted by updatedAt desc, same as the orderBy query would return.
    expect(body.items.map((i: any) => i.id)).toEqual([
      'asset-pub-1',
      'asset-pub-2',
    ]);
    // Went through the status filter + orderBy query, no fallback needed.
    expect(mockState.queryCalls).toEqual(['where.orderBy.limit']);
  });

  it('returns all assets when status=all', async () => {
    const res = await GET(
      getRequest('http://localhost/api/gallery-assets?status=all')
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    const statuses = body.items.map((i: any) => i.status).sort();
    expect(statuses).toEqual(['draft', 'published', 'published']);
    // listAll path: no status filter at all.
    expect(mockState.queryCalls).toEqual(['orderBy.limit']);
  });

  it('falls back to the filter-only query when the composite index is missing', async () => {
    mockState.indexMissing = true;

    const res = await GET(getRequest('http://localhost/api/gallery-assets'));

    // No 500: the route recovers and still returns the published assets.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i: any) => i.status === 'published')).toBe(true);
    // The indexed query was tried first and failed, then the filter-only
    // fallback query ran.
    expect(mockState.queryCalls).toEqual([
      'where.orderBy.limit',
      'where.limit',
    ]);
  });
});

describe('POST /api/gallery-assets', () => {
  it('rejects an assetUrl that does not end in .glb or .gltf', async () => {
    const res = await POST(
      postRequest(
        validBody({ assetUrl: 'https://cdn.example.com/preview.png' })
      )
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('.glb');
    // Nothing was written to Firestore or the audit log.
    expect(mockState.addedAssets).toHaveLength(0);
    expect(mockState.auditEntries).toHaveLength(0);
  });

  it('accepts .glb and .gltf assetUrls, case-insensitively', async () => {
    const lower = await POST(
      postRequest(validBody({ assetUrl: 'https://cdn.example.com/scene.gltf' }))
    );
    expect(lower.status).toBe(201);

    const upper = await POST(
      postRequest(validBody({ assetUrl: 'https://cdn.example.com/ROVER.GLB' }))
    );
    expect(upper.status).toBe(201);

    expect(mockState.addedAssets).toHaveLength(2);
  });

  it('defaults status to published when the body omits it', async () => {
    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'new-asset-id' });
    expect(mockState.addedAssets).toHaveLength(1);
    const stored = mockState.addedAssets[0];
    expect(stored.status).toBe('published');
    expect(stored.title).toBe('Mars Rover Model');
    expect(stored.createdBy).toBe('test-uid');
    // Audit entry was written best-effort.
    expect(mockState.auditEntries).toHaveLength(1);
    expect(mockState.auditEntries[0].action).toBe('gallery_asset_created');
  });

  it('keeps an explicit status instead of overriding it', async () => {
    const res = await POST(postRequest(validBody({ status: 'draft' })));

    expect(res.status).toBe(201);
    expect(mockState.addedAssets).toHaveLength(1);
    expect(mockState.addedAssets[0].status).toBe('draft');
  });

  it('returns 401 when the caller is not authenticated', async () => {
    mockState.authResult = { authenticated: false, error: 'Unauthorized' };

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(401);
    expect(mockState.addedAssets).toHaveLength(0);
  });

  it('returns 403 when the caller lacks the manageGallery permission', async () => {
    mockState.permissionGranted = false;

    const res = await POST(postRequest(validBody()));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Insufficient permissions');
    expect(mockState.addedAssets).toHaveLength(0);
  });
});
