/**
 * WorkflowVisualizer — Supabase migration ('workflows' surface, Group 2)
 * disposition contracts. Census L14 names this component in the mission
 * surface (it is not mounted by the public mission page; it renders a
 * workflow's steps in profile contexts).
 *
 * Dispositions pinned here (see the inventory comment in the component):
 * - `workflow_presence` onSnapshot — STAYS on Firestore: live listener,
 *   and presence is not in the GET /api/missions/[workflowId] payload.
 * - `tasks` by workflowId via useCollection({ listen: realtime }) —
 *   STAYS on Firestore: live listener when realtime is on, and the
 *   missions payload omits rendered fields (`resources`,
 *   `isCurrentStep`) and any task-id/assigneeId join key, so swapping
 *   it in would not be byte-identical.
 * - `messages` by workflowId + participantIds via useCollection —
 *   STAYS on Firestore: live listener when realtime is on; messages
 *   are not in the missions payload at all.
 * - `users/{uid}` getDoc per assignee — FOLLOW-UP, retained in this
 *   wave: it duplicates the missions payload's assignee names in
 *   principle, but the payload has no assigneeId join key and its
 *   missing-user fallback ('SEDS Member') differs from this
 *   component's (the raw uid). Migrating it needs a payload/endpoint
 *   change on the missions route, which is pinned for this group.
 * - No client file in this surface may import the server-only Supa
 *   adapter (@/lib/supa).
 */
import * as fs from 'fs';
import * as path from 'path';

const readSrc = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');

const vizSrc = () => readSrc('components/profile/workflow-visualizer.tsx');

describe('WorkflowVisualizer — stays-on-Firestore listeners are retained', () => {
  it('presence: direct onSnapshot listener on workflow_presence by workflowId', () => {
    const src = vizSrc();
    expect(src).toContain("collection(firestore, 'workflow_presence')");
    expect(src).toContain("where('workflowId', '==', workflowId)");
    expect(src).toMatch(/\bonSnapshot\s*\(/);
  });

  it('tasks: useCollection on tasks by workflowId, ordered, listen follows realtime', () => {
    const src = vizSrc();
    expect(src).toContain("collection(firestore, 'tasks')");
    expect(src).toContain("orderBy('sequenceIndex', 'asc')");
    expect(src).toContain('useCollection(wfQueryAll as any, { listen: realtime })');
  });

  it('messages: useCollection on messages by workflowId + participant, listen follows realtime', () => {
    const src = vizSrc();
    expect(src).toContain("collection(firestore, 'messages')");
    expect(src).toContain("where('participantIds', 'array-contains', user.uid)");
    expect(src).toContain('useCollection(msgsQuery as any, { listen: realtime })');
  });
});

describe('WorkflowVisualizer — follow-up read is retained, not silently migrated', () => {
  it('assignee names still resolve via one-shot users/{uid} getDoc with the uid fallback', () => {
    const src = vizSrc();
    expect(src).toContain("getDoc(doc(firestore, 'users', uid))");
    expect(src).toContain('?.displayName || uid');
  });

  it('the per-read disposition inventory stays documented in the component', () => {
    const src = vizSrc();
    expect(src).toContain('STAYS on Firestore');
    expect(src).toContain('FOLLOW-UP, not migrated in this wave');
  });
});

describe('mission surface client files — server-only adapter is never imported', () => {
  it.each([
    'components/profile/workflow-visualizer.tsx',
    'app/missions/[workflowId]/page.tsx',
    'app/missions/[workflowId]/submit/[stepIndex]/page.tsx',
  ])('%s has no @/lib/supa import', (rel) => {
    expect(readSrc(rel)).not.toContain("from '@/lib/supa'");
  });
});
