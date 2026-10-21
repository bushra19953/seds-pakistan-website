/**
 * @jest-environment node
 *
 * GET /api/public/warning-registry was RETIRED by the Phase 2 discipline
 * rebuild (spec E.7, Z-10): the public registry is abolished under both
 * variants. T37 pins the retirement contract: the API answers 410 Gone
 * and the /warning-registry page is a permanent redirect to /.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { GET } from '../route';

describe('warning registry retirement (T37)', () => {
  test('T37a API answers 410 Gone', async () => {
    const res = await GET();
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe('Gone');
  });

  test('T37b the page is a permanent redirect to / (source level)', () => {
    const pagePath = join(process.cwd(), 'src/app/warning-registry/page.tsx');
    const source = readFileSync(pagePath, 'utf8');
    expect(source).toContain('permanentRedirect');
    expect(source).toContain("permanentRedirect('/')");
    // The old public list UI is gone.
    expect(source).not.toContain('useFirestore');
  });

  test('T37c no nav or footer link to /warning-registry remains', () => {
    for (const rel of ['src/components/layout/header.tsx', 'src/components/layout/footer.tsx']) {
      const source = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(source).not.toContain('/warning-registry');
    }
  });
});
