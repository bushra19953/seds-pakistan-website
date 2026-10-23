/**
 * The dropzone accept list is a promise to visitors: every extension here
 * must also be in the CAD vault allowlist the upload API enforces (the
 * `cad` kind in src/lib/drive/folders.ts), or the upload fails after the
 * file has already passed client validation.
 */
jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null }),
}));

jest.mock('@/lib/uploads/client', () => ({
  uploadToDrive: jest.fn(),
}));

import { ACCEPTED_EXTS, MIME_BY_EXT } from '../cad-dropzone';

describe('CadDropzone accepted formats', () => {
  it('accepts the CAD, archive, and drawing formats the vault allows', () => {
    expect(ACCEPTED_EXTS).toEqual(
      expect.arrayContaining(['.step', '.stp', '.stl', '.zip', '.pdf']),
    );
  });

  it('maps every accepted extension to a MIME type', () => {
    for (const ext of ACCEPTED_EXTS) {
      expect(typeof MIME_BY_EXT[ext]).toBe('string');
      expect(MIME_BY_EXT[ext].length).toBeGreaterThan(0);
    }
    expect(MIME_BY_EXT['.pdf']).toBe('application/pdf');
  });

  it('does not promise formats the CAD vault rejects server-side', () => {
    // .iges/.igs models and .xlsx BOMs are not in the server allowlist yet;
    // the page copy routes them through the .zip package instead. If the
    // server allowlist grows, extend ACCEPTED_EXTS and update this test in
    // the same change.
    expect(ACCEPTED_EXTS).not.toContain('.iges');
    expect(ACCEPTED_EXTS).not.toContain('.igs');
    expect(ACCEPTED_EXTS).not.toContain('.xlsx');
  });
});
