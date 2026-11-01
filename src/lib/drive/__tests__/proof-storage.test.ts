/**
 * @jest-environment node
 *
 * Per-person proof storage: task proof uploads (document/video with a
 * `task-<id>` context) must land in the uploader's own folder under
 * "SEDS Proof Submissions" with a stored name of the fixed pattern
 *   YYYY-MM-DD_<person-slug>_<taskId>_<kind>_<original>
 * instead of the shared kind folders with `<millis>_...` names.
 *
 * Asserts:
 * - buildUniqueName emits the exact person pattern (and sanitizes), and
 *   keeps the legacy pattern for every non-person call.
 * - resolvePersonFolder creates root + person folder on first use, durably
 *   maps uid -> folderId in Firestore, reuses the mapping afterwards, and
 *   adopts the winner's folder when two first uploads race the mapping
 *   create.
 * - The slug comes from the users doc (displayName, else name, else email
 *   local part, else 'member'); folder names embed the uid, so two people
 *   with the same display name get different folders.
 * - initiate and complete AGREE on the person folder: initiate mints the
 *   resumable session into it, complete accepts a file there (by id and by
 *   name lookup, with the lookup scoped to the person folder) and rejects
 *   a file that landed in the old shared kind folder with the 502
 *   drive-error shape — the trap that would break every proof completion
 *   if only one of the two routes changed.
 * - Non-task uploads are unchanged: document with a non-task context and
 *   non-document kinds keep the kind folder and the legacy name, and a
 *   complete call without a context (older clients) still verifies
 *   against the kind folder.
 *
 * Drive is mocked at the googleapis boundary and Firestore at the
 * firebase-admin module boundary, so the real folders.ts, upload-handler
 * and both upload routes run unmocked. No test touches real Drive,
 * Firestore, or any user file.
 */

const mockFilesGet = jest.fn();
const mockFilesList = jest.fn();
const mockFilesCreate = jest.fn();
const mockPermissionsCreate = jest.fn(async () => ({}));
const mockDrive = {
  files: {
    get: mockFilesGet,
    list: mockFilesList,
    create: mockFilesCreate,
  },
  permissions: {
    create: mockPermissionsCreate,
  },
};

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        setCredentials(): void {}
        async getAccessToken(): Promise<{ token: string }> {
          return { token: 'mock-access-token' };
        }
      },
    },
    drive: jest.fn(() => mockDrive),
  },
}));

const mockSessionUid = { current: 'uid-ahmed' };

jest.mock('@/lib/auth/verifySession', () => {
  class MockSessionError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 401) {
      super(message);
      this.name = 'SessionError';
      this.statusCode = statusCode;
    }
  }
  return {
    SessionError: MockSessionError,
    extractBearerToken: jest.fn(() => 'mock-token'),
    verifyIdTokenString: jest.fn(async () => ({ uid: mockSessionUid.current })),
    verifySession: jest.fn(async () => ({ uid: mockSessionUid.current })),
    toSessionErrorResponse: jest.fn(() => null),
  };
});

jest.mock('@/lib/server/upload-logger', () => ({
  logUpload: jest.fn(async () => null),
  markUploadCompleted: jest.fn(async () => null),
}));

// In-memory Firestore stand-in: `users` docs seed person slugs, and
// `drive_person_folders` is the durable uid -> folderId mapping the SUT
// writes. create() enforces Firestore's atomic ALREADY_EXISTS semantics.
const mockUserDocs = new Map<string, Record<string, unknown>>();
const mockFolderMapDocs = new Map<string, Record<string, unknown>>();
const mockMapCreateHook: { current: null | (() => void) } = { current: null };

jest.mock('@/lib/server/firebase-admin', () => {
  function docRef(collection: string, id: string) {
    const store = collection === 'users' ? mockUserDocs : mockFolderMapDocs;
    return {
      async get() {
        const data = store.get(id);
        return { exists: data !== undefined, data: () => data };
      },
      async create(data: Record<string, unknown>) {
        if (mockMapCreateHook.current && collection !== 'users') {
          const hook = mockMapCreateHook.current;
          mockMapCreateHook.current = null;
          hook();
        }
        if (store.has(id)) {
          const err = new Error('6 ALREADY_EXISTS: document already exists') as Error & {
            code?: number;
          };
          err.code = 6;
          throw err;
        }
        store.set(id, data);
        return {};
      },
    };
  }
  return {
    admin: {
      firestore: {
        FieldValue: {
          serverTimestamp: () => 'server-ts',
        },
      },
    },
    getDb: jest.fn(() => ({
      collection: (name: string) => ({
        doc: (id: string) => docRef(name, id),
      }),
    })),
  };
});

process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
process.env.GOOGLE_DRIVE_DOCUMENTS_FOLDER_ID = 'kind-doc-folder';
process.env.GOOGLE_DRIVE_VIDEOS_FOLDER_ID = 'kind-video-folder';
delete process.env.GOOGLE_DRIVE_PROOF_SUBMISSIONS_FOLDER_ID;

import { NextRequest } from 'next/server';

type Modules = {
  folders: typeof import('@/lib/drive/folders');
  handler: typeof import('@/lib/drive/upload-handler');
  initiatePOST: (typeof import('@/app/api/uploads/initiate/route'))['POST'];
  completePOST: (typeof import('@/app/api/uploads/complete/route'))['POST'];
};

async function loadModules(): Promise<Modules> {
  const folders = await import('@/lib/drive/folders');
  const handler = await import('@/lib/drive/upload-handler');
  const initiate = await import('@/app/api/uploads/initiate/route');
  const complete = await import('@/app/api/uploads/complete/route');
  return {
    folders,
    handler,
    initiatePOST: initiate.POST,
    completePOST: complete.POST,
  };
}

function jsonRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ROOT_ID = 'folder:SEDS Proof Submissions';
const AHMED_FOLDER_NAME = 'ahmed-ali-uid-ahmed';
const AHMED_FOLDER_ID = `folder:${AHMED_FOLDER_NAME}`;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockUserDocs.clear();
  mockFolderMapDocs.clear();
  mockMapCreateHook.current = null;
  mockSessionUid.current = 'uid-ahmed';
  mockUserDocs.set('uid-ahmed', { displayName: 'Ahmed Ali', email: 'ahmed@example.com' });

  // Default Drive behaviour: nothing exists yet; creating a folder yields
  // a name-derived id so assertions can name the folder they expect.
  mockFilesList.mockResolvedValue({ data: { files: [] } });
  mockFilesCreate.mockImplementation(async (args: { requestBody: { name: string } }) => ({
    data: { id: `folder:${args.requestBody.name}` },
  }));
  mockPermissionsCreate.mockResolvedValue({});
});

describe('buildUniqueName person pattern', () => {
  it('emits YYYY-MM-DD_<slug>_<taskId>_<kind>_<sanitized original>', async () => {
    const { handler } = await loadModules();
    const name = handler.buildUniqueName('document', 'Annual Report.PDF', 'task-Task123', {
      personSlug: 'ahmed-ali',
      now: new Date('2026-11-01T10:20:30Z'),
    });
    expect(name).toBe('2026-11-01_ahmed-ali_Task123_document_Annual_Report.PDF');
  });

  it('uses the same pattern for video proofs', async () => {
    const { handler } = await loadModules();
    const name = handler.buildUniqueName('video', 'teaser cut.mp4', 'task-T9', {
      personSlug: 'maira-batool',
      now: new Date('2026-10-30T23:59:00Z'),
    });
    expect(name).toBe('2026-10-30_maira-batool_T9_video_teaser_cut.mp4');
  });

  it('keeps the legacy millis pattern when no person slug is given', async () => {
    const { handler } = await loadModules();
    const name = handler.buildUniqueName('document', 'report.pdf', 'task-Task123');
    expect(name).toMatch(/^\d+_document_task-Task123_report\.pdf$/);
  });

  it('keeps the legacy pattern for a person slug without a task context', async () => {
    const { handler } = await loadModules();
    const name = handler.buildUniqueName('document', 'report.pdf', 'general', {
      personSlug: 'ahmed-ali',
      now: new Date('2026-11-01T00:00:00Z'),
    });
    expect(name).toMatch(/^\d+_document_general_report\.pdf$/);
  });
});

describe('slugifyPersonName', () => {
  it('slugifies display names and falls back to member', async () => {
    const { folders } = await loadModules();
    expect(folders.slugifyPersonName('Ahmed Ali')).toBe('ahmed-ali');
    expect(folders.slugifyPersonName('  Syeda   Roha Zehra ')).toBe('syeda-roha-zehra');
    expect(folders.slugifyPersonName('')).toBe('member');
    expect(folders.slugifyPersonName('!!!')).toBe('member');
  });
});

describe('resolvePersonFolder', () => {
  it('creates the root and the person folder on first use and writes the mapping', async () => {
    const { folders } = await loadModules();

    const person = await folders.resolvePersonFolder('uid-ahmed');

    expect(person).toEqual({
      folderId: AHMED_FOLDER_ID,
      slug: 'ahmed-ali',
      folderName: AHMED_FOLDER_NAME,
    });
    // Root created first, then the person folder as its child.
    expect(mockFilesCreate).toHaveBeenCalledTimes(2);
    expect(mockFilesCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestBody: expect.objectContaining({ name: 'SEDS Proof Submissions' }),
      }),
    );
    expect(mockFilesCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestBody: expect.objectContaining({
          name: AHMED_FOLDER_NAME,
          parents: [ROOT_ID],
        }),
      }),
    );
    // Durable mapping written for later (and other-process) resolutions.
    expect(mockFolderMapDocs.get('uid-ahmed')).toEqual(
      expect.objectContaining({ folderId: AHMED_FOLDER_ID, slug: 'ahmed-ali' }),
    );
  });

  it('reuses the Firestore mapping on a fresh process instead of recreating folders', async () => {
    const first = await loadModules();
    await first.folders.resolvePersonFolder('uid-ahmed');
    expect(mockFilesCreate).toHaveBeenCalledTimes(2);

    jest.resetModules();
    const second = await loadModules();
    const person = await second.folders.resolvePersonFolder('uid-ahmed');

    expect(person.folderId).toBe(AHMED_FOLDER_ID);
    expect(mockFilesCreate).toHaveBeenCalledTimes(2); // no new folders
  });

  it('adopts the winner folder when two first uploads race the mapping create', async () => {
    const { folders } = await loadModules();
    // Our own create lands a folder; concurrently the winner's mapping
    // appears first, so our guarded create() loses with ALREADY_EXISTS.
    mockFilesCreate.mockImplementation(async (args: { requestBody: { name: string } }) => ({
      data: { id: `folder:loser-${args.requestBody.name}` },
    }));
    mockMapCreateHook.current = () => {
      mockFolderMapDocs.set('uid-ahmed', { folderId: 'folder:winner', slug: 'ahmed-ali' });
    };

    const person = await folders.resolvePersonFolder('uid-ahmed');

    expect(person.folderId).toBe('folder:winner');
    expect(mockFolderMapDocs.get('uid-ahmed')?.folderId).toBe('folder:winner');
  });

  it('gives two people with the same display name different folders', async () => {
    mockUserDocs.set('uid-ahmed-2', { displayName: 'Ahmed Ali', email: 'other@example.com' });
    const { folders } = await loadModules();

    const one = await folders.resolvePersonFolder('uid-ahmed');
    const two = await folders.resolvePersonFolder('uid-ahmed-2');

    expect(one.folderName).toBe('ahmed-ali-uid-ahmed');
    expect(two.folderName).toBe('ahmed-ali-uid-ahmed-2');
    expect(one.folderId).not.toBe(two.folderId);
  });

  it('derives the slug from the email local part, then member, when no display name exists', async () => {
    mockUserDocs.set('uid-email', { email: 'Zara.Khan@example.com' });
    const { folders } = await loadModules();

    await expect(folders.getPersonSlug('uid-email')).resolves.toBe('zara-khan');
    await expect(folders.getPersonSlug('uid-ghost')).resolves.toBe('member');
  });
});

describe('initiate and complete agree on the person folder', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location' ? 'https://upload.example/session-1' : null,
      },
      text: async () => '',
    });
    (global as unknown as { fetch: unknown }).fetch = mockFetch;
  });

  async function initiateAhmedProof(mods: Modules): Promise<{ uniqueName: string }> {
    const res = await mods.initiatePOST(
      jsonRequest('http://localhost/api/uploads/initiate', {
        kind: 'document',
        fileName: 'report.pdf',
        sizeBytes: 2048,
        context: 'task-Task123',
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  it('initiate mints the resumable session into the person folder with the person-pattern name', async () => {
    const mods = await loadModules();

    const body = await initiateAhmedProof(mods);

    const today = new Date().toISOString().slice(0, 10);
    expect(body.uniqueName).toBe(`${today}_ahmed-ali_Task123_document_report.pdf`);
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.parents).toEqual([AHMED_FOLDER_ID]);
    expect(sentBody.name).toBe(body.uniqueName);
  });

  it('initiate routes video task proofs to the person folder too', async () => {
    const mods = await loadModules();

    const res = await mods.initiatePOST(
      jsonRequest('http://localhost/api/uploads/initiate', {
        kind: 'video',
        fileName: 'teaser.mp4',
        sizeBytes: 10 * 1024 * 1024,
        context: 'task-Task123',
      }),
    );

    expect(res.status).toBe(200);
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.parents).toEqual([AHMED_FOLDER_ID]);
  });

  it('complete accepts the file from the person folder (by file id)', async () => {
    const mods = await loadModules();
    const { uniqueName } = await initiateAhmedProof(mods);
    mockFilesGet.mockResolvedValue({
      data: {
        id: 'proof-file-1',
        name: uniqueName,
        size: '2048',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/proof-file-1/view',
        parents: [AHMED_FOLDER_ID],
      },
    });

    const res = await mods.completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'document',
        driveFileId: 'proof-file-1',
        uniqueName,
        sizeBytes: 2048,
        context: 'task-Task123',
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.driveFileId).toBe('proof-file-1');
  });

  it('complete rejects a proof that landed in the old shared kind folder (the 502 trap)', async () => {
    const mods = await loadModules();
    const { uniqueName } = await initiateAhmedProof(mods);
    mockFilesGet.mockResolvedValue({
      data: {
        id: 'proof-file-1',
        name: uniqueName,
        size: '2048',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/proof-file-1/view',
        parents: ['kind-doc-folder'],
      },
    });

    const res = await mods.completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'document',
        driveFileId: 'proof-file-1',
        uniqueName,
        sizeBytes: 2048,
        context: 'task-Task123',
      }),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('drive-error');
  });

  it('complete finds the file by name, with the lookup scoped to the person folder', async () => {
    const mods = await loadModules();
    const { uniqueName } = await initiateAhmedProof(mods);
    mockFilesList.mockImplementation(async (args: { q: string }) => {
      if (args.q.includes('application/vnd.google-apps.folder')) {
        return { data: { files: [] } };
      }
      return {
        data: {
          files: [
            {
              id: 'proof-file-2',
              name: uniqueName,
              size: '2048',
              mimeType: 'application/pdf',
              webViewLink: 'https://drive.google.com/file/d/proof-file-2/view',
              parents: [AHMED_FOLDER_ID],
            },
          ],
        },
      };
    });

    const res = await mods.completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'document',
        uniqueName,
        sizeBytes: 2048,
        context: 'task-Task123',
      }),
    );

    expect(res.status).toBe(201);
    const lookupCall = mockFilesList.mock.calls.find(
      (call) => !(call[0].q as string).includes('application/vnd.google-apps.folder'),
    );
    expect(lookupCall?.[0].q).toContain(`'${AHMED_FOLDER_ID}' in parents`);
    expect(lookupCall?.[0].q).toContain(`name='${uniqueName}'`);
  });
});

describe('non-task uploads are unchanged', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location' ? 'https://upload.example/session-1' : null,
      },
      text: async () => '',
    });
    (global as unknown as { fetch: unknown }).fetch = mockFetch;
  });

  it('initiate for a document with a non-task context uses the kind folder and legacy name', async () => {
    const mods = await loadModules();

    const res = await mods.initiatePOST(
      jsonRequest('http://localhost/api/uploads/initiate', {
        kind: 'document',
        fileName: 'chapter-notes.pdf',
        sizeBytes: 1024,
        context: 'consent-request',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uniqueName).toMatch(/^\d+_document_consent-request_chapter-notes\.pdf$/);
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.parents).toEqual(['kind-doc-folder']);
  });

  it('complete without a context (older clients) still verifies against the kind folder', async () => {
    const mods = await loadModules();
    mockFilesGet.mockResolvedValue({
      data: {
        id: 'legacy-file-1',
        name: '123_document_general_notes.pdf',
        size: '512',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/legacy-file-1/view',
        parents: ['kind-doc-folder'],
      },
    });

    const res = await mods.completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'document',
        driveFileId: 'legacy-file-1',
        sizeBytes: 512,
      }),
    );

    expect(res.status).toBe(201);
  });
});
