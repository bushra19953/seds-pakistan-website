/**
 * Read-bleed train 2, CRM item 1: the contacts fallback query must be
 * BOUNDED. getAllQuery is the CRM page's seam-failure fallback only
 * (the live path is the Supabase seam poll); before the fix it carried
 * no limit, so every activation read the whole sponsors_partners
 * collection. Firestore is mocked at the module boundary — the test
 * pins the composed query constraints, zero live reads.
 */
import { query, orderBy, limit } from 'firebase/firestore';

jest.mock('firebase/firestore', () => ({
  query: jest.fn((...args: unknown[]) => ({ __args: args })),
  collection: jest.fn(() => 'COLLECTION'),
  where: jest.fn((...args: unknown[]) => ({ __where: args })),
  orderBy: jest.fn((...args: unknown[]) => ({ __orderBy: args })),
  limit: jest.fn((n: number) => ({ __limit: n })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  doc: jest.fn(),
  serverTimestamp: jest.fn(() => 'SERVER_TS'),
  Timestamp: class {},
}));

jest.mock('../partners', () => ({
  partnersCollection: jest.fn(() => 'PARTNERS_COLLECTION'),
  createPartner: jest.fn(),
  updatePartner: jest.fn(),
  deletePartner: jest.fn(),
}));

import { ContactsRepository, CONTACTS_FALLBACK_LIMIT } from '../contacts-repository';

describe('ContactsRepository.getAllQuery (fallback bound)', () => {
  it('composes collection + updatedAt desc + the fallback limit', () => {
    const repo = new ContactsRepository({} as never);
    const q = repo.getAllQuery() as unknown as { __args: unknown[] };
    expect(orderBy).toHaveBeenCalledWith('updatedAt', 'desc');
    expect(limit).toHaveBeenCalledWith(CONTACTS_FALLBACK_LIMIT);
    expect(q.__args[0]).toBe('PARTNERS_COLLECTION');
    expect(q.__args).toContainEqual({ __limit: CONTACTS_FALLBACK_LIMIT });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('the cap is a positive finite number', () => {
    expect(Number.isFinite(CONTACTS_FALLBACK_LIMIT)).toBe(true);
    expect(CONTACTS_FALLBACK_LIMIT).toBeGreaterThan(0);
  });
});
