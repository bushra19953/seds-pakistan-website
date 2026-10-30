/**
 * CONTRACT TEST — validator submission alerts auto-resolve on decision (M5).
 *
 * notifyValidatorsOnSubmission writes an unread 'Task Awaiting Your
 * Validation' notification (type 'task_status_change', carrying the
 * taskId) into each eligible validator's inbox. Before the fix nothing
 * ever resolved those alerts: decided work pinged validators forever
 * and only a manual mark-read cleared them.
 *
 * resolveValidatorSubmissionAlerts must:
 *  - reach exactly the fan-out's recipient set (validator chain minus
 *    submitter and assigner),
 *  - resolve only the unread awaiting-validation alert for the decided
 *    task (acceptance nudges, other tasks' alerts, and already-read
 *    alerts are untouched),
 *  - mark it read with a resolution stamp, keeping the document.
 *
 * Real module under test; only the Admin SDK module is faked.
 * No em dashes are used in this file.
 */

const notifUpdates: Array<{ uid: string; notifId: string; data: any }> = [];
const queriedUids: string[] = [];

const notifStore: Record<string, Record<string, any>> = {
  'validator-1': {
    'n-target': { type: 'task_status_change', title: 'Task Awaiting Your Validation', taskId: 'task-1', isRead: false },
    'n-acceptance': { type: 'task_status_change', title: 'Task Awaiting Your Acceptance', taskId: 'task-1', isRead: false },
    'n-other-task': { type: 'task_status_change', title: 'Task Awaiting Your Validation', taskId: 'task-2', isRead: false },
    'n-already-read': { type: 'task_status_change', title: 'Task Awaiting Your Validation', taskId: 'task-1', isRead: true },
  },
  'submitter-1': {
    'n-submitter-copy': { type: 'task_status_change', title: 'Task Awaiting Your Validation', taskId: 'task-1', isRead: false },
  },
  'assigner-1': {
    'n-assigner-copy': { type: 'task_status_change', title: 'Task Awaiting Your Validation', taskId: 'task-1', isRead: false },
  },
};

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'users') throw new Error(`unexpected collection ${name}`);
    return {
      doc: (uid: string) => ({
        collection: (sub: string) => {
          if (sub !== 'notifications') throw new Error(`unexpected subcollection ${sub}`);
          // Chainable where/limit (train 2: the resolver query now
          // also filters isRead == false and caps at 10).
          const makeQuery = (filters: Array<[string, any]>): any => ({
            where: (field: string, _op: string, val: any) => makeQuery([...filters, [field, val]]),
            limit: (_n: number) => makeQuery(filters),
            get: async () => {
              queriedUids.push(uid);
              const docs = Object.entries(notifStore[uid] || {})
                .filter(([, data]) => filters.every(([f, v]) => data[f] === v))
                .map(([notifId, data]) => ({
                  id: notifId,
                  data: () => data,
                  ref: {
                    update: async (update: any) => {
                      notifUpdates.push({ uid, notifId, data: update });
                      Object.assign(notifStore[uid][notifId], update);
                    },
                  },
                }));
              return { docs, empty: docs.length === 0, size: docs.length };
            },
          });
          return {
            where: (field: string, _op: string, val: any) => makeQuery([[field, val]]),
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

import { resolveValidatorSubmissionAlerts } from '../validation-notifications';

describe('resolveValidatorSubmissionAlerts', () => {
  beforeEach(() => {
    notifUpdates.length = 0;
    queriedUids.length = 0;
    // Restore the one doc the happy-path test mutates.
    notifStore['validator-1']['n-target'] = {
      type: 'task_status_change',
      title: 'Task Awaiting Your Validation',
      taskId: 'task-1',
      isRead: false,
    };
  });

  test('resolves only the unread awaiting-validation alert for the decided task', async () => {
    await resolveValidatorSubmissionAlerts({
      taskId: 'task-1',
      submitterUid: 'submitter-1',
      assignerId: 'assigner-1',
      validatorUids: ['validator-1', 'submitter-1', 'assigner-1'],
    });

    expect(notifUpdates).toHaveLength(1);
    expect(notifUpdates[0].uid).toBe('validator-1');
    expect(notifUpdates[0].notifId).toBe('n-target');
    expect(notifUpdates[0].data.isRead).toBe(true);
    expect(notifUpdates[0].data.resolution).toBe('validation_decided');
    expect(notifUpdates[0].data.resolvedAt).toBeDefined();

    // Everything else in the same inbox is untouched.
    expect(notifStore['validator-1']['n-acceptance'].isRead).toBe(false);
    expect(notifStore['validator-1']['n-other-task'].isRead).toBe(false);
    expect(notifStore['validator-1']['n-already-read'].resolution).toBeUndefined();
  });

  test('recipient set mirrors the fan-out: submitter and assigner inboxes are never queried', async () => {
    await resolveValidatorSubmissionAlerts({
      taskId: 'task-1',
      submitterUid: 'submitter-1',
      assignerId: 'assigner-1',
      validatorUids: ['validator-1', 'submitter-1', 'assigner-1'],
    });
    expect(queriedUids).toEqual(['validator-1']);
    expect(notifStore['submitter-1']['n-submitter-copy'].isRead).toBe(false);
    expect(notifStore['assigner-1']['n-assigner-copy'].isRead).toBe(false);
  });

  test('an empty validator set is a silent no-op', async () => {
    await resolveValidatorSubmissionAlerts({
      taskId: 'task-1',
      submitterUid: 'submitter-1',
      validatorUids: [],
    });
    expect(queriedUids).toHaveLength(0);
    expect(notifUpdates).toHaveLength(0);
  });
});
