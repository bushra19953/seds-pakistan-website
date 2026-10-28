import { getSafeRedirectPath, isSafeRedirectPath } from '../safe-redirect';

// Security audit 2026-10-28, item 19: one shared validator for every
// callbackUrl / redirect consumer. The old auth-form check accepted
// `//evil.com` (protocol-relative) because it only asserted
// startsWith('/'), and /welcome applied no check at all.

describe('isSafeRedirectPath — accepts legitimate same-origin paths', () => {
  it.each([
    '/dashboard',
    '/profile',
    '/',
    '/tasks?x=1',
    '/events/slug?action=checkout',
    '/admin/tasks?foo=bar&baz=qux',
    '/search?q=hello world', // space arrives already decoded from URLSearchParams
    '/tasks?progress=100%', // malformed escape: decoding stops, value stays a same-origin path
  ])('accepts %s', (target) => {
    expect(isSafeRedirectPath(target)).toBe(true);
    expect(getSafeRedirectPath(target, '/profile')).toBe(target);
  });
});

describe('isSafeRedirectPath — rejects off-site and scheme targets', () => {
  it.each([
    '//evil.com',
    '///evil.com',
    '/\\evil.com',
    '/\\\\evil.com',
    'https://evil.com',
    'https://evil.com/dashboard',
    'http://evil.com',
    '//evil.com/dashboard',
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'evil.com',
    'dashboard',
    '\\\\evil.com',
  ])('rejects %s', (target) => {
    expect(isSafeRedirectPath(target)).toBe(false);
    expect(getSafeRedirectPath(target, '/profile')).toBe('/profile');
  });
});

describe('isSafeRedirectPath — rejects encoded variants after decoding', () => {
  it.each([
    '%2f%2fevil.com',
    '/%2fevil.com',
    '/%2F%2Fevil.com',
    '%252f%252fevil.com', // double-encoded
    '/%252fevil.com', // double-encoded second slash
    '/%25252fevil.com', // triple-encoded second slash
    '%5cevil.com',
    '/%5cevil.com',
    '/%5Cevil.com',
    '/%09%2fevil.com', // decodes to tab + slash
    '/foo%0abar', // decodes to a control character
    '/foo/%2e%2e/bar', // decodes to a .. segment
  ])('rejects %s', (target) => {
    expect(isSafeRedirectPath(target)).toBe(false);
    expect(getSafeRedirectPath(target)).toBe('/');
  });
});

describe('isSafeRedirectPath — keeps the historical auth-form rules', () => {
  it.each(['/auth/login', '/auth/', '/auth/signup?callbackUrl=/tasks'])(
    'rejects auth-flow target %s',
    (target) => {
      expect(isSafeRedirectPath(target)).toBe(false);
    },
  );

  it.each(['/../', '/..', '/foo/../bar', '/foo/../../etc'])(
    'rejects dot-dot target %s',
    (target) => {
      expect(isSafeRedirectPath(target)).toBe(false);
    },
  );
});

describe('isSafeRedirectPath — rejects junk input', () => {
  it.each([
    '',
    ' ',
    '  /dashboard', // leading whitespace trick
    '/dashboard\n', // trailing control character
    '/\tevil.com',
    '/dashboard\u007f',
  ])('rejects %j', (target) => {
    expect(isSafeRedirectPath(target)).toBe(false);
  });

  it.each([null, undefined, 42, {}, [], true])(
    'rejects non-string %j',
    (target) => {
      expect(isSafeRedirectPath(target)).toBe(false);
      expect(getSafeRedirectPath(target, '/profile')).toBe('/profile');
    },
  );

  it('rejects over-long targets', () => {
    expect(isSafeRedirectPath('/' + 'a'.repeat(3000))).toBe(false);
  });
});

describe('getSafeRedirectPath — fallback behaviour', () => {
  it('defaults the fallback to /', () => {
    expect(getSafeRedirectPath(null)).toBe('/');
    expect(getSafeRedirectPath('//evil.com')).toBe('/');
    expect(getSafeRedirectPath('')).toBe('/');
  });

  it('honours a caller-supplied fallback', () => {
    expect(getSafeRedirectPath(undefined, '/profile')).toBe('/profile');
    expect(getSafeRedirectPath('https://evil.com', '/profile')).toBe(
      '/profile',
    );
  });

  it('returns the candidate untouched when it is safe', () => {
    expect(getSafeRedirectPath('/tasks?x=1', '/profile')).toBe('/tasks?x=1');
  });
});
