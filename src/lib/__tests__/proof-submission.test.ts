/**
 * Workstream 6: proof-submission drawer helpers.
 *
 * No em dashes anywhere in this file; user-facing text follows the house rule.
 */

import {
  MAX_PROOF_BYTES,
  MAX_PROOF_MB,
  PROOF_ACCEPTED_EXTS,
  extOfFileName,
  validateProofFile,
  proofPreviewKind,
  assigneeIdsOf,
  assigneeSubmissionStates,
  countSubmittableFiles,
  submissionReadiness,
} from '../proof-submission';

describe('proof-submission helpers', () => {
  describe('extOfFileName', () => {
    it('lowercases the extension', () => {
      expect(extOfFileName('Proof.PDF')).toBe('.pdf');
    });
    it('returns empty string when there is no extension', () => {
      expect(extOfFileName('README')).toBe('');
    });
    it('uses the last dot', () => {
      expect(extOfFileName('final.v2.mp4')).toBe('.mp4');
    });
  });

  describe('validateProofFile', () => {
    it('accepts images, PDFs, and videos under 50MB', () => {
      const good = [
        ['photo.png', 1024],
        ['photo.JPG', 40 * 1024 * 1024],
        ['poster.webp', 1024],
        ['anim.gif', 1024],
        ['report.pdf', 5 * 1024 * 1024],
        ['demo.mp4', 49 * 1024 * 1024],
        ['demo.mov', 10 * 1024 * 1024],
        ['demo.webm', 10 * 1024 * 1024],
        ['clip.m4v', 10 * 1024 * 1024],
      ] as Array<[string, number]>;
      for (const [name, size] of good) {
        expect(validateProofFile(name, size)).toBeNull();
      }
      expect(MAX_PROOF_MB).toBe(50);
      expect(PROOF_ACCEPTED_EXTS).toContain('.pdf');
    });

    it('rejects disallowed types', () => {
      expect(validateProofFile('slides.pptx', 1024)).toMatch(/not an accepted type/);
      expect(validateProofFile('notes.docx', 1024)).toMatch(/not an accepted type/);
      expect(validateProofFile('archive.zip', 1024)).toMatch(/not an accepted type/);
      expect(validateProofFile('README', 1024)).toMatch(/not an accepted type/);
    });

    it('rejects empty files', () => {
      expect(validateProofFile('photo.png', 0)).toMatch(/empty/);
    });

    it('rejects files over the 50MB cap', () => {
      const err = validateProofFile('demo.mp4', MAX_PROOF_BYTES + 1);
      expect(err).toMatch(/50MB/);
    });

    it('honors a custom cap', () => {
      expect(validateProofFile('photo.png', 2 * 1024 * 1024, 1 * 1024 * 1024)).toMatch(/1MB/);
      expect(validateProofFile('photo.png', 512 * 1024, 1 * 1024 * 1024)).toBeNull();
    });
  });

  describe('proofPreviewKind', () => {
    it('detects by extension', () => {
      expect(proofPreviewKind('a.png')).toBe('image');
      expect(proofPreviewKind('a.jpeg')).toBe('image');
      expect(proofPreviewKind('a.webp')).toBe('image');
      expect(proofPreviewKind('a.gif')).toBe('image');
      expect(proofPreviewKind('a.mp4')).toBe('video');
      expect(proofPreviewKind('a.mov')).toBe('video');
      expect(proofPreviewKind('a.webm')).toBe('video');
      expect(proofPreviewKind('a.pdf')).toBe('pdf');
      expect(proofPreviewKind('a.docx')).toBe('other');
    });

    it('prefers the content type when present', () => {
      expect(proofPreviewKind('weird.bin', 'image/png')).toBe('image');
      expect(proofPreviewKind('weird.bin', 'video/mp4')).toBe('video');
      expect(proofPreviewKind('weird.bin', 'application/pdf')).toBe('pdf');
      expect(proofPreviewKind('weird.bin', 'text/plain')).toBe('other');
    });
  });

  describe('assigneeIdsOf', () => {
    it('prefers the multi-assignee array', () => {
      expect(assigneeIdsOf({ assigneeIds: ['u1', 'u2'], assigneeId: 'u1' })).toEqual(['u1', 'u2']);
    });
    it('falls back to the single assigneeId', () => {
      expect(assigneeIdsOf({ assigneeId: 'u1' })).toEqual(['u1']);
    });
    it('drops blanks and returns empty for unassigned tasks', () => {
      expect(assigneeIdsOf({ assigneeIds: ['', '  '] })).toEqual([]);
      expect(assigneeIdsOf({})).toEqual([]);
    });
  });

  describe('assigneeSubmissionStates', () => {
    const task = {
      assigneeIds: ['u1', 'u2', 'u3'],
      submittedBy: 'u1',
      deliverableFiles: [
        { fileName: 'p1.png', downloadUrl: 'https://x', uploadedBy: 'u2' },
        { fileName: 'p2.png', downloadUrl: 'https://x' },
      ],
    };

    it('marks the submitter, the uploader, and the rest correctly', () => {
      const states = assigneeSubmissionStates(task);
      expect(states).toEqual([
        { assigneeId: 'u1', submitted: true, via: 'submit' },
        { assigneeId: 'u2', submitted: true, via: 'upload' },
        { assigneeId: 'u3', submitted: false, via: null },
      ]);
    });

    it('handles single-assignee tasks and empty files', () => {
      expect(assigneeSubmissionStates({ assigneeId: 'u9' })).toEqual([
        { assigneeId: 'u9', submitted: false, via: null },
      ]);
    });

    it('ignores a submittedBy that is not an assignee', () => {
      const states = assigneeSubmissionStates({
        assigneeIds: ['u1'],
        submittedBy: 'admin',
        deliverableFiles: [],
      });
      expect(states[0]).toEqual({ assigneeId: 'u1', submitted: false, via: null });
    });
  });

  describe('countSubmittableFiles', () => {
    it('counts only files with a usable URL', () => {
      expect(
        countSubmittableFiles({
          deliverableFiles: [
            { downloadUrl: 'https://a' },
            { downloadUrl: '' },
            { fileName: 'no-url' },
            null,
          ],
        }),
      ).toBe(1);
    });
    it('returns 0 for missing or non-array values', () => {
      expect(countSubmittableFiles({})).toBe(0);
      expect(countSubmittableFiles({ deliverableFiles: 'x' })).toBe(0);
    });
  });

  describe('submissionReadiness', () => {
    it('is ready only with notes and files', () => {
      const task = { deliverableFiles: [{ downloadUrl: 'https://a' }] };
      expect(submissionReadiness(task, 'did the thing').ready).toBe(true);
      expect(submissionReadiness(task, 'did the thing').missingHint).toBeNull();
    });

    it('explains what is missing', () => {
      const task = { deliverableFiles: [] };
      const both = submissionReadiness(task, '  ');
      expect(both.ready).toBe(false);
      expect(both.missingHint).toMatch(/notes/);
      expect(both.missingHint).toMatch(/proof file/);

      const noFiles = submissionReadiness(task, 'notes here');
      expect(noFiles.missingHint).toMatch(/proof file/);

      const noNotes = submissionReadiness({ deliverableFiles: [{ downloadUrl: 'https://a' }] }, '');
      expect(noNotes.missingHint).toMatch(/notes/);
    });
  });
});
