require('@testing-library/jest-dom');

// Stub lucide-react ESM icons to avoid transform issues in Jest
jest.mock('lucide-react', () => {
  const handler = {
    get: () => () => null,
  };
  return new Proxy({}, handler);
});

// NOTE: '@/lib/supa' (the Supabase adapter, branch feat/supa-adapter) is
// stubbed for tests via moduleNameMapper in jest.config.js, which maps
// it to jest.supa-stub.ts on this base branch (the real module does not
// exist here yet, but the supa-events seams import it statically).
// Suites that exercise the flag-on path declare their own
// jest.mock('@/lib/supa') factory, which overrides the mapper.
