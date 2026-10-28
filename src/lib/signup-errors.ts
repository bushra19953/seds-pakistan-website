/**
 * Signup error mapping for the public homepage join form.
 *
 * Security rule (audit item 20, user enumeration): the form must NEVER
 * surface Firebase Auth's raw error message. Codes such as
 * auth/email-already-in-use are a yes/no oracle for "is this email
 * registered", so every account-existence signal maps to ONE generic
 * message, identical to the message for unknown failures.
 *
 * Messages that ARE kept distinct reveal something about the caller's
 * own input or connection only, never about any account:
 * - auth/weak-password: the password they just typed is too weak.
 * - auth/invalid-email / auth/missing-email / auth/missing-password:
 *   the values they just typed are malformed.
 * - auth/network-request-failed: their connection failed.
 * - auth/too-many-requests: Firebase throttled this client; the state
 *   exists whether or not the email is registered.
 * Everything else, including auth/email-already-in-use, any code we do
 * not recognise, and errors with no code at all, returns GENERIC.
 */

export const GENERIC_SIGNUP_ERROR =
  'We could not create your account. Please check your details and try again.';

const INPUT_MESSAGES: Record<string, string> = {
  'auth/weak-password': 'Please choose a stronger password (at least 6 characters).',
  'auth/invalid-password': 'Please choose a stronger password (at least 6 characters).',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/missing-email': 'Please enter a valid email address.',
  'auth/missing-password': 'Please enter a password.',
  'auth/network-request-failed':
    'Network error. Please check your connection and try again.',
  'auth/too-many-requests':
    'Too many attempts. Please wait a few minutes and try again.',
};

/**
 * Map any error thrown during homepage signup to a safe display string.
 * The raw error message is never returned.
 */
export function getSignupErrorMessage(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  return INPUT_MESSAGES[code] || GENERIC_SIGNUP_ERROR;
}
