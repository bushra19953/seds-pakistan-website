/**
 * @jest-environment node
 *
 * F1 — ADAPTER PATH GENERALISATION pins for resolveTarget()
 * (BUILDOUT_AUDIT §5, flip-blocker F1).
 *
 * The real adapter originally accepted only 1- and 3-segment
 * collection paths and threw `bad-path` on the 5-segment AGM
 * recipients path. The generalised rule pinned here:
 *
 *   1 segment            -> top-level table fs_<segment>,
 *                           parentPath = the segment itself,
 *                           NOT a subcollection.
 *   odd segments >= 3    -> group table fs_group_<last segment>,
 *                           parentPath = the FULL collection path,
 *                           subcollection.
 *   even segment counts  -> throw SupaAdapterError code "bad-path".
 *   empty / blank paths  -> throw SupaAdapterError code "bad-path".
 *
 * These pins exist so NO existing shape changes meaning when the
 * generalisation lands: 'tasks', 'users/{uid}/notifications' and
 * 'events/{id}/registrations' must resolve exactly as they did
 * before, and the 5-segment recipients path (already implemented
 * locally by agm-domain-supa's bridge) must resolve the same way
 * at the adapter.
 *
 * Zero live reads: resolveTarget is a pure function.
 */

jest.mock(
  '@supabase/supabase-js',
  () => ({ createClient: jest.fn(() => null) }),
  { virtual: true },
);

import { resolveTarget, SupaAdapterError } from '../adapter';

function expectBadPath(path: string): void {
  let thrown: unknown = null;
  try {
    resolveTarget(path);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SupaAdapterError);
  expect((thrown as SupaAdapterError).code).toBe('bad-path');
}

describe('F1 resolveTarget: existing shapes keep their meaning', () => {
  it("1-segment 'tasks' -> fs_tasks, parentPath 'tasks', not a subcollection", () => {
    expect(resolveTarget('tasks')).toEqual({
      table: 'fs_tasks',
      parentPath: 'tasks',
      isSubcollection: false,
    });
  });

  it("3-segment 'users/{uid}/notifications' -> fs_group_notifications, parentPath = full path", () => {
    expect(resolveTarget('users/u1/notifications')).toEqual({
      table: 'fs_group_notifications',
      parentPath: 'users/u1/notifications',
      isSubcollection: true,
    });
  });

  it("3-segment 'events/{id}/registrations' -> fs_group_registrations, parentPath = full path", () => {
    expect(resolveTarget('events/ev1/registrations')).toEqual({
      table: 'fs_group_registrations',
      parentPath: 'events/ev1/registrations',
      isSubcollection: true,
    });
  });
});

describe('F1 resolveTarget: odd segment counts >= 3 generalise by the same rule', () => {
  it("5-segment AGM recipients path -> fs_group_recipients, parentPath = the full 5-segment path", () => {
    expect(
      resolveTarget('agm_events/agm1/notices/notice1/recipients'),
    ).toEqual({
      table: 'fs_group_recipients',
      parentPath: 'agm_events/agm1/notices/notice1/recipients',
      isSubcollection: true,
    });
  });

  it('7-segment odd path resolves by the same rule (last segment names the group table)', () => {
    expect(
      resolveTarget('agm_events/agm1/notices/notice1/recipients/r1/acks'),
    ).toEqual({
      table: 'fs_group_acks',
      parentPath: 'agm_events/agm1/notices/notice1/recipients/r1/acks',
      isSubcollection: true,
    });
  });
});

describe('F1 resolveTarget: invalid paths throw bad-path', () => {
  it('2 segments (a document path, not a collection path) throws', () => {
    expectBadPath('users/u1');
  });

  it('4 segments throws', () => {
    expectBadPath('agm_events/agm1/notices/notice1');
  });

  it('empty path throws', () => {
    expectBadPath('');
  });

  it('blank path (separators / whitespace only) throws', () => {
    expectBadPath('///');
    expectBadPath('   ');
  });
});
