/**
 * @jest-environment node
 *
 * T-16 (Workstream D spec, section 7): the Drive "governance" upload kind.
 *
 * Asserts:
 * - UPLOAD_KINDS.governance exists with the exact folderName and envVar
 *   from spec 3.6, a 25MB cap, and pdf/docx/doc plus image MIME entries.
 * - The client helpers getDriveFileMetadata / getDriveFileStream are thin
 *   wrappers over getDriveClient() with the exact Drive calls in spec
 *   3.6.1 (googleapis is mocked; the real client.ts runs).
 * - The uploads/complete route's governance branch NEVER calls
 *   permissions.create (enableLinkSharing) for kind 'governance', on both
 *   the by-fileId path and the by-name lookup path, while the landed-file
 *   folder check still runs (a file outside the governance folder is
 *   rejected with the standard drive-error shape).
 * - A visual kind (image) still DOES get link-sharing, proving the mock
 *   can observe permissions.create and other kinds are unchanged.
 * - The uploads/initiate route picks up 'governance' with no kind-specific
 *   code: validation, folder resolution, and session minting flow through.
 *
 * Drive is mocked at the googleapis boundary so the real client.ts,
 * folders.ts, upload-handler.ts, and both upload routes run unmocked.
 * No test touches real Drive, Firestore, or any user file.
 */

import { Readable } from 'stream';

const GOV_FOLDER_ID = 'gov-folder-id';
const IMAGE_FOLDER_ID = 'image-folder-id';
const FILE_ID = 'gov-file-1';

const mockFilesGet = jest.fn();
const mockFilesList = jest.fn();
const mockPermissionsCreate = jest.fn(async () => ({}));
const mockDrive = {
  files: {
    get: mockFilesGet,
    list: mockFilesList,
    create: jest.fn(),
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
    verifyIdTokenString: jest.fn(async () => ({ uid: 'officer-1' })),
    verifySession: jest.fn(async () => ({ uid: 'officer-1' })),
    toSessionErrorResponse: jest.fn(() => null),
  };
});

jest.mock('@/lib/server/upload-logger', () => ({
  logUpload: jest.fn(async () => null),
  markUploadCompleted: jest.fn(async () => null),
}));

process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'test-refresh-token';
process.env.GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID = GOV_FOLDER_ID;
process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID = IMAGE_FOLDER_ID;

import { UPLOAD_KINDS, extOfFile, getFolderId } from '@/lib/drive/folders';
import { getDriveFileMetadata, getDriveFileStream } from '@/lib/drive/client';
import { isUploadKind } from '@/lib/drive/upload-handler';
import { POST as completePOST } from '@/app/api/uploads/complete/route';
import { POST as initiatePOST } from '@/app/api/uploads/initiate/route';
import { NextRequest } from 'next/server';

function jsonRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function driveFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FILE_ID,
    name: 'constitution.pdf',
    size: '2048',
    mimeType: 'application/pdf',
    webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
    parents: [GOV_FOLDER_ID],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPermissionsCreate.mockResolvedValue({});
  mockFilesList.mockResolvedValue({ data: { files: [] } });
});

describe('UPLOAD_KINDS.governance (spec 3.6)', () => {
  it('exists with the exact folderName and envVar', () => {
    expect(UPLOAD_KINDS.governance).toBeDefined();
    expect(UPLOAD_KINDS.governance.folderName).toBe('SEDS Governance Records');
    expect(UPLOAD_KINDS.governance.envVar).toBe('GOOGLE_DRIVE_GOVERNANCE_FOLDER_ID');
  });

  it('caps files at 25MB, matching the document kind', () => {
    expect(UPLOAD_KINDS.governance.maxBytes).toBe(25 * 1024 * 1024);
  });

  it('resolves pdf, docx, and doc MIME entries', () => {
    const mimeByExt = UPLOAD_KINDS.governance.mimeByExt;
    expect(mimeByExt['.pdf']).toBe('application/pdf');
    expect(mimeByExt['.docx']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mimeByExt['.doc']).toBe('application/msword');
  });

  it('resolves the image MIME entries from the shared IMAGE_MIME spread', () => {
    const mimeByExt = UPLOAD_KINDS.governance.mimeByExt;
    expect(mimeByExt['.png']).toBe('image/png');
    expect(mimeByExt['.jpg']).toBe('image/jpeg');
    expect(mimeByExt['.jpeg']).toBe('image/jpeg');
    expect(mimeByExt['.webp']).toBe('image/webp');
    expect(mimeByExt['.gif']).toBe('image/gif');
    // End-to-end through the same lookup the initiate route performs.
    expect(mimeByExt[extOfFile('Scanned Filing.PNG')]).toBe('image/png');
    expect(mimeByExt[extOfFile('Constitution.DOCX')]).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mimeByExt[extOfFile('payload.exe')]).toBeUndefined();
  });

  it('is a valid upload kind and resolves its pinned folder id', async () => {
    expect(isUploadKind('governance')).toBe(true);
    await expect(getFolderId('governance')).resolves.toBe(GOV_FOLDER_ID);
  });
});

describe('client helpers (spec 3.6.1)', () => {
  it('getDriveFileMetadata calls files.get with the specced fields and maps the result', async () => {
    mockFilesGet.mockResolvedValue({ data: driveFile() });

    const meta = await getDriveFileMetadata(FILE_ID);

    expect(mockFilesGet).toHaveBeenCalledWith({
      fileId: FILE_ID,
      fields: 'id, name, size, mimeType, parents, webViewLink',
      supportsAllDrives: true,
    });
    expect(meta).toEqual({
      fileId: FILE_ID,
      name: 'constitution.pdf',
      sizeBytes: 2048,
      mimeType: 'application/pdf',
      parents: [GOV_FOLDER_ID],
      webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
    });
  });

  it('getDriveFileStream calls files.get with alt media and stream response type', async () => {
    const fakeStream = Readable.from(['file-bytes']);
    mockFilesGet.mockResolvedValue({ data: fakeStream });

    const stream = await getDriveFileStream(FILE_ID);

    expect(mockFilesGet).toHaveBeenCalledWith(
      { fileId: FILE_ID, alt: 'media' },
      { responseType: 'stream' },
    );
    expect(stream).toBe(fakeStream);
  });
});

describe('uploads/complete governance branch (T-16)', () => {
  it('never calls permissions.create for a governance file in the right folder', async () => {
    mockFilesGet.mockResolvedValue({ data: driveFile() });

    const res = await completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'governance',
        driveFileId: FILE_ID,
        sizeBytes: 2048,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.kind).toBe('governance');
    expect(body.driveFileId).toBe(FILE_ID);
    expect(mockPermissionsCreate).not.toHaveBeenCalled();
  });

  it('runs the folder check: a governance file outside the governance folder is rejected and never shared', async () => {
    mockFilesGet.mockResolvedValue({
      data: driveFile({ parents: ['some-other-folder'] }),
    });

    const res = await completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'governance',
        driveFileId: FILE_ID,
        sizeBytes: 2048,
      }),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('drive-error');
    expect(mockPermissionsCreate).not.toHaveBeenCalled();
  });

  it('never calls permissions.create on the by-name lookup path either', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [driveFile()] } });

    const res = await completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'governance',
        uniqueName: '123_governance_general_constitution.pdf',
        sizeBytes: 2048,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.driveFileId).toBe(FILE_ID);
    // The lookup itself is scoped to the governance folder.
    expect(mockFilesList).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining(`'${GOV_FOLDER_ID}' in parents`),
      }),
    );
    expect(mockPermissionsCreate).not.toHaveBeenCalled();
  });

  it('still link-shares visual kinds (image), so other kinds are unchanged', async () => {
    mockFilesGet.mockResolvedValue({
      data: driveFile({
        id: 'img-1',
        name: 'photo.png',
        mimeType: 'image/png',
        parents: [IMAGE_FOLDER_ID],
      }),
    });

    const res = await completePOST(
      jsonRequest('http://localhost/api/uploads/complete', {
        kind: 'image',
        driveFileId: 'img-1',
        sizeBytes: 100,
      }),
    );

    expect(res.status).toBe(201);
    expect(mockPermissionsCreate).toHaveBeenCalledTimes(1);
    expect(mockPermissionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'img-1' }),
    );
  });
});

describe('uploads/initiate picks up governance with no kind-specific code', () => {
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

  it('mints a resumable session into the governance folder for a pdf', async () => {
    const res = await initiatePOST(
      jsonRequest('http://localhost/api/uploads/initiate', {
        kind: 'governance',
        fileName: 'constitution.pdf',
        sizeBytes: 2048,
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadUrl).toBe('https://upload.example/session-1');
    expect(body.mimeType).toBe('application/pdf');
    expect(body.uniqueName).toContain('governance');

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.parents).toEqual([GOV_FOLDER_ID]);
    expect(sentBody.mimeType).toBe('application/pdf');
  });

  it('rejects a file type outside the governance MIME map', async () => {
    const res = await initiatePOST(
      jsonRequest('http://localhost/api/uploads/initiate', {
        kind: 'governance',
        fileName: 'payload.exe',
        sizeBytes: 2048,
      }),
    );

    expect(res.status).toBe(415);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
