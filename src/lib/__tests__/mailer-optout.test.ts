/**
 * @jest-environment node
 *
 * mailer-optout.test.ts — the member email opt-out gate in
 * sendEmailNotification (src/lib/mailer.ts), added by the reel-2
 * compliance fix (AUDIT_REEL2 R2-3b).
 *
 * The profile notification-preferences UI writes
 * users/{uid}.emailNotifications; before this fix nothing read it,
 * so opted-out members kept receiving task email. These tests pin:
 *
 * - opted-out member: no Brevo send is attempted, the result is
 *   { success: false, error: 'skipped_opt_out' }, and the skip is
 *   written to email_logs exactly once (the audit trail stays
 *   complete);
 * - opted-in member, member with no recorded preference, and an
 *   address with no account: the email sends normally (the gate is
 *   fail-open and can never widen beyond the recorded opt-out).
 *
 * ZERO Firestore/Brevo access: firebase-admin is jest.mock'ed with
 * an in-memory double; fetch is a jest mock; BREVO_API_KEY is a
 * dummy string.
 */

const mockState: {
  pref: boolean | undefined;
  knownEmail: string;
} = { pref: undefined, knownEmail: 'member@example.test' };

const mockAddedDocs: Array<{ collection: string; doc: Record<string, unknown> }> = [];

const mockDb = {
  collection: (name: string) => ({
    add: async (doc: Record<string, unknown>) => {
      mockAddedDocs.push({ collection: name, doc });
      return { id: 'mock-log-id' };
    },
    doc: (_uid: string) => ({
      get: async () => ({
        exists: true,
        data: () => (mockState.pref === undefined ? {} : { emailNotifications: mockState.pref }),
      }),
    }),
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => mockDb),
  admin: {
    auth: () => ({
      getUserByEmail: async (email: string) => {
        if (email === mockState.knownEmail) return { uid: 'uid-member-1' };
        throw new Error('auth/user-not-found (mock)');
      },
    }),
  },
}));

import { sendEmailNotification } from '@/lib/mailer';

const DATA = {
  recipientName: 'Member One',
  taskTitle: 'Test Directive',
  taskLink: '/profile/unified?uid=uid-member-1&task=task-9',
  actorName: 'Command',
};

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

function brevoOkResponse() {
  return {
    ok: true,
    status: 201,
    statusText: 'Created',
    json: async () => ({ messageId: '<optout-test@smtp-relay.example>' }),
    text: async () => JSON.stringify({ messageId: '<optout-test@smtp-relay.example>' }),
  };
}

function emailLogAdds() {
  return mockAddedDocs.filter((entry) => entry.collection === 'email_logs');
}

beforeEach(() => {
  fetchMock = jest.fn(async () => brevoOkResponse());
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.BREVO_API_KEY = 'dummy-optout-test-key';
  mockAddedDocs.length = 0;
  mockState.pref = undefined;
  mockState.knownEmail = 'member@example.test';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('sendEmailNotification email opt-out gate', () => {
  it('skips the send and logs skipped_opt_out for an opted-out member', async () => {
    mockState.pref = false;
    const result = await sendEmailNotification('member@example.test', 'task_assigned', DATA);
    expect(result).toEqual({ success: false, error: 'skipped_opt_out' });
    expect(fetchMock).not.toHaveBeenCalled();
    const logs = emailLogAdds();
    expect(logs).toHaveLength(1);
    expect(logs[0].doc.success).toBe(false);
    expect(logs[0].doc.error).toBe('skipped_opt_out');
    expect(logs[0].doc.template).toBe('task_assigned');
  });

  it('sends normally for an opted-in member', async () => {
    mockState.pref = true;
    const result = await sendEmailNotification('member@example.test', 'task_assigned', DATA);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logs = emailLogAdds();
    expect(logs).toHaveLength(1);
    expect(logs[0].doc.success).toBe(true);
  });

  it('sends normally when the member has no recorded preference', async () => {
    mockState.pref = undefined;
    const result = await sendEmailNotification('member@example.test', 'task_assigned', DATA);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends normally for an address with no account (fail-open)', async () => {
    mockState.pref = false; // would opt out IF the address resolved to the member
    const result = await sendEmailNotification('nobody@example.test', 'task_assigned', DATA);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
