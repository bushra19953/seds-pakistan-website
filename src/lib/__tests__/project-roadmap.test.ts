/**
 * buildProjectRoadmap — the projection behind the project detail
 * page's "Roadmap & Progress" section.
 *
 * Founder acceptance case (2026-10-30): a project whose work is a
 * multi-step workflow (the Grand Prix bilateral: 21 steps, seq 1–21,
 * a different assignee per step) must render as ONE ordered roadmap —
 * every step in sequence order with its assignees and status — plus
 * the project's standalone tasks. The old page rendered four status
 * buckets sliced to 5 titles each, so workflow steps were scattered,
 * truncated, and any status outside the four bucket keys (e.g.
 * 'submitted-for-review') vanished entirely.
 *
 * Fixtures below mirror the verified production shapes: step docs
 * carry workflowId + workflowTitle + sequenceIndex + assigneeId +
 * assigneeIds; standalone tasks carry no workflowId; input order is
 * arbitrary (the Firestore query has no orderBy).
 */
import { buildProjectRoadmap } from '../project-roadmap';

function step(partial: Record<string, any>): Record<string, any> {
  return {
    id: partial.id,
    title: partial.title ?? 'Step',
    status: 'pending',
    ...partial,
  };
}

/** The bilateral-shaped workflow: 21 steps, seq 1..21, seq 3 done. */
function bilateralSteps(): Record<string, any>[] {
  const steps: Record<string, any>[] = [];
  for (let seq = 1; seq <= 21; seq++) {
    steps.push(
      step({
        id: `bilat-${seq}`,
        title: `Bilateral step ${seq}`,
        status: seq === 3 ? 'completed' : 'pending',
        workflowId: 'wf-bilateral',
        workflowTitle: 'Bilateral Workflow',
        sequenceIndex: seq,
        assigneeId: `user-${seq}`,
        assigneeIds: seq === 1 ? ['user-1', 'deputy-a', 'deputy-b'] : [`user-${seq}`],
        createdAt: { seconds: 1_760_000_000 + seq * 60 },
      }),
    );
  }
  return steps;
}

describe('buildProjectRoadmap', () => {
  it('renders a 21-step workflow as ONE group in sequence order', () => {
    // Shuffled input: the page query returns docs in arbitrary order.
    const shuffled = [...bilateralSteps()].reverse();
    const roadmap = buildProjectRoadmap(shuffled);

    expect(roadmap.workflows).toHaveLength(1);
    const wf = roadmap.workflows[0];
    expect(wf.workflowId).toBe('wf-bilateral');
    expect(wf.workflowTitle).toBe('Bilateral Workflow');
    expect(wf.steps).toHaveLength(21);
    expect(wf.steps.map((s) => s.sequenceIndex)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    );
    expect(wf.steps.map((s) => s.id)).toEqual(
      Array.from({ length: 21 }, (_, i) => `bilat-${i + 1}`),
    );
  });

  it('keeps every assignee on a step: primary first, co-assignees after', () => {
    const roadmap = buildProjectRoadmap(bilateralSteps());
    const first = roadmap.workflows[0].steps[0];
    expect(first.assigneeIds).toEqual(['user-1', 'deputy-a', 'deputy-b']);
    const third = roadmap.workflows[0].steps[2];
    expect(third.assigneeIds).toEqual(['user-3']);
    expect(third.status).toBe('completed');
  });

  it('never drops a task for having a non-bucket status (submitted-for-review)', () => {
    const tasks = [
      step({
        id: 'pod-1',
        title: 'Pod step in review',
        status: 'submitted-for-review',
        workflowId: 'wf-pod',
        workflowTitle: 'Pod Workflow',
        sequenceIndex: 0,
        assigneeId: 'user-x',
        assigneeIds: ['user-x'],
      }),
      step({
        id: 'pod-2',
        title: 'Pod step pending',
        status: 'pending',
        workflowId: 'wf-pod',
        workflowTitle: 'Pod Workflow',
        sequenceIndex: 1,
        assigneeId: 'user-y',
        assigneeIds: ['user-y'],
      }),
    ];
    const roadmap = buildProjectRoadmap(tasks);
    const allIds = [
      ...roadmap.workflows.flatMap((w) => w.steps.map((s) => s.id)),
      ...roadmap.standalone.map((s) => s.id),
    ];
    expect(allIds.sort()).toEqual(['pod-1', 'pod-2']);
    expect(roadmap.workflows[0].steps[0].status).toBe('submitted-for-review');
  });

  it('separates standalone tasks from workflow steps and loses nothing', () => {
    const tasks = [
      ...bilateralSteps(),
      step({
        id: 'solo-1',
        title: 'Standalone task',
        status: 'in-progress',
        assigneeId: 'user-solo',
        assigneeIds: ['user-solo'],
      }),
    ];
    const roadmap = buildProjectRoadmap(tasks);
    expect(roadmap.standalone.map((s) => s.id)).toEqual(['solo-1']);
    expect(roadmap.totalTasks).toBe(22);
    const rendered =
      roadmap.workflows.reduce((n, w) => n + w.steps.length, 0) +
      roadmap.standalone.length;
    expect(rendered).toBe(22);
  });

  it('counts work-done with the canonical semantics (completed + submitted-for-review)', () => {
    const tasks = [
      step({ id: 'a', status: 'completed', workflowId: 'w1', sequenceIndex: 0 }),
      step({ id: 'b', status: 'submitted-for-review', workflowId: 'w1', sequenceIndex: 1 }),
      step({ id: 'c', status: 'pending', workflowId: 'w1', sequenceIndex: 2 }),
      step({ id: 'd', status: 'approved', workflowId: 'w1', sequenceIndex: 3 }),
    ];
    const roadmap = buildProjectRoadmap(tasks);
    expect(roadmap.totalTasks).toBe(4);
    expect(roadmap.doneTasks).toBe(3);
    expect(roadmap.workflows[0].totalSteps).toBe(4);
    expect(roadmap.workflows[0].doneSteps).toBe(3);
  });

  it('dedupes an assigneeId repeated inside assigneeIds', () => {
    const tasks = [
      step({
        id: 'a',
        workflowId: 'w1',
        sequenceIndex: 0,
        assigneeId: 'user-1',
        assigneeIds: ['user-1', 'user-1', 'user-2'],
      }),
    ];
    const roadmap = buildProjectRoadmap(tasks);
    expect(roadmap.workflows[0].steps[0].assigneeIds).toEqual(['user-1', 'user-2']);
  });

  it('orders steps without sequenceIndex by creation time, and tolerates empty input', () => {
    const tasks = [
      step({ id: 'later', workflowId: 'w1', createdAt: { seconds: 200 } }),
      step({ id: 'earlier', workflowId: 'w1', createdAt: { seconds: 100 } }),
    ];
    const roadmap = buildProjectRoadmap(tasks);
    expect(roadmap.workflows[0].steps.map((s) => s.id)).toEqual(['earlier', 'later']);
    expect(buildProjectRoadmap([])).toEqual({
      workflows: [],
      standalone: [],
      totalTasks: 0,
      doneTasks: 0,
    });
  });
});
