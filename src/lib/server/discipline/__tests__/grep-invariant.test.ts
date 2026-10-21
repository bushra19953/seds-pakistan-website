/**
 * @jest-environment node
 *
 * T-GREP-1 (spec E.4.5 hard invariant): after the Phase 2 rebuild, NO
 * code outside the sanction path writes the disciplinary fields on a
 * user record. Sanctions land only through applyCaseDecision (the
 * decision transaction), the Strike 2 lift, the Founder-review
 * transactions, and the derived-counter reconciliation - this test
 * walks src/** and fails CI if a new writer appears.
 *
 * The scan is textual by design: it is a tripwire, not a proof. The
 * allowlist below is the complete, reviewed set of writers.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(process.cwd(), 'src');

/** Files allowed to write each field family, with the reason. */
const ALLOWLIST: Record<string, Set<string>> = {
    // isBanned = true: exactly ONE writer - the expulsion branch of
    // applyCaseDecision, reached only from a passed Board vote.
    isBannedTrue: new Set(['src/lib/server/discipline/apply-decision.ts']),
    // isBlacklisted in either direction: E never writes it true; the
    // Founder reinstatement writes it false, and only there.
    isBlacklistedWrite: new Set(['src/app/api/admin/founder-review/route.ts']),
    // warningCount writes: the decision transaction (write-through), the
    // derived counter module, and the clear-probation recompute.
    warningCountWrite: new Set([
        'src/lib/server/discipline/apply-decision.ts',
        'src/lib/server/discipline/derived-counter.ts',
        'src/app/api/cron/clear-probation/route.ts',
    ]),
    // Suspension fields: the decision transaction, the lift stanza, and
    // the Founder-review transactions (clearing only).
    suspensionWrite: new Set([
        'src/lib/server/discipline/apply-decision.ts',
        'src/lib/server/discipline/stanzas.ts',
        'src/app/api/admin/founder-review/route.ts',
    ]),
};

/** Known non-writes the textual scan would otherwise flag. */
const NON_WRITE_EXCEPTIONS: Array<{ file: string; pattern: RegExp; why: string }> = [
    {
        file: 'src/lib/server/user-status.ts',
        pattern: /isBanned: true/,
        why: 'returns a status-check result object; writes nothing to Firestore',
    },
];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (entry === '__tests__' || entry === 'node_modules') continue;
            walk(full, out);
        } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

function isTypeLine(line: string): boolean {
    // Interface/type declarations (warningCount: number) are not writes.
    return /:\s*(number|string|boolean|Date|Timestamp)\b/.test(line) && !/[={]/.test(line.split(':')[0] || '');
}

describe('T-GREP-1: sole sanction writers', () => {
    const files = walk(SRC).map((f) => ({ rel: relative(process.cwd(), f), text: readFileSync(f, 'utf8') }));

    test('isBanned = true is written only by the expulsion branch', () => {
        const offenders: string[] = [];
        for (const { rel, text } of files) {
            if (!/isBanned\s*:\s*true/.test(text)) continue;
            if (ALLOWLIST.isBannedTrue.has(rel)) continue;
            if (NON_WRITE_EXCEPTIONS.some((e) => e.file === rel && e.pattern.test(text))) continue;
            offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });

    test('isBlacklisted is written only by Founder reinstatement (to false)', () => {
        const offenders: string[] = [];
        for (const { rel, text } of files) {
            if (/isBlacklisted\s*:\s*true/.test(text)) offenders.push(`${rel} (writes true)`);
            else if (/isBlacklisted\s*:\s*false/.test(text) && !ALLOWLIST.isBlacklistedWrite.has(rel)) {
                offenders.push(`${rel} (writes false outside founder-review)`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('warningCount is written only by the sanction path and the derived counter', () => {
        const offenders: string[] = [];
        for (const { rel, text } of files) {
            if (ALLOWLIST.warningCountWrite.has(rel)) continue;
            const lines = text.split('\n');
            lines.forEach((line, i) => {
                if (!/warningCount\s*:/.test(line)) return;
                if (isTypeLine(line)) return;
                // Reads/projections pass the value through from a data
                // object; writes assign a computed value or increment.
                if (/warningCount\s*:\s*(data|userData|user|summary|entry|row|u|d)\./.test(line)) return;
                if (/warningCount\s*:\s*0\s*[,}]/.test(line)) return; // creation defaults
                offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    test('suspension fields are written only by the sanction path, the lift, and Founder review', () => {
        const offenders: string[] = [];
        for (const { rel, text } of files) {
            if (ALLOWLIST.suspensionWrite.has(rel)) continue;
            if (/privilegesSuspendedUntil\s*:\s*[^,}\n]+/.test(text) && /update|set\(|tx\./.test(text)) {
                // A mere mention (read/compare) is fine; a write needs an
                // update context. Textual heuristic: flag files that both
                // mention the field with a colon value AND perform writes.
                const writesField = text.split('\n').some((line) => /privilegesSuspendedUntil\s*:/.test(line) && !/===|!==|==|!=|>|</.test(line) && !isTypeLine(line) && !/privilegesSuspendedUntil\s*:\s*(data|userData|user)\./.test(line));
                if (writesField) offenders.push(rel);
            }
        }
        expect(offenders).toEqual([]);
    });
});
