/**
 * Regression tests for exact induction-submit error logging (Team 3).
 *
 * (a) A simulated batch.commit failure produces a log entry carrying the
 *     Firestore error code, the failed operation, the payload FIELD NAMES,
 *     and the client version marker, with no PII values anywhere.
 * (b) A logging failure never blocks or changes the caller: reportClientError
 *     resolves even when fetch rejects or throws.
 */

import {
  buildClientErrorLog,
  getClientVersionMarker,
  reportClientError,
  sanitizeFieldNames,
  scrubErrorMessage,
  STALE_TAB_SUSPECT_AFTER_MS,
} from '@/lib/client-error-logging';

describe('buildClientErrorLog: simulated batch.commit failure', () => {
  it('carries code + operation + field names + version, and no PII values', () => {
    const secretValue = 'SECRET-ANSWER-VALUE-9f3a2b';
    const secretEmail = 'applicant-private@example.com';
    const log = buildClientErrorLog({
      error: { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
      operation: 'batch.commit',
      payloadFieldNames: ['uid', 'email', 'fullName', 'university', 'status', 'hasApplied', 'applicationStatus'],
      context: 'induction-submit',
    });

    expect(log.errorCode).toBe('permission-denied');
    expect(log.errorMessage).toBe('Missing or insufficient permissions.');
    expect(log.operation).toBe('batch.commit');
    expect(log.context).toBe('induction-submit');
    expect(log.payloadFieldNames).toEqual([
      'applicationStatus',
      'email',
      'fullName',
      'hasApplied',
      'status',
      'uid',
      'university',
    ]);
    expect(typeof log.clientBuildId).toBe('string');
    expect(typeof log.tabAgeMs).toBe('number');
    expect(typeof log.isStaleTabSuspected).toBe('boolean');
    expect(typeof log.clientTimestamp).toBe('string');
    expect(log.pathname).toBe('/');
    expect(log.freshnessStatus).toBe('not-checked');
    expect(log.liveBuildId).toBeNull();

    // No PII values: the log holds field NAMES only. Values that were never
    // passed in must not appear, and neither may any applicant identifier.
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain(secretEmail);
    expect(serialized).not.toContain('applicant-private');
    // Field names are present as names, not as values.
    expect(serialized).toContain('fullName');
  });

  it('passes the Team 2 guard verdict through into the log', () => {
    const log = buildClientErrorLog({
      error: { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
      operation: 'batch.commit',
      payloadFieldNames: ['uid'],
      freshness: { status: 'unchecked', liveBuildId: null },
    });
    expect(log.freshnessStatus).toBe('unchecked');
    expect(log.liveBuildId).toBeNull();
  });

  it('falls back to error name / unknown when code is absent', () => {
    const named = buildClientErrorLog({
      error: { name: 'FirebaseError', message: 'boom' },
      operation: 'batch.commit',
      payloadFieldNames: [],
    });
    expect(named.errorCode).toBe('FirebaseError');
    const unknown = buildClientErrorLog({
      error: new Error('plain'),
      operation: 'batch.commit',
      payloadFieldNames: [],
    });
    expect(unknown.errorCode).toBe('Error');
  });
});

describe('PII scrubbing', () => {
  it('redacts email-like tokens and long opaque tokens from error messages', () => {
    const scrubbed = scrubErrorMessage(
      'Failed for applicant-private@example.com with token abcdefghijklmnopqrstuvwxyz1234567890',
    );
    expect(scrubbed).not.toContain('applicant-private@example.com');
    expect(scrubbed).toContain('[redacted-email]');
    expect(scrubbed).toContain('[redacted-token]');
  });

  it('sanitizeFieldNames dedupes, sorts, and drops non-strings', () => {
    expect(sanitizeFieldNames(['b', 'a', 'b', 42, null, 'a', ''])).toEqual(['a', 'b']);
    expect(sanitizeFieldNames('not-an-array')).toEqual([]);
  });
});

describe('version marker / stale-tab signal', () => {
  it('flags a tab open longer than the threshold as a stale-tab suspect', () => {
    const origin =
      typeof performance !== 'undefined' ? performance.timeOrigin : Date.now();
    const old = getClientVersionMarker(origin + STALE_TAB_SUSPECT_AFTER_MS + 1000);
    expect(old.isStaleTabSuspected).toBe(true);
    const fresh = getClientVersionMarker(origin + 1000);
    expect(fresh.isStaleTabSuspected).toBe(false);
    expect(typeof fresh.clientBuildId).toBe('string');
  });
});

describe('reportClientError: logging failure never blocks the caller', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function validLog() {
    return buildClientErrorLog({
      error: { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
      operation: 'batch.commit',
      payloadFieldNames: ['uid', 'status'],
    });
  }

  it('resolves when fetch rejects (endpoint down)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reportClientError(validLog())).resolves.toBeUndefined();
  });

  it('resolves when fetch throws synchronously', async () => {
    global.fetch = jest.fn(() => {
      throw new Error('sync throw');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reportClientError(validLog())).resolves.toBeUndefined();
  });

  it('POSTs the sanitized log to /api/client-errors with no PII values', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await reportClientError(validLog());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/client-errors');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.operation).toBe('batch.commit');
    expect(body.errorCode).toBe('permission-denied');
    expect(body.payloadFieldNames).toEqual(['status', 'uid']);
    // No uid, no email, no form values travel in the client payload.
    expect(body).not.toHaveProperty('uid');
    expect(body).not.toHaveProperty('email');
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });
});
