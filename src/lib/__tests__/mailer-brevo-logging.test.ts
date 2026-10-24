/**
 * @jest-environment node
 *
 * mailer-brevo-logging.test.ts — integration-style unit tests for the
 * production email-logs recording path after the Brevo swap, written by
 * the test-author agent on the Brevo email fix team.
 *
 * Why this file exists alongside brevo-mailer.test.ts: the transport
 * (src/lib/brevo-mailer.ts) deliberately contains NO Firestore code and
 * its setEmailLogHook is intentionally NOT registered in production
 * (Implementer C, double-write guard — see IMPL_C.md §1.5). The actual
 * email_logs writer is logEmailAttempt inside src/lib/mailer.ts, called
 * exactly once after every sendEmailNotification / sendRawEmail. These
 * tests exercise that real wiring end to seam:
 *
 *   src/lib/mailer.ts (real) -> sendViaBrevo (real) -> global fetch (mock)
 *   src/lib/mailer.ts (real) -> logEmailAttempt -> @/lib/server/firebase-admin (mock)
 *
 * ZERO Firestore access: firebase-admin is jest.mock'ed with an in-memory
 * capture double; fetch is a jest mock; BREVO_API_KEY is a dummy string.
 *
 * Cases (brief item d, production path): the email-logs writer is
 * invoked exactly once on the success path with success=true, and
 * exactly once on the failure paths (Brevo non-2xx, missing API key)
 * with success=false and the send error recorded.
 */

const mockAddedDocs: Array<{ collection: string; doc: Record<string, unknown> }> = [];
const mockAddBehavior: { mode: 'ok' | 'throw' | 'null-db' } = { mode: 'ok' };

const mockDb = {
  collection: (name: string) => ({
    add: async (doc: Record<string, unknown>) => {
      if (mockAddBehavior.mode === 'throw') {
        throw new Error('firestore unavailable (mock)');
      }
      mockAddedDocs.push({ collection: name, doc });
      return { id: 'mock-log-id' };
    },
  }),
};

jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: jest.fn(() => true),
  getDb: jest.fn(() => (mockAddBehavior.mode === 'null-db' ? null : mockDb)),
}));

import { sendEmailNotification, sendRawEmail } from '@/lib/mailer';

const RECIPIENT = 'cadet@example.test';
const DUMMY_MESSAGE_ID = '<test-message-id@smtp-relay.example>';

const ORIGINAL_ENV_KEY = process.env.BREVO_API_KEY;
const ORIGINAL_EMAIL_FROM = process.env.EMAIL_FROM;
const ORIGINAL_SMTP_FROM_NAME = process.env.SMTP_FROM_NAME;
const originalFetch = global.fetch;

let fetchMock: jest.Mock;

function brevoOkResponse() {
  return {
    ok: true,
    status: 201,
    statusText: 'Created',
    json: async () => ({ messageId: DUMMY_MESSAGE_ID }),
    text: async () => JSON.stringify({ messageId: DUMMY_MESSAGE_ID }),
  };
}

function brevoErrorResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emailLogAdds() {
  return mockAddedDocs.filter((entry) => entry.collection === 'email_logs');
}

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.BREVO_API_KEY = 'test-key';
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_FROM_NAME;
  mockAddedDocs.length = 0;
  mockAddBehavior.mode = 'ok';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  if (ORIGINAL_ENV_KEY === undefined) {
    delete process.env.BREVO_API_KEY;
  } else {
    process.env.BREVO_API_KEY = ORIGINAL_ENV_KEY;
  }
  if (ORIGINAL_EMAIL_FROM === undefined) {
    delete process.env.EMAIL_FROM;
  } else {
    process.env.EMAIL_FROM = ORIGINAL_EMAIL_FROM;
  }
  if (ORIGINAL_SMTP_FROM_NAME === undefined) {
    delete process.env.SMTP_FROM_NAME;
  } else {
    process.env.SMTP_FROM_NAME = ORIGINAL_SMTP_FROM_NAME;
  }
  jest.restoreAllMocks();
});

const NOTIFICATION_DATA = {
  recipientName: 'Cadet Test',
  taskTitle: 'Test Directive',
  taskLink: '/tasks/test-directive',
  actorName: 'Command',
};

describe('mailer.ts email_logs recording over the Brevo transport', () => {
  it('success: exactly one email_logs entry with success=true and the canonical FROM', async () => {
    fetchMock.mockResolvedValue(brevoOkResponse());

    const result = await sendEmailNotification(RECIPIENT, 'task_assigned', NOTIFICATION_DATA);

    // mailer.ts returns sendViaBrevo's result object directly, so at
    // runtime it also carries status/messageId beyond the declared
    // { success, error? } type — assert the fields, not exact equality.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // The send really went through the Brevo transport.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');

    const adds = emailLogAdds();
    expect(adds).toHaveLength(1);
    const doc = adds[0].doc;
    expect(doc.to).toBe(RECIPIENT);
    expect(doc.from).toContain('noreply@sedspakistan.live');
    expect(doc.template).toBe('task_assigned');
    expect(doc.subject).toContain('Test Directive');
    expect(doc.success).toBe(true);
    expect(doc.error).toBeNull();
    expect(typeof doc.htmlPreview).toBe('string');
    expect((doc.htmlPreview as string).length).toBeGreaterThan(0);
    expect((doc.htmlPreview as string).length).toBeLessThanOrEqual(5000);
    expect(doc.sentAt).toBeInstanceOf(Date);
  });

  it('Brevo failure: exactly one email_logs entry with success=false and the error recorded', async () => {
    fetchMock.mockResolvedValue(
      brevoErrorResponse(401, { code: 'unauthorized', message: 'Key not found' }),
    );

    const result = await sendEmailNotification(RECIPIENT, 'task_assigned', NOTIFICATION_DATA);

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Key not found');

    const adds = emailLogAdds();
    expect(adds).toHaveLength(1);
    expect(adds[0].doc.success).toBe(false);
    expect(adds[0].doc.error).toBe(result.error);
    expect(adds[0].doc.template).toBe('task_assigned');
    expect(adds[0].doc.to).toBe(RECIPIENT);
  });

  it('missing BREVO_API_KEY: no fetch call, exactly one failed email_logs entry naming the key', async () => {
    delete process.env.BREVO_API_KEY;

    const result = await sendEmailNotification(RECIPIENT, 'task_assigned', NOTIFICATION_DATA);

    expect(result.success).toBe(false);
    expect(result.error).toContain('BREVO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();

    const adds = emailLogAdds();
    expect(adds).toHaveLength(1);
    expect(adds[0].doc.success).toBe(false);
    expect(adds[0].doc.error).toContain('BREVO_API_KEY');
  });

  it('sendRawEmail: success and failure are each logged once under sourcing_bridge', async () => {
    fetchMock.mockResolvedValueOnce(brevoOkResponse());
    const ok = await sendRawEmail(RECIPIENT, 'Raw Subject', '<p>raw</p>', 'raw');
    expect(ok.success).toBe(true);
    expect(ok.error).toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      brevoErrorResponse(500, { code: 'internal', message: 'Something went wrong' }),
    );
    const failed = await sendRawEmail(RECIPIENT, 'Raw Subject', '<p>raw</p>', 'raw');
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('500');

    const adds = emailLogAdds();
    expect(adds).toHaveLength(2);
    expect(adds[0].doc.template).toBe('sourcing_bridge');
    expect(adds[0].doc.success).toBe(true);
    expect(adds[0].doc.error).toBeNull();
    expect(adds[1].doc.template).toBe('sourcing_bridge');
    expect(adds[1].doc.success).toBe(false);
    expect(adds[1].doc.error).toBe(failed.error);
  });

  it('a failing email_logs writer never changes the send result', async () => {
    mockAddBehavior.mode = 'throw';
    fetchMock.mockResolvedValue(brevoOkResponse());

    const result = await sendEmailNotification(RECIPIENT, 'task_assigned', NOTIFICATION_DATA);
    expect(result.success).toBe(true);
    expect(emailLogAdds()).toHaveLength(0);
  });

  it('a null db (admin not initialized) never changes the send result', async () => {
    mockAddBehavior.mode = 'null-db';
    fetchMock.mockResolvedValue(brevoOkResponse());

    const result = await sendRawEmail(RECIPIENT, 'Raw Subject', '<p>raw</p>', 'raw');
    expect(result.success).toBe(true);
    expect(emailLogAdds()).toHaveLength(0);
  });
});
