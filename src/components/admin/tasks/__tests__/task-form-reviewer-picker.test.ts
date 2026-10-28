/**
 * @jest-environment node
 *
 * Reviewer picker contract (named-reviewer fix): the task form's
 * reviewer combobox must let the founder pick ANY user. The old
 * spec 6.1 gate passed filterFn={isReviewerEligible} (canReviewTasks
 * over 13 executive role tokens) into the combobox, which applied it
 * BEFORE search matching, so a designated reviewer outside the token
 * list (e.g. a platform developer) could never be picked. The handler
 * closure lives inside the page component, so, like the repo's other
 * rules-text suites, these pins are textual; the combobox's own
 * search behaviour (name + email + role) is covered by its suites.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const formSrc = readFileSync(join(__dirname, '..', 'task-form.tsx'), 'utf8');
const pageSrc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'app', 'admin', 'tasks', 'page.tsx'),
  'utf8'
);

describe('reviewer picker has no eligibility pre-filter', () => {
  it('task-form defines no isReviewerEligible gate', () => {
    expect(formSrc).not.toContain('isReviewerEligible');
  });

  it('the reviewer combobox receives no filterFn', () => {
    const reviewerBlock = formSrc.slice(formSrc.indexOf('Reviewer (optional)'));
    const comboboxEnd = reviewerBlock.indexOf('/>');
    const combobox = reviewerBlock.slice(0, comboboxEnd);
    expect(combobox).toContain('UserSelectionCombobox');
    expect(combobox).not.toContain('filterFn');
    expect(combobox).not.toContain('showAllToggle={false}');
  });
});

describe('handleCreateWorkflow forwards the named reviewer', () => {
  it('page payload carries reviewerId from the form values', () => {
    expect(pageSrc).toContain('reviewerId: values.reviewerId || undefined');
  });
});
