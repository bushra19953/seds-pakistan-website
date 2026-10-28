/**
 * Audit item 20: the homepage signup form must not enumerate accounts.
 * auth/email-already-in-use (and every other account-state or unknown
 * error) maps to the exact same generic message, and a raw Firebase
 * message is never surfaced. Only input/connection codes that reveal
 * nothing about account existence get distinct wording.
 */
import { getSignupErrorMessage, GENERIC_SIGNUP_ERROR } from '../signup-errors';

const fbError = (code: string, message: string) => ({ code, message });

describe('getSignupErrorMessage (item 20 enumeration fix)', () => {
  it('maps email-already-in-use to the generic message', () => {
    const msg = getSignupErrorMessage(
      fbError('auth/email-already-in-use', 'Firebase: Error (auth/email-already-in-use).'),
    );
    expect(msg).toBe(GENERIC_SIGNUP_ERROR);
    expect(msg.toLowerCase()).not.toContain('already');
    expect(msg).not.toContain('email-already-in-use');
  });

  it('gives the identical message for unknown, account-state and code-less errors', () => {
    const genericCases: unknown[] = [
      fbError('auth/internal-error', 'raw internal detail'),
      fbError('auth/operation-not-allowed', 'raw detail'),
      fbError('auth/user-disabled', 'raw detail'),
      fbError('auth/some-future-code', 'raw detail'),
      new Error('raw unexpected detail with PII-ish text'),
      { message: 'object without a code' },
      null,
      undefined,
      'a string error',
      42,
    ];
    for (const e of genericCases) {
      expect(getSignupErrorMessage(e)).toBe(GENERIC_SIGNUP_ERROR);
    }
    // The enumeration oracle is closed: already-in-use is indistinguishable.
    expect(
      getSignupErrorMessage(fbError('auth/email-already-in-use', 'x')),
    ).toBe(getSignupErrorMessage(fbError('auth/internal-error', 'y')));
  });

  it('never returns the raw error message', () => {
    const raw = 'Firebase: The email address is already in use by another account.';
    expect(getSignupErrorMessage(fbError('auth/email-already-in-use', raw))).not.toBe(raw);
    expect(getSignupErrorMessage(new Error(raw))).not.toBe(raw);
  });

  it('keeps input-only messages that reveal nothing about account existence', () => {
    expect(getSignupErrorMessage(fbError('auth/weak-password', 'x'))).toMatch(/stronger password/i);
    expect(getSignupErrorMessage(fbError('auth/invalid-email', 'x'))).toMatch(/valid email/i);
    expect(getSignupErrorMessage(fbError('auth/network-request-failed', 'x'))).toMatch(/network/i);
    expect(getSignupErrorMessage(fbError('auth/too-many-requests', 'x'))).toMatch(/too many attempts/i);
  });
});
