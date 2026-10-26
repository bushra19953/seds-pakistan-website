/**
 * CONTRACT — mission step submit page draft persistence (typing-lag fix,
 * 2026-10-26).
 *
 * The submit page (/missions/[workflowId]/submit/[stepIndex]) used to
 * keep the work report only in component state: navigating back to the
 * mission page to re-read the brief unmounted the form, and returning
 * cold-loaded the page and re-seeded from the last SAVED server values —
 * unsaved typing was silently lost. The fix persists the in-progress
 * fields to sessionStorage per task via this module.
 *
 * Seed rule (three-way): a stored draft wins ONLY when the server copy
 * still equals the draft's `baseReport` (the server report the draft
 * was started from). If the server copy moved — saved from another
 * surface, submitted, withdrawn — the server wins and the stale draft
 * is dropped. A successful Save Progress / Submit clears the draft.
 */

import {
  clearDraft,
  draftKey,
  loadDraft,
  resolveDraftSeed,
  saveDraft,
  type StepSubmitDraft,
} from '@/lib/step-submit-draft';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

const DRAFT: StepSubmitDraft = {
  report: 'half-written report',
  hours: '2.5',
  links: 'https://drive.example/proof',
  baseReport: 'previously saved report',
};

describe('step-submit draft storage', () => {
  it('keys drafts per task', () => {
    expect(draftKey('task-a')).not.toBe(draftKey('task-b'));
    expect(draftKey('task-a')).toContain('task-a');
  });

  it('round-trips a saved draft', () => {
    const storage = fakeStorage();
    saveDraft(storage, 'task-a', DRAFT);
    expect(loadDraft(storage, 'task-a')).toEqual(DRAFT);
  });

  it('returns null when no draft exists', () => {
    expect(loadDraft(fakeStorage(), 'task-a')).toBeNull();
  });

  it('returns null for corrupt stored JSON instead of throwing', () => {
    const storage = fakeStorage();
    storage.setItem(draftKey('task-a'), '{not json');
    expect(loadDraft(storage, 'task-a')).toBeNull();
  });

  it('returns null for a stored value with the wrong shape', () => {
    const storage = fakeStorage();
    storage.setItem(draftKey('task-a'), JSON.stringify({ report: 42 }));
    expect(loadDraft(storage, 'task-a')).toBeNull();
  });

  it('clearDraft removes the draft', () => {
    const storage = fakeStorage();
    saveDraft(storage, 'task-a', DRAFT);
    clearDraft(storage, 'task-a');
    expect(loadDraft(storage, 'task-a')).toBeNull();
  });

  it('drafts for different tasks do not collide', () => {
    const storage = fakeStorage();
    saveDraft(storage, 'task-a', DRAFT);
    expect(loadDraft(storage, 'task-b')).toBeNull();
  });
});

describe('resolveDraftSeed — three-way seed rule', () => {
  it('seeds from the draft when the server copy has not moved', () => {
    expect(resolveDraftSeed('previously saved report', DRAFT)).toEqual({
      report: DRAFT.report,
      hours: DRAFT.hours,
      links: DRAFT.links,
    });
  });

  it('returns null when there is no draft (caller seeds from server)', () => {
    expect(resolveDraftSeed('anything', null)).toBeNull();
  });

  it('returns null when the server copy moved since the draft was written', () => {
    // The task was saved/submitted from another surface meanwhile; the
    // stale draft must NOT resurrect over the newer server text.
    expect(resolveDraftSeed('newer server report', DRAFT)).toBeNull();
  });

  it('seeds an untouched draft started from an empty server report', () => {
    const draft: StepSubmitDraft = { report: 'fresh typing', hours: '', links: '', baseReport: '' };
    expect(resolveDraftSeed('', draft)).toEqual({ report: 'fresh typing', hours: '', links: '' });
  });
});
