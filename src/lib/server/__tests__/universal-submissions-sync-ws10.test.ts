/**
 * @jest-environment node
 *
 * WS10 — replica-parity pins for the server-owned universal_submissions
 * sync (applications branch of the webhook replica's
 * handleSubmissionsSyncRoute / executeUniversalSubmissionSync):
 * global id, type, uppercased status, summary text, user/chapter
 * fallbacks from the user doc, created_at precedence, set-merge with
 * the replica's snake_case field names.
 */
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
}));

import { syncApplicationUniversalSubmission } from '../universal-submissions-sync';

function fakeDb(userDoc: any) {
  const sets: Array<{ col: string; id: string; data: any; opts: any }> = [];
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: !!userDoc, data: () => userDoc }),
        set: async (data: any, opts: any) => { sets.push({ col: name, id, data, opts }); },
      }),
    }),
  };
  return { db, sets };
}

describe('syncApplicationUniversalSubmission (replica applications branch)', () => {
  it('writes the replica row shape with user-doc fallbacks', async () => {
    const { db, sets } = fakeDb({ displayName: 'App One', photoURL: 'p.png', chapterId: 'ist' });
    await syncApplicationUniversalSubmission(db, 'app-1', {
      status: 'shortlisted', userId: 'app-1', roleAppliedFor: 'Rover Lead', created_at: 'CREATED',
    });
    expect(sets).toEqual([{
      col: 'universal_submissions',
      id: 'applications_app-1',
      data: {
        global_id: 'applications_app-1',
        original_ref: 'applications/app-1',
        type: 'APPLICATION',
        status: 'SHORTLISTED',
        created_at: 'CREATED',
        user_id: 'app-1',
        user_display_name: 'App One',
        user_photo_url: 'p.png',
        chapter_id: 'ist',
        summary_text: 'Application: Rover Lead',
      },
      opts: { merge: true },
    }]);
  });

  it('defaults: PENDING status, Unknown Role, Anonymous, serverTimestamp created_at', async () => {
    const { db, sets } = fakeDb(null);
    await syncApplicationUniversalSubmission(db, 'app-2', {});
    expect(sets[0].data).toMatchObject({
      status: 'PENDING',
      summary_text: 'Application: Unknown Role',
      user_display_name: 'Anonymous',
      user_id: null,
      chapter_id: null,
      created_at: '__ST__',
    });
  });

  it('never throws on a broken db', async () => {
    const db = { collection: () => { throw new Error('down'); } };
    await expect(syncApplicationUniversalSubmission(db, 'x', { status: 'pending' })).resolves.toBeUndefined();
  });
});
