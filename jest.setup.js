require('@testing-library/jest-dom');

// Stub lucide-react ESM icons to avoid transform issues in Jest
jest.mock('lucide-react', () => {
  const handler = {
    get: () => () => null,
  };
  return new Proxy({}, handler);
});
