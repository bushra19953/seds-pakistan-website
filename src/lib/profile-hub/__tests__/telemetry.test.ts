/**
 * @jest-environment node
 *
 * WS3 Profile Hub pure helpers: telemetry, mission timeline, probation,
 * public portfolio sanitisation, opt-in resolution, certificate links.
 */
import {
  buildCertificateVerificationUrl,
  buildLinkedInAddToProfileUrl,
  buildLinkedInShareUrl,
  buildMissionTimeline,
  canViewProbation,
  computeTelemetry,
  extractProofLinks,
  isValidUsername,
  resolvePublicDirectoryOptIn,
  sanitizeCertificateForVault,
  sanitizePublicProfile,
  slugifyUsername,
  summarizeWarnings,
  toPublicTimeline,
} from '../telemetry';

const d = (iso: string) => new Date(iso);

describe('computeTelemetry', () => {
  it('computes completed, on-time rate, hours and derived quality from tasks', () => {
    const t = computeTelemetry({
      tasks: [
        { id: 'a', status: 'completed', deadline: d('2026-10-10T00:00:00Z'), completedAt: d('2026-10-09T00:00:00Z'), hoursWorked: 3, points: 10 },
        { id: 'b', status: 'completed', deadline: d('2026-10-10T00:00:00Z'), completedAt: d('2026-10-12T00:00:00Z'), hoursWorked: 2, points: 5, penaltyPoints: 2 },
        { id: 'c', status: 'pending', deadline: d('2026-11-01T00:00:00Z') },
        { id: 'e', status: 'in-progress' },
      ],
    });
    expect(t.tasksAssigned).toBe(4);
    expect(t.tasksCompleted).toBe(2);
    expect(t.onTimeRate).toBe(0.5);
    expect(t.onTimeCount).toBe(1);
    expect(t.lateCount).toBe(1);
    expect(t.loggedHours).toBe(5);
    expect(t.totalPoints).toBe(15);
    expect(t.penaltiesApplied).toBe(2);
    // derived: 0.6*0.5 + 0.4*(2/4) = 0.5
    expect(t.qualityIndex).toBe(50);
    expect(t.qualityIndexBasis).toBe('derived');
  });

  it('prefers stored counters when they are larger than the sampled tasks', () => {
    const t = computeTelemetry({
      tasks: [{ id: 'a', status: 'completed', hoursWorked: 1 }],
      counters: { tasksAssignedCount: 40, tasksCompletedCount: 30, totalHoursWorked: 99, points: 500 },
    });
    expect(t.tasksAssigned).toBe(40);
    expect(t.tasksCompleted).toBe(30);
    expect(t.loggedHours).toBe(99);
    expect(t.totalPoints).toBe(500);
  });

  it('uses ledger points and completed_late, and returns null rates with no dated completions', () => {
    const t = computeTelemetry({
      tasks: [{ id: 'a', status: 'completed', completedAt: d('2026-10-09T00:00:00Z') }],
      ledgerEntries: [
        { user_id: 'u1', action: 'COMPLETION', points_awarded: 25, completed_late: true },
        { user_id: 'u1', action: 'PENALTY', points_awarded: 0, penalty_applied: 5 },
      ],
    });
    expect(t.totalPoints).toBe(25);
    expect(t.lateCount).toBe(1);
    expect(t.penaltiesApplied).toBe(5);
    expect(t.onTimeRate).toBeNull();
    expect(t.qualityIndex).toBeNull();
  });

  it('uses explicit reviewer scores (0..5 scaled to 100) when present', () => {
    const t = computeTelemetry({
      tasks: [
        { id: 'a', status: 'completed', qualityScore: 4 },
        { id: 'b', status: 'completed', reviewScore: 90 },
      ],
    });
    expect(t.qualityIndex).toBe(85);
    expect(t.qualityIndexBasis).toBe('explicit');
  });

  it('handles empty input', () => {
    const t = computeTelemetry({});
    expect(t).toMatchObject({ tasksAssigned: 0, tasksCompleted: 0, onTimeRate: null, loggedHours: 0, totalPoints: 0, qualityIndex: null });
  });
});

describe('mission timeline and proof links', () => {
  it('extracts deliverable files and resource links, deduped', () => {
    const proof = extractProofLinks({
      deliverableFiles: [{ fileName: 'report.pdf', downloadUrl: 'https://drive.example/1' }],
      resourceLinks: 'https://example.com/a\nhttps://drive.example/1\n',
    });
    expect(proof).toEqual([
      { url: 'https://drive.example/1', label: 'report.pdf', kind: 'file' },
      { url: 'https://example.com/a', label: 'https://example.com/a', kind: 'link' },
    ]);
  });

  it('sorts completed tasks newest first, computes on-time, skips open tasks', () => {
    const timeline = buildMissionTimeline([
      { id: 'old', title: 'Old', status: 'completed', completedAt: d('2026-09-01T00:00:00Z'), deadline: d('2026-09-02T00:00:00Z') },
      { id: 'open', title: 'Open', status: 'pending' },
      { id: 'new', title: 'New', status: 'completed', completedAt: d('2026-10-01T00:00:00Z'), deadline: d('2026-09-30T00:00:00Z'), hoursWorked: 4 },
    ]);
    expect(timeline.map((e) => e.taskId)).toEqual(['new', 'old']);
    expect(timeline[0].wasOnTime).toBe(false);
    expect(timeline[1].wasOnTime).toBe(true);
  });

  it('strips proof from the public timeline', () => {
    const [pub] = toPublicTimeline(buildMissionTimeline([
      { id: 'a', title: 'A', status: 'completed', deliverableFiles: [{ downloadUrl: 'https://x' }] },
    ]));
    expect((pub as any).proof).toBeUndefined();
    expect(pub.title).toBe('A');
  });
});

describe('probation summary', () => {
  const now = d('2026-10-20T00:00:00Z');
  it('keeps only active, unexpired, unrevoked warnings and computes the expiry countdown', () => {
    const s = summarizeWarnings([
      { id: 'w1', reason: 'Missed deadline', createdAt: d('2026-10-01T00:00:00Z'), expiresAt: d('2026-10-30T00:00:00Z'), isActive: true },
      { id: 'w2', reason: 'Expired', createdAt: d('2026-01-01T00:00:00Z'), expiresAt: d('2026-02-01T00:00:00Z'), isActive: true },
      { id: 'w3', reason: 'Revoked', createdAt: d('2026-10-01T00:00:00Z'), expiresAt: d('2027-01-01T00:00:00Z'), revokedBy: 'admin' },
      { id: 'w4', reason: 'Permanent', createdAt: d('2026-10-02T00:00:00Z'), isPermanent: true, isActive: true },
    ], { isBlacklisted: false }, now);
    expect(s.activeWarningCount).toBe(2);
    expect(s.warnings.map((w) => w.id)).toEqual(['w1', 'w4']);
    expect(s.nextExpiryAt).toBe('2026-10-30T00:00:00.000Z');
    expect(s.daysUntilNextExpiry).toBe(10);
    expect(s.hasPermanentWarning).toBe(true);
    expect(s.redemptionChecklist.length).toBeGreaterThanOrEqual(3);
  });

  it('is empty and checklist-free for a member in good standing', () => {
    const s = summarizeWarnings([], {}, now);
    expect(s.activeWarningCount).toBe(0);
    expect(s.redemptionChecklist).toEqual([]);
    expect(s.nextExpiryAt).toBeNull();
  });

  it('explains the retired warning system in the checklist at the legacy threshold', () => {
    // Phase 2 discipline rebuild: the blacklist-threshold appeal copy is
    // retired. At the legacy threshold the checklist now explains that
    // warnings are legacy and discipline runs through cases.
    const mk = (i: number) => ({ id: `w${i}`, reason: 'Late', isActive: true, isPermanent: true, createdAt: d('2026-10-01T00:00:00Z') });
    const s = summarizeWarnings([mk(1), mk(2), mk(3)], { isBlacklisted: true }, now, 3);
    expect(s.isBlacklisted).toBe(true);
    expect(s.redemptionChecklist.join(' ')).toMatch(/legacy warnings from the retired warning system/);
    expect(s.redemptionChecklist.join(' ')).not.toMatch(/appeal/);
  });

  it('probation is visible only to the owner or an admin', () => {
    expect(canViewProbation({ requesterUid: 'u1', targetUid: 'u1', isAdmin: false })).toBe(true);
    expect(canViewProbation({ requesterUid: 'u2', targetUid: 'u1', isAdmin: false })).toBe(false);
    expect(canViewProbation({ requesterUid: 'u2', targetUid: 'u1', isAdmin: true })).toBe(true);
    expect(canViewProbation({ requesterUid: null, targetUid: 'u1', isAdmin: false })).toBe(false);
  });
});

describe('public portfolio privacy', () => {
  const user = {
    displayName: 'Bushra Rahman',
    email: 'private@example.com',
    whatsappNumber: '+92-300-0000000',
    whatsapp: '+92-300-0000000',
    phone: '+92-300-0000000',
    warningCount: 2,
    isBlacklisted: true,
    managerId: 'boss',
    bio: 'Builder',
    role: 'member',
    points: 42,
    badges: ['rocket'],
    skillIds: ['cad'],
  };

  it('sanitised profile never carries contact or disciplinary fields', () => {
    const pub = sanitizePublicProfile(user, 'uid-1');
    const json = JSON.stringify(pub);
    expect(json).not.toContain('private@example.com');
    expect(json).not.toContain('300-0000000');
    expect(json).not.toContain('warningCount');
    expect(json).not.toContain('isBlacklisted');
    expect(json).not.toContain('managerId');
    expect(pub.username).toBe('bushra-rahman');
    expect(pub.points).toBe(42);
  });

  it('opt-in: explicit value wins, members default false, executives default true', () => {
    expect(resolvePublicDirectoryOptIn({ role: 'member' })).toBe(false);
    expect(resolvePublicDirectoryOptIn({ role: 'member', publicDirectoryOptIn: true })).toBe(true);
    expect(resolvePublicDirectoryOptIn({ role: 'president_national', publicDirectoryOptIn: false })).toBe(false);
    expect(resolvePublicDirectoryOptIn({ role: 'president_national' })).toBe(true);
    expect(resolvePublicDirectoryOptIn({ displayRole: 'national_vp_operations' })).toBe(true);
    expect(resolvePublicDirectoryOptIn(null)).toBe(false);
  });

  it('username helpers slugify and validate', () => {
    expect(slugifyUsername('  Maira Batool! ')).toBe('maira-batool');
    expect(isValidUsername('maira-batool')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('Bad Name')).toBe(false);
  });
});

describe('certificate vault links', () => {
  it('builds verification URLs against the existing /verify/[code] engine', () => {
    expect(buildCertificateVerificationUrl('SEDS-2026-ABC', 'https://sedspakistan.live/'))
      .toBe('https://sedspakistan.live/verify/SEDS-2026-ABC');
    expect(buildCertificateVerificationUrl('a b')).toBe('/verify/a%20b');
  });

  it('builds LinkedIn share and add-to-profile URLs', () => {
    const url = buildCertificateVerificationUrl('CODE1', 'https://x.test');
    expect(buildLinkedInShareUrl(url, 'Award')).toContain('linkedin.com/sharing/share-offsite');
    const add = buildLinkedInAddToProfileUrl({ title: 'Award', verificationUrl: url, issueDate: d('2026-05-01T00:00:00Z') });
    expect(add).toContain('organizationName=SEDS+Pakistan');
    expect(add).toContain('issueYear=2026');
    expect(add).toContain('issueMonth=5');
  });

  it('sanitises a certificate for the vault and marks revoked certs', () => {
    const c = sanitizeCertificateForVault(
      { id: 'c1', achievement: 'Best Cadet', code: 'CODE1', issueDate: d('2026-05-01T00:00:00Z'), status: 'revoked', userId: 'secret-uid' },
      'https://x.test',
    );
    expect(c.title).toBe('Best Cadet');
    expect(c.status).toBe('revoked');
    expect(c.verificationUrl).toBe('https://x.test/verify/CODE1');
    expect(JSON.stringify(c)).not.toContain('secret-uid');
  });
});
