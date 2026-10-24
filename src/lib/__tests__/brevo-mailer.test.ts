/**
 * @jest-environment node
 *
 * brevo-mailer.test.ts — unit tests for the Brevo HTTPS mailer
 * (src/lib/brevo-mailer.ts), written by the test-author agent on the
 * Brevo email fix team.
 *
 * Everything external is mocked: global fetch is a jest mock (no network,
 * no Brevo account), the email-logs writer is exercised through the
 * mailer's own seam — the hook registered with setEmailLogHook() — and
 * BREVO_API_KEY is a dummy string in process.env. ZERO Firestore access:
 * the module under test imports no Firestore code, and these tests never
 * touch a real database.
 *
 * Cases:
 * (a) success: 2xx Brevo response -> delivered result, request went to
 *     https://api.brevo.com/v3/smtp/email with the api-key header and
 *     sender noreply@sedspakistan.live.
 * (b) API failure: non-2xx -> failure result carrying the HTTP status and
 *     Brevo's error message, and the attempt is recorded as failed.
 * (c) missing BREVO_API_KEY: named error, fetch is NOT called.
 * (d) log recording: the registered log hook is invoked on both success
 *     and failure paths with the right outcome.
 */

import {
  BREVO_API_URL,
  BREVO_FROM_EMAIL,
  getEmailLogHook,
  sendBrevoEmail,
  sendEmail,
  sendRawEmail,
  sendViaBrevo,
  setEmailLogHook,
  type BrevoEmailLogEntry,
} from '@/lib/brevo-mailer';

const RECIPIENT = 'cadet@example.test';
const SUBJECT = 'Mission Assignment: Test Directive';
const HTML = '<p>Hello cadet</p>';
const TEXT = 'Hello cadet';
const DUMMY_MESSAGE_ID = '<test-message-id@smtp-relay.example>';

const ORIGINAL_ENV_KEY = process.env.BREVO_API_KEY;
// getBrevoSender() honors EMAIL_FROM (address extraction) and
// SMTP_FROM_NAME (display name) when set. The sender assertions below pin
// the DEFAULT identity (noreply@sedspakistan.live / "SEDS Pakistan"), so
// both overrides are cleared for the run and restored afterwards.
const ORIGINAL_EMAIL_FROM = process.env.EMAIL_FROM;
const ORIGINAL_SMTP_FROM_NAME = process.env.SMTP_FROM_NAME;
const originalFetch = global.fetch;

let fetchMock: jest.Mock;

function brevoOkResponse(status = 201, body: Record<string, unknown> = { messageId: DUMMY_MESSAGE_ID }) {
  return {
    ok: true,
    status,
    statusText: 'Created',
    json: async () => body,
    text: async () => JSON.stringify(body),
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

function lastFetchCall() {
  expect(fetchMock).toHaveBeenCalled();
  const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  return calls[calls.length - 1];
}

function lastRequestBody() {
  const [, init] = lastFetchCall();
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  // Dummy key only — never a real credential. The mailer reads
  // BREVO_API_KEY at call time, so setting it here (after import) is
  // exactly the production contract.
  process.env.BREVO_API_KEY = 'test-key';
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_FROM_NAME;
  setEmailLogHook(null);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setEmailLogHook(null);
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

describe('(a) success: 2xx Brevo response', () => {
  it('resolves as delivered with the Brevo status and messageId', async () => {
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    const result = await sendViaBrevo({
      to: RECIPIENT,
      subject: SUBJECT,
      html: HTML,
      text: TEXT,
      template: 'task_assigned',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(201);
    expect(result.messageId).toBe(DUMMY_MESSAGE_ID);
  });

  it('POSTs to the Brevo API URL with the api-key header and the preserved FROM sender', async () => {
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    await sendViaBrevo({
      to: RECIPIENT,
      subject: SUBJECT,
      html: HTML,
      text: TEXT,
      template: 'task_assigned',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = lastFetchCall();
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(url).toBe(BREVO_API_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = lastRequestBody();
    expect(body.sender).toEqual({
      email: 'noreply@sedspakistan.live',
      name: 'SEDS Pakistan',
    });
    expect(body.sender.email).toBe(BREVO_FROM_EMAIL);
    expect(body.to).toEqual([{ email: RECIPIENT }]);
    expect(body.subject).toBe(SUBJECT);
    expect(body.htmlContent).toBe(HTML);
    expect(body.textContent).toBe(TEXT);
  });

  it('reads BREVO_API_KEY at call time, not at module load', async () => {
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });
    process.env.BREVO_API_KEY = 'test-key-rotated';
    await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect((calls[0][1].headers as Record<string, string>)['api-key']).toBe('test-key');
    expect((calls[1][1].headers as Record<string, string>)['api-key']).toBe('test-key-rotated');
  });

  it('treats a 2xx with an empty/non-JSON body as a successful send', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => {
        throw new Error('no body');
      },
      text: async () => '',
    });

    const result = await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });
    expect(result.success).toBe(true);
    expect(result.status).toBe(204);
    expect(result.messageId).toBeUndefined();
  });

  it('sendBrevoEmail alias and the drop-in wrappers deliver through Brevo', async () => {
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    const aliased = await sendBrevoEmail({ to: RECIPIENT, subject: SUBJECT, html: HTML });
    expect(aliased.success).toBe(true);

    // Preserved interface of src/lib/mailer.ts sendRawEmail.
    const raw = await sendRawEmail(RECIPIENT, SUBJECT, HTML, TEXT);
    expect(raw).toEqual({ success: true });
    expect(lastRequestBody().sender.email).toBe('noreply@sedspakistan.live');

    // Preserved interface of EmailService.sendEmail (Promise<boolean>).
    const bool = await sendEmail({ to: RECIPIENT, subject: SUBJECT, html: HTML, text: TEXT });
    expect(bool).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('(b) API failure: non-2xx Brevo response', () => {
  it('surfaces the HTTP status and Brevo\u2019s error message', async () => {
    fetchMock.mockResolvedValue(
      brevoErrorResponse(401, { code: 'unauthorized', message: 'Key not found' }),
    );

    const result = await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Key not found');
  });

  it('surfaces a 400 validation error the same way', async () => {
    fetchMock.mockResolvedValue(
      brevoErrorResponse(400, { code: 'invalid_parameter', message: 'Invalid sender IP' }),
    );

    const raw = await sendRawEmail(RECIPIENT, SUBJECT, HTML);
    expect(raw.success).toBe(false);
    expect(raw.error).toContain('400');
    expect(raw.error).toContain('Invalid sender IP');

    const bool = await sendEmail({ to: RECIPIENT, subject: SUBJECT, html: HTML });
    expect(bool).toBe(false);
  });

  it('records the failed attempt through the log hook with success=false', async () => {
    const hook = jest.fn(async () => {});
    setEmailLogHook(hook);
    fetchMock.mockResolvedValue(
      brevoErrorResponse(401, { code: 'unauthorized', message: 'Key not found' }),
    );

    const result = await sendViaBrevo({
      to: RECIPIENT,
      subject: SUBJECT,
      html: HTML,
      template: 'task_assigned',
    });

    expect(result.success).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0] as BrevoEmailLogEntry;
    expect(entry.result.success).toBe(false);
    expect(entry.result.error).toBe(result.error);
    expect(entry.status).toBe(401);
    expect(entry.provider).toBe('brevo');
  });

  it('surfaces a network failure as a failed result (and records it)', async () => {
    const hook = jest.fn(async () => {});
    setEmailLogHook(hook);
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const result = await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });

    expect(result.success).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toContain('socket hang up');
    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0] as BrevoEmailLogEntry;
    expect(entry.result.success).toBe(false);
    expect(entry.result.error).toContain('socket hang up');
  });
});

describe('(c) missing BREVO_API_KEY', () => {
  it('fails with an error naming BREVO_API_KEY and never calls fetch', async () => {
    delete process.env.BREVO_API_KEY;

    const result = await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });

    expect(result.success).toBe(false);
    expect(result.error).toContain('BREVO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an empty or whitespace-only key is treated as missing', async () => {
    process.env.BREVO_API_KEY = '   ';

    const raw = await sendRawEmail(RECIPIENT, SUBJECT, HTML);
    expect(raw.success).toBe(false);
    expect(raw.error).toContain('BREVO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendEmail returns false (never a fake success) when the key is missing', async () => {
    delete process.env.BREVO_API_KEY;

    await expect(sendEmail({ to: RECIPIENT, subject: SUBJECT, html: HTML })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('(d) log recording via the setEmailLogHook seam', () => {
  it('invokes the hook once on success with the delivered outcome and full entry', async () => {
    const hook = jest.fn(async () => {});
    setEmailLogHook(hook);
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    await sendViaBrevo({
      to: RECIPIENT,
      subject: SUBJECT,
      html: HTML,
      text: TEXT,
      template: 'task_assigned',
    });

    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0] as BrevoEmailLogEntry;
    expect(entry.to).toBe(RECIPIENT);
    expect(entry.from).toBe('noreply@sedspakistan.live');
    expect(entry.template).toBe('task_assigned');
    expect(entry.subject).toBe(SUBJECT);
    expect(entry.html).toBe(HTML);
    expect(entry.result).toEqual({ success: true, error: undefined });
    expect(entry.provider).toBe('brevo');
    expect(entry.status).toBe(201);
    expect(entry.messageId).toBe(DUMMY_MESSAGE_ID);
  });

  it('invokes the hook once on failure with the failed outcome', async () => {
    const hook = jest.fn(async () => {});
    setEmailLogHook(hook);
    fetchMock.mockResolvedValue(
      brevoErrorResponse(500, { code: 'internal', message: 'Something went wrong' }),
    );

    await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML, template: 'task_assigned' });

    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0] as BrevoEmailLogEntry;
    expect(entry.result.success).toBe(false);
    expect(entry.result.error).toContain('500');
    expect(entry.result.error).toContain('Something went wrong');
    expect(entry.status).toBe(500);
    expect(entry.from).toBe('noreply@sedspakistan.live');
  });

  it('still records the attempt when BREVO_API_KEY is missing (recorded as failed)', async () => {
    const hook = jest.fn(async () => {});
    setEmailLogHook(hook);
    delete process.env.BREVO_API_KEY;

    await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });

    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0] as BrevoEmailLogEntry;
    expect(entry.result.success).toBe(false);
    expect(entry.result.error).toContain('BREVO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendRawEmail records under the sourcing_bridge template label by default', async () => {
    const hook = jest.fn(async () => {});
    setEmailLogHook(hook);
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    await sendRawEmail(RECIPIENT, SUBJECT, HTML, TEXT);

    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0] as BrevoEmailLogEntry;
    expect(entry.template).toBe('sourcing_bridge');
    expect(entry.result.success).toBe(true);
  });

  it('a throwing log hook never changes the send result', async () => {
    setEmailLogHook(() => {
      throw new Error('log writer down');
    });
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    const result = await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });
    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
  });

  it('sending works with no hook registered (default no-op logging)', async () => {
    expect(getEmailLogHook()).toBeNull();
    fetchMock.mockResolvedValue(brevoOkResponse(201));

    const result = await sendViaBrevo({ to: RECIPIENT, subject: SUBJECT, html: HTML });
    expect(result.success).toBe(true);
  });
});
