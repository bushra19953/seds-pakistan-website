/**
 * @jest-environment node
 *
 * MSG22 fix #2: page-handler level regression pins for handleEditTask
 * in src/app/admin/tasks/page.tsx.
 *
 * Root cause (MSG22_ROOT_CAUSE_HUNT2, proven by SA reads): the 3 proof
 * tasks are absent from Firestore and exist only in the Supabase
 * mirror. The list is seam-served so they list; getTask was a bare
 * Firestore getDoc and returned null; handleEditTask had NO else for
 * the null case, never reset editingTask, and its catch left the
 * dialog open, so a failed edit silently rendered as a blank CREATE
 * form (fresh session) or the previous task's stale data.
 *
 * The handler is a closure inside the page component, so these pins
 * follow the repo's page-handler technique (see
 * page-workflow-payload.test.ts): they slice the handleEditTask body
 * out of the source and assert the handler-level contract. The
 * behavioral half (a seam-only doc actually loading) is covered by
 * src/lib/__tests__/task-management-gettask-seam.test.ts and the
 * by-id endpoint suite.
 *
 * Contract under test:
 *  (a) getTask yields null => editingTask was cleared first, an error
 *      toast fires, and the dialog CLOSES. No CREATE form is ever
 *      presented as the task.
 *  (b) a fetch throw => the dialog also closes (the old catch left it
 *      open over the blank form).
 *  (c) the dialog only reaches the EDIT body after a task was
 *      actually loaded.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const pageSrc = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8');

const handlerStart = pageSrc.indexOf('const handleEditTask = useCallback');
const handlerEnd = pageSrc.indexOf('const confirmBulkDelete', handlerStart);
const handler = pageSrc.slice(handlerStart, handlerEnd);

describe('handleEditTask failure contract (MSG22 fix #2)', () => {
  it('handler body was located', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('await getTask(firestore, taskId)');
  });

  it('(a) clears editingTask BEFORE the fetch, so stale data can never render', () => {
    const clearIdx = handler.indexOf('setEditingTask(null)');
    const fetchIdx = handler.indexOf('await getTask(firestore, taskId)');
    expect(clearIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(fetchIdx);
  });

  it('(a) null task: error toast fires and the dialog closes', () => {
    const nullIdx = handler.indexOf('if (!task)');
    const fetchIdx = handler.indexOf('await getTask(firestore, taskId)');
    expect(nullIdx).toBeGreaterThan(fetchIdx);
    const nullBlock = handler.slice(nullIdx, nullIdx + 1200);
    expect(nullBlock).toContain('variant: "destructive"');
    expect(nullBlock).toContain('setIsDialogOpen(false)');
    expect(nullBlock).toContain('return;');
  });

  it('(b) fetch throw: the catch closes the dialog', () => {
    const catchIdx = handler.indexOf("console.error('Error fetching task for edit:'");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = handler.slice(catchIdx, catchIdx + 700);
    expect(catchBlock).toContain('setIsDialogOpen(false)');
  });

  it('(c) the EDIT body only runs after a task was loaded', () => {
    const nullIdx = handler.indexOf('if (!task)');
    const editIdx = handler.indexOf('setEditingTask(normalizedTask as any)');
    expect(editIdx).toBeGreaterThan(nullIdx);
  });
});
