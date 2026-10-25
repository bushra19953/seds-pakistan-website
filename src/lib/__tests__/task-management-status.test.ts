/**
 * Regression tests for the updateTask() status resurrection defect.
 *
 * The old whitelist in updateTask() force-mapped every non-whitelisted
 * status to 'in-progress' — including the terminal 'approved' spelling
 * and the review state 'changes-requested' — so a write carrying one of
 * those statuses silently reactivated the task. These tests pin the
 * replacement contract of normalizeTaskStatusForWrite().
 */
import { normalizeTaskStatusForWrite } from '@/lib/task-management';

describe('normalizeTaskStatusForWrite', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each([
    'pending',
    'in-progress',
    'submitted-for-review',
    'changes-requested',
    'approved',
    'completed',
  ])('passes the persistable status "%s" through unchanged, without logging', (status) => {
    expect(normalizeTaskStatusForWrite(status, 'task-1')).toBe(status);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes terminal and review statuses through case-insensitively', () => {
    expect(normalizeTaskStatusForWrite('Approved', 'task-1')).toBe('approved');
    expect(normalizeTaskStatusForWrite('CHANGES-REQUESTED', 'task-1')).toBe('changes-requested');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("omits the display-only 'overdue' status so the stored status is left untouched, and logs", () => {
    expect(normalizeTaskStatusForWrite('overdue', 'task-1')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('overdue');
  });

  it("maps a genuinely unknown legacy status to 'in-progress', and logs", () => {
    expect(normalizeTaskStatusForWrite('archived-legacy', 'task-1')).toBe('in-progress');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('archived-legacy');
  });
});
