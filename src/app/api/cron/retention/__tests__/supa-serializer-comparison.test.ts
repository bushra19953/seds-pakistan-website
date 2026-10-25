/**
 * @jest-environment node
 *
 * C-G3-6 evidence for the retention route (Supabase migration, cluster
 * cron G3): retention archives docs to Google Drive through
 * serializeFirestoreValue (src/lib/backup/engine.ts) BEFORE any
 * mutation, and archives are legal records — if the adapter's value
 * shapes changed the serializer's output bytes, archiving from
 * Supabase would silently drift from archiving from Firestore.
 *
 * This test feeds the SAME instant in every shape the two stores hand
 * the engine and asserts byte-identical serialized output:
 *  - Firestore Admin Timestamp (what Firestore data() returns today),
 *  - the kit's dumped shape { _seconds, _nanoseconds },
 *  - a SupaTimestamp (what the adapter rehydrates dumped shapes to),
 *  - an ISO string (what the adapter stores for new writes),
 *  - a JS Date.
 * It also pins the non-timestamp field shapes retention archives
 * (strings, numbers, booleans, null, nested objects, arrays).
 * The serializer itself is NOT modified by this group.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { serializeFirestoreValue } from '@/lib/backup/engine';
import { SupaTimestamp } from '@/lib/supa/adapter';
import { dumpedTimestamp } from '@/lib/supa/__tests__/fake-supa';

const ISO = '2026-01-15T10:30:00.250Z';
const MS = Date.parse(ISO);

function docWith(createdAt: unknown) {
  return {
    id: 'rec-1',
    status: 'rejected',
    score: 42,
    flagged: false,
    reviewer: null,
    createdAt,
    history: [{ at: createdAt, action: 'submitted' }],
    tags: ['a', 'b'],
  };
}

describe('serializeFirestoreValue: Firestore shapes vs adapter shapes', () => {
  const firestoreDoc = docWith(Timestamp.fromMillis(MS));
  const expected = serializeFirestoreValue(firestoreDoc);

  it('the Firestore baseline serializes the Timestamp to its ISO string', () => {
    expect((expected as Record<string, unknown>).createdAt).toBe(ISO);
  });

  it.each([
    ['dumped { _seconds, _nanoseconds } shape', dumpedTimestamp(ISO)],
    ['SupaTimestamp (adapter rehydration)', SupaTimestamp.fromMillis(MS)],
    ['ISO string (adapter storage)', ISO],
    ['JS Date', new Date(MS)],
  ])('%s produces byte-identical archive output', (_label, value) => {
    const actual = serializeFirestoreValue(docWith(value));
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it('a whole collection snapshot serializes identically in both shapes', () => {
    const firestoreSide = [firestoreDoc, docWith(Timestamp.fromMillis(MS + 1000))];
    const adapterSide = [
      docWith(ISO),
      docWith(new Date(MS + 1000).toISOString()),
    ];
    expect(JSON.stringify(serializeFirestoreValue(adapterSide))).toBe(
      JSON.stringify(serializeFirestoreValue(firestoreSide)),
    );
  });
});
