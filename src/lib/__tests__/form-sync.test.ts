/**
 * CONTRACT — dirty-wins form field sync (typing-lag fix, 2026-10-26).
 *
 * The assignee form surfaces (profile board card, task detail dialog)
 * used to re-seed their text fields from the task object on OBJECT
 * IDENTITY change with no dirty check: any fresh task object — a
 * Firestore snapshot event, a wholesale board refetch — silently
 * replaced the report being typed with the last saved text. The fix
 * routes every re-seed through `syncedFieldValue`:
 *
 *   syncedFieldValue(local, lastSynced, incoming)
 *     = incoming  when local === lastSynced (field untouched)
 *     = local     when local !== lastSynced (user has diverged: dirty wins)
 *
 * `lastSynced` is the value the field held at the last sync point
 * (initial seed, task switch, or a successful save of that value).
 * These cases pin the rule the components rely on.
 */

import { syncedFieldValue } from '@/lib/form-sync';

describe('syncedFieldValue — dirty-wins field sync', () => {
  it('adopts the incoming value while the field is untouched', () => {
    // User has not typed since the seed: local still equals lastSynced.
    expect(syncedFieldValue('saved report', 'saved report', 'reviewer-side update')).toBe(
      'reviewer-side update',
    );
  });

  it('keeps the local text once the user has diverged (dirty wins)', () => {
    // User typed over the seed; a fresh task object must not revert it.
    expect(syncedFieldValue('half-typed report', 'saved report', 'saved report')).toBe(
      'half-typed report',
    );
  });

  it('keeps the local text even when the incoming value also moved', () => {
    expect(syncedFieldValue('my new text', 'old saved', 'someone elses edit')).toBe('my new text');
  });

  it('adopts again after a save re-baselines the field', () => {
    // After saving, the component sets lastSynced to the saved text;
    // the field is clean again, so the next incoming value lands.
    const saved = 'the report I just saved';
    expect(syncedFieldValue(saved, saved, 'post-save server echo with tweaks')).toBe(
      'post-save server echo with tweaks',
    );
  });

  it('treats an empty field as adoptable, not dirty', () => {
    expect(syncedFieldValue('', '', 'seeded late')).toBe('seeded late');
  });

  it('is value-generic (hours field rides the same rule)', () => {
    expect(syncedFieldValue('2.5', '2.5', '3.0')).toBe('3.0');
    expect(syncedFieldValue('4.0', '2.5', '3.0')).toBe('4.0');
  });
});
