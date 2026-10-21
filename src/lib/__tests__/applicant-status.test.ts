/**
 * Tests for the Applicant Status Portal model (src/lib/applicant-status.ts).
 *
 * CONTRACT UNDER TEST:
 * - stored application statuses map onto the four portal stages
 *   Submitted -> Screening -> 72-Hour Crucible Sprint -> Final Onboarding.
 * - per-stage timestamps prefer stageHistory stamps and fall back to
 *   fields that already exist on older documents (created_at,
 *   reviewed_at), so no backfill is required.
 * - the reference ID is deterministic per application doc id, and the
 *   lookup normalizer only accepts well-formed IDs.
 * - buildStatusPayload is a strict allowlist: review internals and
 *   dynamic form answers never appear in the payload.
 * - self-service update validation rejects anything outside the
 *   whitelisted documents / domain preferences / milestones surface.
 */

import {
  buildStatusPayload,
  derivePipeline,
  makeReferenceId,
  milestonesUnlocked,
  normalizeReferenceId,
  normalizeTimestamp,
  readDocuments,
  readMilestones,
  sanitizeDomainPreferences,
  stageHistoryKeyForStatus,
  stageIndexForStatus,
  validateDocumentUpdate,
  validateDomainPreferences,
  validateMilestoneUpdate,
} from '../applicant-status';

const CREATED = new Date('2026-10-10T09:00:00.000Z');
const REVIEWED = new Date('2026-10-12T15:30:00.000Z');

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    fullName: 'Test Applicant',
    university: 'Institute of Space Technology',
    email: 'applicant@example.com',
    created_at: CREATED,
    reviewed_at: REVIEWED,
    ...overrides,
  };
}

describe('stage mapping', () => {
  test.each([
    ['pending', 1],
    ['under_review', 1],
    ['on_hold', 1],
    ['rejected', 1],
    ['shortlisted', 2],
    ['approved', 3],
  ])('status %s maps to stage index %s', (status, expected) => {
    expect(stageIndexForStatus(status)).toBe(expected);
  });

  test('unknown status falls back to screening', () => {
    expect(stageIndexForStatus('surprise')).toBe(1);
  });

  test('stage history stamps line up with admin status changes', () => {
    expect(stageHistoryKeyForStatus('under_review')).toBe('screeningAt');
    expect(stageHistoryKeyForStatus('shortlisted')).toBe('crucibleAt');
    expect(stageHistoryKeyForStatus('approved')).toBe('onboardingAt');
    expect(stageHistoryKeyForStatus('rejected')).toBe('decidedAt');
    expect(stageHistoryKeyForStatus('surprise')).toBeNull();
  });
});

describe('derivePipeline', () => {
  test('pending: submitted complete, screening current with created_at timestamp', () => {
    const result = derivePipeline(baseRecord());
    expect(result.terminalRejected).toBe(false);
    expect(result.currentStageIndex).toBe(1);
    // Phase 2 F.7: a fifth 'cadetship' stage trails the pipeline (upcoming here).
    expect(result.stages.map((s) => s.state)).toEqual(['complete', 'current', 'upcoming', 'upcoming', 'upcoming']);
    expect(result.stages[0].timestamp).toBe(CREATED.toISOString());
    expect(result.stages[1].timestamp).toBe(CREATED.toISOString());
    expect(result.stages[2].timestamp).toBeNull();
  });

  test('shortlisted: crucible is current and stamped from reviewed_at fallback', () => {
    const result = derivePipeline(baseRecord({ status: 'shortlisted' }));
    expect(result.currentStageIndex).toBe(2);
    expect(result.stages.map((s) => s.state)).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming']);
    expect(result.stages[2].timestamp).toBe(REVIEWED.toISOString());
  });

  test('stageHistory stamps win over the reviewed_at fallback', () => {
    const crucibleAt = new Date('2026-10-13T08:00:00.000Z');
    const result = derivePipeline(
      baseRecord({ status: 'shortlisted', stageHistory: { crucibleAt } })
    );
    expect(result.stages[2].timestamp).toBe(crucibleAt.toISOString());
  });

  test('approved: onboarding current, everything before it complete', () => {
    const result = derivePipeline(baseRecord({ status: 'approved' }));
    expect(result.currentStageIndex).toBe(3);
    expect(result.stages.map((s) => s.state)).toEqual(['complete', 'complete', 'complete', 'current', 'upcoming']);
  });

  test('rejected: terminal at screening, later stages skipped', () => {
    const result = derivePipeline(baseRecord({ status: 'rejected' }));
    expect(result.terminalRejected).toBe(true);
    expect(result.stages.map((s) => s.state)).toEqual(['complete', 'complete', 'skipped', 'skipped', 'skipped']);
    expect(result.stages[1].note).toContain('not accepted');
  });

  test('on_hold keeps screening current with an on-hold note', () => {
    const result = derivePipeline(baseRecord({ status: 'on_hold' }));
    expect(result.stages[1].state).toBe('current');
    expect(result.stages[1].note).toContain('on hold');
  });
});

describe('normalizeTimestamp', () => {
  test('passes Dates and ISO strings through', () => {
    expect(normalizeTimestamp(CREATED)).toBe(CREATED.toISOString());
    expect(normalizeTimestamp('2026-10-10T09:00:00.000Z')).toBe('2026-10-10T09:00:00.000Z');
  });

  test('converts Firestore { seconds, nanoseconds } objects', () => {
    const seconds = Math.floor(CREATED.getTime() / 1000);
    expect(normalizeTimestamp({ seconds, nanoseconds: 0 })).toBe(CREATED.toISOString());
  });

  test('calls toDate() on Timestamp-like objects', () => {
    expect(normalizeTimestamp({ toDate: () => CREATED })).toBe(CREATED.toISOString());
  });

  test('returns null for unusable values', () => {
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(undefined)).toBeNull();
    expect(normalizeTimestamp('not a date')).toBeNull();
    expect(normalizeTimestamp({})).toBeNull();
  });
});

describe('reference IDs', () => {
  test('derives a stable SEDS-XXXXXX id from the uid', () => {
    expect(makeReferenceId('aliceuid123456')).toBe('SEDS-ALICEU');
    expect(makeReferenceId('aliceuid123456')).toBe(makeReferenceId('aliceuid123456'));
    expect(makeReferenceId('bob')).toBe('SEDS-BOB000');
  });

  test('normalizeReferenceId accepts well-formed ids case-insensitively', () => {
    expect(normalizeReferenceId('seds-aliceu')).toBe('SEDS-ALICEU');
    expect(normalizeReferenceId('  SEDS-ABC123 ')).toBe('SEDS-ABC123');
  });

  test('normalizeReferenceId rejects malformed ids', () => {
    expect(normalizeReferenceId('SEDS-ABC')).toBeNull();
    expect(normalizeReferenceId('SEDS-ABC1234')).toBeNull();
    expect(normalizeReferenceId('aliceuid123456')).toBeNull();
    expect(normalizeReferenceId(42)).toBeNull();
    expect(normalizeReferenceId(null)).toBeNull();
  });
});

describe('domain preferences', () => {
  test('keeps whitelisted values in canonical order and de-duplicates', () => {
    expect(sanitizeDomainPreferences(['gnc', 'propulsion', 'gnc', 'bogus'])).toEqual([
      'propulsion',
      'gnc',
    ]);
    expect(sanitizeDomainPreferences('propulsion')).toEqual([]);
    expect(sanitizeDomainPreferences(undefined)).toEqual([]);
  });

  test('validateDomainPreferences rejects unknown values', () => {
    expect(validateDomainPreferences(['propulsion']).ok).toBe(true);
    expect(validateDomainPreferences(['propulsion', 'space_law']).ok).toBe(false);
    expect(validateDomainPreferences('propulsion').ok).toBe(false);
  });
});

describe('documents', () => {
  test('readDocuments maps stored fields and tolerates blanks', () => {
    expect(
      readDocuments({
        resume_url: 'https://drive.google.com/file/d/1',
        transcript_url: '',
        portfolioLink: 'https://me.example.com',
        githubLink: 42,
      })
    ).toEqual({
      resumeUrl: 'https://drive.google.com/file/d/1',
      transcriptUrl: null,
      portfolioLink: 'https://me.example.com',
      githubLink: null,
    });
  });

  test('validateDocumentUpdate accepts drive links and plain URLs', () => {
    const result = validateDocumentUpdate({
      resumeUrl: 'https://drive.google.com/file/d/abc/view',
      portfolioLink: 'https://me.example.com',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resume_url).toBe('https://drive.google.com/file/d/abc/view');
      expect(result.value.portfolioLink).toBe('https://me.example.com');
    }
  });

  test('validateDocumentUpdate enforces Drive links for resume and transcript', () => {
    expect(validateDocumentUpdate({ resumeUrl: 'https://example.com/cv.pdf' }).ok).toBe(false);
    expect(validateDocumentUpdate({ transcriptUrl: 'https://dropbox.com/t.pdf' }).ok).toBe(false);
  });

  test('validateDocumentUpdate rejects admin fields and unknown keys', () => {
    expect(validateDocumentUpdate({ status: 'approved' }).ok).toBe(false);
    expect(validateDocumentUpdate({ reviewed_by: 'someone' }).ok).toBe(false);
    expect(validateDocumentUpdate({ pre_score: 99 }).ok).toBe(false);
  });

  test('validateDocumentUpdate allows clearing a link with an empty value', () => {
    const result = validateDocumentUpdate({ githubLink: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.githubLink).toBeNull();
  });
});

describe('milestones', () => {
  test('milestones unlock only at shortlisted or approved', () => {
    expect(milestonesUnlocked('pending')).toBe(false);
    expect(milestonesUnlocked('under_review')).toBe(false);
    expect(milestonesUnlocked('shortlisted')).toBe(true);
    expect(milestonesUnlocked('approved')).toBe(true);
  });

  test('readMilestones returns every key with timestamp or null', () => {
    expect(readMilestones({ onboardingMilestones: { cruciblePledge: CREATED } })).toEqual({
      cruciblePledge: CREATED.toISOString(),
      whatsappJoined: null,
      starterRepoAccess: null,
    });
    expect(readMilestones({})).toEqual({
      cruciblePledge: null,
      whatsappJoined: null,
      starterRepoAccess: null,
    });
  });

  test('validateMilestoneUpdate only accepts known keys with boolean values', () => {
    expect(validateMilestoneUpdate({ cruciblePledge: true }).ok).toBe(true);
    expect(validateMilestoneUpdate({ adminOverride: true }).ok).toBe(false);
    expect(validateMilestoneUpdate({ cruciblePledge: 'yes' }).ok).toBe(false);
    expect(validateMilestoneUpdate({}).ok).toBe(false);
  });
});

describe('buildStatusPayload', () => {
  test('returns only allowlisted fields, never review internals', () => {
    const payload = buildStatusPayload(
      baseRecord({
        status: 'shortlisted',
        reviewed_by: 'admin-uid',
        rejection_reason: 'secret',
        pre_score: 87,
        someDynamicAnswer: 'should not leak',
      }),
      'aliceuid123456',
      { canEdit: true }
    );
    const keys = Object.keys(payload);
    expect(keys).not.toContain('reviewed_by');
    expect(keys).not.toContain('rejection_reason');
    expect(keys).not.toContain('pre_score');
    expect(keys).not.toContain('someDynamicAnswer');
    expect(keys).not.toContain('email');
    expect(payload.referenceId).toBe('SEDS-ALICEU');
    expect(payload.canEdit).toBe(true);
    expect(payload.milestonesEditable).toBe(true);
  });

  test('falls back to the users mirror for domain preferences after a resubmit', () => {
    const fresh = buildStatusPayload(baseRecord({ domainPreferences: ['gnc'] }), 'uid-1', {
      canEdit: true,
      fallbackDomainPreferences: ['propulsion'],
    });
    expect(fresh.domainPreferences).toEqual(['gnc']);

    const wiped = buildStatusPayload(baseRecord(), 'uid-1', {
      canEdit: true,
      fallbackDomainPreferences: ['propulsion'],
    });
    expect(wiped.domainPreferences).toEqual(['propulsion']);
  });

  test('rejected payload is read only for milestones and terminal', () => {
    const payload = buildStatusPayload(baseRecord({ status: 'rejected' }), 'uid-2', {
      canEdit: true,
    });
    expect(payload.terminalRejected).toBe(true);
    expect(payload.milestonesEditable).toBe(false);
  });
});
