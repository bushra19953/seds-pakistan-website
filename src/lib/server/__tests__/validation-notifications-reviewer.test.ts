/**
 * @jest-environment node
 *
 * Named-reviewer submission notifications: notifyValidatorsOnSubmission
 * must reach the task's named reviewer with the same in-app alert the
 * chain validators get, and resolveValidatorSubmissionAlerts must
 * drain that alert on decision. Recipient exclusions mirror the chain
 * exactly: the submitter never, and the assigner never (the assigner
 * is emailed through the assigner path in the tasks route, so a
 * reviewer who is also the assigner is pinged once, there).
 *
 * Real module under test; only the Admin SDK module is faked.
 * No em dashes are used in this file.
 */

const writes: Array<{ uid: string; notifId: string; data: any }> = [];
const updates: Array<{ uid: string; notifId: string; data: any }> = [];
const notifStore: Record<string, Record<string, any>> = {};
let notifCounter = 0;

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'users') throw new Error(`unexpected collection ${name}`);
    return {
      doc: (uid: string) => ({
        get: async () => ({
          exists: true,
          data: () => ({ displayName: `User ${uid}` }),
        }),
        collection: (sub: string) => {
          if (sub !== 'notifications') throw new Error(`unexpected subcollection ${sub}`);
          return {
            doc: (id?: string) => {
              const notifId = id ?? `auto-${++notifCounter}`;
              return {
                id: notifId,
                set: async (data: any) => {
                  writes.push({ uid, notifId, data });
                  (notifStore[uid] ??= {})[notifId] = { ...data };
                },
              };
            },
            where: (field: string, _op: string, val: any) => ({
              get: async () => {
                const docs = Object.entries(notifStore[uid] || {})
                  .filter(([, data]) => data[field] === val)
                  .map(([notifId, data]) => ({
                    id: notifId,
                    data: () => data,
                    ref: {
                      update: async (update: any) => {
                        updates.push({ uid, notifId, data: update });
                        Object.assign(notifStore[uid][notifId], update);
                      },
                    },
                  }));
                return { docs, empty: docs.length === 0, size: docs.length };
              },
            }),
          };
        },
      }),
    };
  },
};

jest.mock('@/lib/server/firebase-admin', () => ({
  getDb: () => fakeDb,
  admin: {
    firestore: {
      FieldValue: {
        serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
      },
    },
    messaging: () => ({ sendEachForMulticast: async () => ({}) }),
  },
}));

import {
  notifyValidatorsOnSubmission,
  resolveValidatorSubmissionAlerts,
  VALIDATOR_ALERT_TITLE,
} from '../validation-notifications';

beforeEach(() => {
  writes.length = 0;
  updates.length = 0;
  for (const k of Object.keys(notifStore)) delete notifStore[k];
  notifCounter = 0;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('notifyValidatorsOnSubmission with a named reviewer', () => {
  it('the reviewer gets the awaiting-validation alert alongside chain validators', async () => {
    await notifyValidatorsOnSubmission({
      taskId: 'task-1',
      taskTitle: 'Rover Sim',
      submitterUid: 'submitter-1',
      submitterName: 'Hassan Ali',
      validatorUids: ['chain-1'],
      reviewerUids: ['reviewer-1'],
      assignerId: 'assigner-1',
    });
    const recipients = writes.map((w) => w.uid).sort();
    expect(recipients).toEqual(['chain-1', 'reviewer-1']);
    for (const w of writes) {
      expect(w.data).toMatchObject({
        type: 'task_status_change',
        title: VALIDATOR_ALERT_TITLE,
        taskId: 'task-1',
        isRead: false,
      });
    }
  });

  it('a reviewer who is also the assigner is not double-pinged here', async () => {
    await notifyValidatorsOnSubmission({
      taskId: 'task-1',
      taskTitle: 'Rover Sim',
      submitterUid: 'submitter-1',
      validatorUids: [],
      reviewerUids: ['assigner-1'],
      assignerId: 'assigner-1',
    });
    expect(writes).toEqual([]);
  });

  it('the submitter never receives the alert even when named reviewer', async () => {
    await notifyValidatorsOnSubmission({
      taskId: 'task-1',
      taskTitle: 'Rover Sim',
      submitterUid: 'submitter-1',
      validatorUids: [],
      reviewerUids: ['submitter-1'],
    });
    expect(writes).toEqual([]);
  });
});

describe('resolveValidatorSubmissionAlerts with a named reviewer', () => {
  it('the reviewer alert drains on decision, like the chain alerts', async () => {
    await notifyValidatorsOnSubmission({
      taskId: 'task-9',
      taskTitle: 'Rover Sim',
      submitterUid: 'submitter-1',
      validatorUids: ['chain-1'],
      reviewerUids: ['reviewer-1'],
      assignerId: 'assigner-1',
    });
    writes.length = 0;
    await resolveValidatorSubmissionAlerts({
      taskId: 'task-9',
      submitterUid: 'submitter-1',
      assignerId: 'assigner-1',
      validatorUids: ['chain-1'],
      reviewerUids: ['reviewer-1'],
    });
    const resolvedUids = updates.map((u) => u.uid).sort();
    expect(resolvedUids).toEqual(['chain-1', 'reviewer-1']);
    for (const u of updates) {
      expect(u.data).toMatchObject({ isRead: true, resolution: 'validation_decided' });
    }
  });
});
