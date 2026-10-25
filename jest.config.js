module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    // '@/lib/supa' does not exist on this base branch (it lands with
    // feat/supa-adapter at merge step 0); the supa-events seams import
    // it statically, so tests resolve it to the safe stub. Suites with
    // their own jest.mock('@/lib/supa') factory override this. Delete
    // this line (and jest.supa-stub.ts) when the adapter lands.
    '^@/lib/supa$': '<rootDir>/jest.supa-stub.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
      },
    }],
  },
  testMatch: [
    '**/*.test.(ts|tsx|js|jsx)',
  ],
};