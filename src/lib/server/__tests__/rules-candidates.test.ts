/**
 * Rules candidates guard: the Phase 3 Platform rules text lives ONLY
 * in the candidates file outside the repo (batched Console publish,
 * Zubair-gated). This suite pins the semantics each workstream's spec
 * requires, and pins that the repo's firestore.rules has NOT been
 * edited by this branch.
 */

import * as fs from 'fs';
import * as path from 'path';

const candidates = fs.readFileSync(
  path.join(
    process.cwd(),
    '../bylaws_incorporation/implementation/rules-candidates/p3-platform.rules.txt',
  ),
  'utf8',
);
const liveRules = fs.readFileSync(
  path.join(process.cwd(), 'firestore.rules'),
  'utf8',
);

describe('p3-platform rules candidates', () => {
  it('Part E: window/config matches are admin-read, no client writes', () => {
    expect(candidates).toContain('match /intake_windows/{windowId}');
    expect(candidates).toContain('match /intake_window_templates/{templateId}');
    expect(candidates).toContain('match /intake_config/{docId}');
    expect(candidates).toContain("hasPermission('canManageApplications')");
  });

  it('Part E: enforcement defaults OFF and gates create AND owner-update', () => {
    expect(candidates).toContain("get('enforcementEnabled', false) == true");
    expect(candidates).toContain('function inductionSubmissionAllowed()');
    expect(candidates).toContain('Delta 3: applications create grant');
    expect(candidates).toContain('Delta 4: applications owner-update branch');
    // Fail closed only when enforcement is ON and the mirror is bad:
    expect(candidates).toContain('currentInductionClosesAt is timestamp');
  });

  it('Part G: appointment_instruments is deny-all for clients', () => {
    expect(candidates).toContain('match /appointment_instruments/{instrumentId}');
    expect(candidates).toContain(
      'allow read, list, create, update, delete: if false;',
    );
  });

  it('Part H: licence doc is founder/superadmin read, no client writes, history nested', () => {
    expect(candidates).toContain('match /governance/platform_licence {');
    expect(candidates).toContain('allow read: if isFounder() || isSuperAdmin();');
    expect(candidates).toContain('allow write: if false;');
    expect(candidates).toContain('match /history/{entryId} {');
  });

  it('the live firestore.rules in this repo is untouched by this branch', () => {
    expect(liveRules).not.toContain('appointment_instruments');
    expect(liveRules).not.toContain('intake_windows');
    expect(liveRules).not.toContain('platform_licence');
    expect(liveRules).not.toContain('inductionSubmissionAllowed');
  });
});
