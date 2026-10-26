/**
 * CONTRACT — assignee typing surfaces must not re-seed form fields from
 * fresh task objects unconditionally (typing-lag fix, 2026-10-26).
 *
 * Proven mechanism (see ~/workspace/known_issues/typing_lag_ahmed_2026-10-26.md):
 * the board card and the task detail dialog re-seeded their report
 * fields from the task object on OBJECT IDENTITY change with no dirty
 * check, so any data refresh (Firestore snapshot, wholesale board
 * refetch after an action, the dialog's own upload-attach write landing
 * on its live doc subscription) silently replaced the report being
 * typed. The card additionally owned the typing state at the top of a
 * component that renders the team strip, the workflow steps, and the
 * full workflow chat, so every keystroke re-rendered all of it.
 *
 * These source contracts pin the fix:
 *  - the card's report form lives in TaskReportForm (typing state is
 *    local to it) and the card no longer carries the clobber effect;
 *  - both the form and the dialog sync through syncedFieldValue
 *    (dirty-wins) from @/lib/form-sync;
 *  - the mission submit page persists its draft via
 *    @/lib/step-submit-draft.
 */

import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const CARD = 'src/components/profile/assigned-tasks.tsx';
const FORM = 'src/components/profile/task-report-form.tsx';
const DIALOG = 'src/components/profile/task-detail-dialog.tsx';
const SUBMIT_PAGE = 'src/app/missions/[workflowId]/submit/[stepIndex]/page.tsx';

describe('typing-lag fix — structural contracts', () => {
  it('the board card renders the extracted TaskReportForm', () => {
    const src = read(CARD);
    expect(src).toContain("from './task-report-form'");
    expect(src).toContain('<TaskReportForm');
  });

  it('the board card no longer re-seeds the report from the task object', () => {
    const src = read(CARD);
    // The identity-keyed clobber: setInlineReport(task.report || '') in
    // an effect on [task]. It must not come back in any form.
    expect(src).not.toContain('setInlineReport(task.report');
    expect(src).not.toContain('inlineReport');
  });

  it('TaskReportForm exists and syncs dirty-wins via form-sync', () => {
    const src = read(FORM);
    expect(src).toContain('syncedFieldValue');
    expect(src).toContain("from '@/lib/form-sync'");
  });

  it('the task detail dialog syncs dirty-wins instead of overwriting the report', () => {
    const src = read(DIALOG);
    // The old unconditional overwrite inside the [displayTask] effect.
    expect(src).not.toContain("setReport(displayTask.report || '')");
    expect(src).toContain('syncedFieldValue');
  });

  it('the mission submit page persists its in-progress draft', () => {
    const src = read(SUBMIT_PAGE);
    expect(src).toContain("from '@/lib/step-submit-draft'");
    expect(src).toContain('saveDraft');
    expect(src).toContain('resolveDraftSeed');
  });
});
