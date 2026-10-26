/**
 * @jest-environment node
 *
 * UX fix program F5: the admin tasks page's handleCreateWorkflow must
 * forward the per-step assignment-safety fields the form collects
 * (locationRequirement, locationNote, availabilityStatus) into the
 * POST /api/workflows payload. The API's StepSchema has accepted and
 * persisted all three all along; the page used to drop them, so field
 * work was assigned blind. The handler is a closure inside the page
 * component, so this pins the payload construction textually (the
 * repo's rules-text suites use the same technique); the API side is
 * covered behaviourally by the workflows route suites.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const pageSrc = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8');

describe('handleCreateWorkflow payload forwarding (F5)', () => {
  it.each(['locationRequirement', 'locationNote', 'availabilityStatus'])(
    'forwards step.%s',
    (field) => {
      expect(pageSrc).toContain(`${field}: (s as any).${field}`);
    }
  );
});
