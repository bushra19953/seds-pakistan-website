/**
 * user-contact.test.ts — pins the contact-record contract (audit
 * 2026-10-28 item 6 residual): the projection keeps exactly the contact
 * fields, mirrors the whatsapp alias pair, derives email_lowercase, and
 * the server doorway reads/writes ONLY users/{uid}/private/contact.
 */

jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));

import {
  pickContactFields,
  stripContactFields,
  hasContactFields,
  CONTACT_FIELD_NAMES,
} from '@/lib/user-contact-shared';
import {
  getUserContact,
  getUserContacts,
  setUserContact,
  clearUserContact,
  contactDocRef,
} from '@/lib/server/user-contact';

describe('pickContactFields', () => {
  it('keeps only contact fields and drops everything else', () => {
    const out = pickContactFields({
      email: 'person@example.com',
      whatsappNumber: '+92 300 0000000',
      displayName: 'Person',
      role: 'member_basic',
      points: 42,
    });
    expect(Object.keys(out).sort()).toEqual(['email', 'email_lowercase', 'whatsapp', 'whatsappNumber'].sort());
    expect(out.email).toBe('person@example.com');
  });

  it('mirrors the whatsapp alias pair in both directions', () => {
    expect(pickContactFields({ whatsapp: '111' })).toEqual({ whatsapp: '111', whatsappNumber: '111' });
    expect(pickContactFields({ whatsappNumber: '222' })).toEqual({ whatsapp: '222', whatsappNumber: '222' });
    const both = pickContactFields({ whatsapp: '111', whatsappNumber: '222' });
    expect(both.whatsapp).toBe('111');
    expect(both.whatsappNumber).toBe('222');
  });

  it('derives email_lowercase from email and trims values', () => {
    const out = pickContactFields({ email: '  Mixed.Case@Example.COM ' });
    expect(out.email).toBe('Mixed.Case@Example.COM');
    expect(out.email_lowercase).toBe('mixed.case@example.com');
  });

  it('drops empty, whitespace-only, and non-string values', () => {
    const out = pickContactFields({ email: '   ', whatsapp: 12345, phone: null, cnic: '35202-1' });
    expect(out).toEqual({ cnic: '35202-1' });
    expect(hasContactFields(out)).toBe(true);
    expect(hasContactFields(pickContactFields({ displayName: 'x' }))).toBe(false);
    expect(pickContactFields(null)).toEqual({});
    expect(pickContactFields(undefined)).toEqual({});
  });
});

describe('stripContactFields', () => {
  it('removes every contact field and keeps the rest', () => {
    const record: Record<string, unknown> = { displayName: 'Person', role: 'member_basic' };
    for (const name of CONTACT_FIELD_NAMES) record[name] = 'x';
    const out = stripContactFields(record);
    expect(out).toEqual({ displayName: 'Person', role: 'member_basic' });
    // The source record is not mutated.
    expect(record.email).toBe('x');
  });
});

/** Minimal fake of the Admin Firestore surface the doorway uses. */
function fakeDb(store: Map<string, Record<string, unknown>>) {
  const refFor = (uid: string) => ({
    id: 'contact',
    path: `users/${uid}/private/contact`,
    parent: { parent: { id: uid } },
    get: async () => ({
      exists: store.has(uid),
      data: () => store.get(uid),
      ref: refFor(uid),
    }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      if (opts?.merge) store.set(uid, { ...(store.get(uid) ?? {}), ...data });
      else store.set(uid, { ...data });
    },
    delete: async () => {
      store.delete(uid);
    },
  });
  return {
    collection: () => ({
      doc: (uid: string) => ({
        collection: () => ({ doc: () => refFor(uid) }),
      }),
    }),
    getAll: async (...refs: ReturnType<typeof refFor>[]) =>
      Promise.all(refs.map(async (ref) => ({ ...(await ref.get()), ref }))),
  } as unknown as FirebaseFirestore.Firestore;
}

describe('server doorway', () => {
  it('addresses users/{uid}/private/contact', () => {
    const store = new Map<string, Record<string, unknown>>();
    const db = fakeDb(store);
    expect(contactDocRef(db, 'u1').path).toBe('users/u1/private/contact');
  });

  it('round-trips a contact write and read with projection applied', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const db = fakeDb(store);
    await setUserContact(db, 'u1', { email: 'A@B.co', whatsappNumber: '0300', displayName: 'Nope' });
    expect(store.get('u1')).toEqual({
      email: 'A@B.co',
      email_lowercase: 'a@b.co',
      whatsapp: '0300',
      whatsappNumber: '0300',
    });
    await expect(getUserContact(db, 'u1')).resolves.toEqual(store.get('u1'));
    await expect(getUserContact(db, 'missing')).resolves.toBeNull();
  });

  it('batch reads skip missing docs and de-duplicate uids', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['u1', { email: 'a@b.co' }],
      ['u2', { whatsapp: '0300', whatsappNumber: '0300' }],
    ]);
    const db = fakeDb(store);
    const map = await getUserContacts(db, ['u1', 'u2', 'u1', 'nope']);
    expect([...map.keys()].sort()).toEqual(['u1', 'u2']);
    expect(map.get('u2')?.whatsapp).toBe('0300');
  });

  it('an empty projection writes nothing; clear deletes the doc', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const db = fakeDb(store);
    await setUserContact(db, 'u1', { displayName: 'Nope' });
    expect(store.has('u1')).toBe(false);
    await setUserContact(db, 'u1', { email: 'a@b.co' });
    await clearUserContact(db, 'u1');
    expect(store.has('u1')).toBe(false);
  });
});
