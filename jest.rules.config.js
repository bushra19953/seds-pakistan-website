// Firestore rules tests run ONLY against the emulator, under this separate
// config, so the main jest suite (testMatch **/*.test.*) never picks them up
// and never depends on the emulator or on @firebase/rules-unit-testing.
//
//   firebase emulators:exec --only firestore "npm run test:rules"
module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
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
    '<rootDir>/tests/rules/**/*.spec.ts',
  ],
  testTimeout: 30000,
};
