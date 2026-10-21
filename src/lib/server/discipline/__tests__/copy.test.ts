/**
 * @jest-environment node
 *
 * T43 (spec E.11): the verbatim Founder-review copy ships in the banned
 * page, the probation card, the case outcome notification, and the
 * admin case view - and the word "appeal" survives only inside that
 * sentence ("no appeal to an administrator") on member-facing surfaces.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const COPY =
    'Founder review: the Founder may review any disciplinary decision and may uphold it, reduce the sanction, revoke the sanction, or reinstate the member. There is no appeal to an administrator.';

function read(rel: string): string {
    return readFileSync(join(process.cwd(), rel), 'utf8');
}

describe('founder-review copy (T43)', () => {
    test('verbatim copy present in all four surfaces', () => {
        expect(read('src/app/banned/page.tsx')).toContain(COPY);
        expect(read('src/components/profile/profile-hub/probation-card.tsx')).toContain(COPY);
        expect(read('src/lib/server/discipline/apply-decision.ts')).toContain(COPY);
        expect(read('src/app/admin/discipline/[caseId]/page.tsx')).toContain(COPY);
        expect(read('src/app/profile/discipline/[caseId]/page.tsx')).toContain(COPY);
    });

    test('banned page carries no appeal-submitted state', () => {
        const banned = read('src/app/banned/page.tsx');
        expect(banned.toLowerCase()).not.toContain('appeal submitted');
        expect(banned.toLowerCase()).not.toContain('successfully appealed');
    });
});
