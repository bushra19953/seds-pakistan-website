/**
 * @jest-environment node
 *
 * UX fix program F6/F1 pins: the house points defaults and the
 * workflow minimum-deadline rule live in ONE shared module, and every
 * consumer (tasks page, task form, POST /api/tasks, POST
 * /api/workflows) reads them from there instead of baking its own
 * literal copy. On the base tree the module does not exist and no
 * consumer imports it, so this suite fails there.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { HOUSE_POINTS_DEFAULTS, WORKFLOW_MIN_DEADLINE_HOURS } from '../task-form-rules';

const root = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('task-form house rules (single source)', () => {
  it('pins the house values', () => {
    expect(HOUSE_POINTS_DEFAULTS).toEqual({ base: 10, penalty: 5, bonus: 10 });
    expect(WORKFLOW_MIN_DEADLINE_HOURS).toBe(24);
  });

  it.each([
    ['src/app/admin/tasks/page.tsx'],
    ['src/components/admin/tasks/task-form.tsx'],
    ['src/app/api/tasks/route.ts'],
    ['src/app/api/workflows/route.ts'],
  ])('%s consumes the shared module', (rel) => {
    expect(read(rel)).toMatch(/from ['"]@\/lib\/task-form-rules['"]/);
  });

  it('the workflows API applies the constant, not a literal, for penalty/bonus fallbacks', () => {
    const src = read('src/app/api/workflows/route.ts');
    expect(src).toContain('HOUSE_POINTS_DEFAULTS.penalty');
    expect(src).toContain('HOUSE_POINTS_DEFAULTS.bonus');
    expect(src).not.toMatch(/penaltyPoints:[^,\n]*: 5,/);
    expect(src).not.toMatch(/workflowBonusPoints:[^,\n]*: 10,/);
  });

  it('the tasks API applies the constant, not a literal, when materialising step defaults', () => {
    const src = read('src/app/api/tasks/route.ts');
    expect(src).toContain('HOUSE_POINTS_DEFAULTS.penalty');
    expect(src).toContain('HOUSE_POINTS_DEFAULTS.bonus');
  });
});
