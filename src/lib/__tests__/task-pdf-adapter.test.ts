import { taskToWorkflowPDFData, type TaskPDFAssignee } from '../task-pdf-adapter';

const primary: TaskPDFAssignee = {
  id: 'uid-primary',
  name: 'Primary Person',
  email: 'primary@example.com',
  whatsapp: '+923001234567',
  chapterName: 'SEDS IST',
  role: 'President',
  photoBase64: 'base64-photo-data',
};

const co1: TaskPDFAssignee = {
  id: 'uid-co1',
  name: 'Co Assignee One',
  email: 'co1@example.com',
  whatsapp: '+923007654321',
  chapterName: 'SEDS IST',
  role: 'VP',
};

const co2: TaskPDFAssignee = {
  id: 'uid-co2',
  name: 'Co Assignee Two',
  email: 'co2@example.com',
  whatsapp: '+923009998877',
  chapterName: null as unknown as undefined,
  role: 'Member',
};

const fullTask: Record<string, any> = {
  id: 'task-123',
  title: 'Mount induction posters',
  description: 'Mount the induction posters across all departments.',
  assigneeId: 'uid-primary',
  assigneeIds: ['uid-primary', 'uid-co1', 'uid-co2'],
  role: 'Marketing Chair',
  status: 'completed',
  deadline: '2026-10-21T18:59:59.000Z',
  individualDeadline: '2026-10-20T18:59:59.000Z',
  points: 50,
  penaltyPoints: 10,
  workflowBonusPoints: 5,
  workflowPriority: 'high',
  workflowTags: ['Marketing', 'Outreach'],
  resources: [{ title: 'Poster Drive', url: 'https://drive.example.com/posters', type: 'drive' }],
  resourceLinks: 'https://example.com/pack1\nhttps://example.com/pack2\n\n  ',
  guidance: 'Get prints from Room 131.',
  stepInstructions: '1. Collect posters. 2. Mount them.',
  chapterId: 'seds-ist-chapter',
  createdAt: '2026-10-19T09:00:00.000Z',
};

describe('taskToWorkflowPDFData', () => {
  test('full task with all fields, primary plus two co-assignees', () => {
    const data = taskToWorkflowPDFData({
      task: fullTask,
      assignees: [primary, co1, co2],
      chapterName: 'SEDS IST',
    });

    expect(data.id).toBe('task-123');
    expect(data.title).toBe('Mount induction posters');
    expect(data.progressPercentage).toBe(100);
    expect(data.totalSteps).toBe(1);
    expect(data.completedSteps).toBe(1);
    expect(data.isCompleted).toBe(true);
    expect(data.chapterName).toBe('SEDS IST');
    expect(data.createdAt).toBe('2026-10-19T09:00:00.000Z');
    expect(data.description).toBe('Mount the induction posters across all departments.');
    expect(data.participants).toEqual(['Primary Person', 'Co Assignee One', 'Co Assignee Two']);
    expect(data.steps).toHaveLength(1);

    const step = data.steps[0];
    expect(step.id).toBe('task-123');
    expect(step.title).toBe('Mount induction posters');
    expect(step.description).toBe('Mount the induction posters across all departments.');
    expect(step.role).toBe('Marketing Chair');
    expect(step.assigneeRole).toBe('President');
    expect(step.assigneeName).toBe('Primary Person');
    expect(step.assigneeEmail).toBe('primary@example.com');
    expect(step.assigneeWhatsapp).toBe('+923001234567');
    expect(step.assigneeChapter).toBe('SEDS IST');
    expect(step.assigneePhoto).toBe('base64-photo-data');
    expect(step.status).toBe('completed');
    expect(step.individualDeadline).toBe('2026-10-20T18:59:59.000Z');
    expect(step.sequenceIndex).toBe(0);
    expect(step.assigneeId).toBe('uid-primary');
    expect(step.points).toBe(50);
    expect(step.penaltyPoints).toBe(10);
    expect(step.workflowBonusPoints).toBe(5);
    expect(step.guidance).toBe('Get prints from Room 131.');
    expect(step.stepInstructions).toBe('1. Collect posters. 2. Mount them.');
    expect(step.complexity).toBe(4);
    expect(step.domain).toBe('Marketing');
    expect(step.resources).toEqual([
      { title: 'Poster Drive', url: 'https://drive.example.com/posters', type: 'drive' },
      { type: 'link', url: 'https://example.com/pack1', title: 'https://example.com/pack1' },
      { type: 'link', url: 'https://example.com/pack2', title: 'https://example.com/pack2' },
    ]);
  });

  test('task with missing optional fields omits them as undefined', () => {
    const data = taskToWorkflowPDFData({
      task: { id: 'task-min', title: 'Bare task', status: 'pending' },
      assignees: [],
    });

    expect(data.progressPercentage).toBe(0);
    expect(data.completedSteps).toBe(0);
    expect(data.isCompleted).toBe(false);
    expect(data.chapterName).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
    expect(data.description).toBeUndefined();
    expect(data.participants).toEqual([]);

    const step = data.steps[0];
    expect(step.assigneeName).toBeUndefined();
    expect(step.assigneeEmail).toBeUndefined();
    expect(step.assigneeWhatsapp).toBeUndefined();
    expect(step.assigneeChapter).toBeUndefined();
    expect(step.assigneePhoto).toBeUndefined();
    expect(step.assigneeRole).toBeUndefined();
    expect(step.assignees).toEqual([]);
    expect(step.individualDeadline).toBeUndefined();
    expect(step.points).toBeUndefined();
    expect(step.penaltyPoints).toBeUndefined();
    expect(step.workflowBonusPoints).toBeUndefined();
    expect(step.guidance).toBeUndefined();
    expect(step.stepInstructions).toBeUndefined();
    expect(step.complexity).toBeUndefined();
    expect(step.domain).toBeUndefined();
    expect(step.resources).toBeUndefined();
    expect(step.assigneeId).toBeUndefined();
  });

  test('deadline fallback: individualDeadline wins, otherwise task.deadline', () => {
    const withIndividual = taskToWorkflowPDFData({
      task: { id: 't1', title: 'A', individualDeadline: '2026-10-20T00:00:00.000Z', deadline: '2026-10-25T00:00:00.000Z' },
      assignees: [],
    });
    expect(withIndividual.steps[0].individualDeadline).toBe('2026-10-20T00:00:00.000Z');

    const withDeadlineOnly = taskToWorkflowPDFData({
      task: { id: 't2', title: 'B', deadline: '2026-10-25T00:00:00.000Z' },
      assignees: [],
    });
    expect(withDeadlineOnly.steps[0].individualDeadline).toBe('2026-10-25T00:00:00.000Z');

    const withNeither = taskToWorkflowPDFData({
      task: { id: 't3', title: 'C' },
      assignees: [],
    });
    expect(withNeither.steps[0].individualDeadline).toBeUndefined();
  });

  test('multiple assignees mapped into step.assignees with primary first', () => {
    const data = taskToWorkflowPDFData({
      task: { id: 't-multi', title: 'Multi' },
      assignees: [co2, primary, co1],
    });

    const step = data.steps[0];
    expect(step.assignees).toHaveLength(3);
    expect(step.assignees![0].id).toBe('uid-co2');
    expect(step.assignees![0].name).toBe('Co Assignee Two');
    expect(step.assignees![1].name).toBe('Primary Person');
    expect(step.assignees![2].name).toBe('Co Assignee One');
    expect(step.assignees![1].role).toBe('President');
    expect(step.assignees![1].chapterName).toBe('SEDS IST');
    // null chapterName on the input must not leak through as null
    expect(step.assignees![0].chapterName).toBeUndefined();
  });

  test('status mapping: completed and approved mean done, others mean not done', () => {
    for (const status of ['completed', 'approved', 'Completed', 'APPROVED']) {
      const data = taskToWorkflowPDFData({ task: { id: 't', title: 'S', status }, assignees: [] });
      expect(data.progressPercentage).toBe(100);
      expect(data.completedSteps).toBe(1);
      expect(data.isCompleted).toBe(true);
    }
    for (const status of ['pending', 'in_progress', 'review', 'rejected', undefined]) {
      const data = taskToWorkflowPDFData({ task: { id: 't', title: 'S', status }, assignees: [] });
      expect(data.progressPercentage).toBe(0);
      expect(data.completedSteps).toBe(0);
      expect(data.isCompleted).toBe(false);
    }
  });

  test('resourceLinks string merged into resources', () => {
    const data = taskToWorkflowPDFData({
      task: {
        id: 't-res',
        title: 'Links',
        resourceLinks: '  https://a.example.com  \n\nhttps://b.example.com/page?x=1\n   ',
      },
      assignees: [],
    });
    expect(data.steps[0].resources).toEqual([
      { type: 'link', url: 'https://a.example.com', title: 'https://a.example.com' },
      { type: 'link', url: 'https://b.example.com/page?x=1', title: 'https://b.example.com/page?x=1' },
    ]);

    const both = taskToWorkflowPDFData({
      task: {
        id: 't-both',
        title: 'Both',
        resources: [{ title: 'Drive folder', url: 'https://drive.example.com/f', type: 'drive' }],
        resourceLinks: 'https://c.example.com',
      },
      assignees: [],
    });
    expect(both.steps[0].resources).toHaveLength(2);
    expect(both.steps[0].resources![0].url).toBe('https://drive.example.com/f');
    expect(both.steps[0].resources![1].url).toBe('https://c.example.com');
  });

  test('complexity mapping mirrors the workflows page', () => {
    const cases: Array<[unknown, unknown]> = [
      ['critical', 5],
      ['high', 4],
      ['medium', 3],
      ['low', 2],
      ['anything-else', 2],
      [undefined, undefined],
      [null, undefined],
    ];
    for (const [priority, expected] of cases) {
      const data = taskToWorkflowPDFData({
        task: { id: 't', title: 'P', workflowPriority: priority },
        assignees: [],
      });
      expect(data.steps[0].complexity).toBe(expected);
    }
  });

  test('assigneeChapter falls back to the input chapterName', () => {
    const noChapterOnAssignee = taskToWorkflowPDFData({
      task: { id: 't', title: 'Ch' },
      assignees: [{ id: 'u1', name: 'No Chapter' }],
      chapterName: 'SEDS Lahore',
    });
    expect(noChapterOnAssignee.steps[0].assigneeChapter).toBe('SEDS Lahore');

    const chapterOnAssignee = taskToWorkflowPDFData({
      task: { id: 't', title: 'Ch' },
      assignees: [{ id: 'u1', name: 'Has Chapter', chapterName: 'SEDS Karachi' }],
      chapterName: 'SEDS Lahore',
    });
    expect(chapterOnAssignee.steps[0].assigneeChapter).toBe('SEDS Karachi');
  });
});
