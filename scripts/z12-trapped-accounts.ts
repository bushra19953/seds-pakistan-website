/**
 * z12-trapped-accounts.ts - the Z-12 trapped-accounts report GENERATOR
 * (spec E.9 step 3).
 *
 * Lists the accounts the retired machinery may have left in states the
 * Constitution does not authorise, so a human can decide each one
 * under Decision 14. This tool is READ-ONLY by construction: it has no
 * write path at all, and NO automatic repair ships with it.
 *
 * It must never run against production from this build: the CLI
 * hard-refuses unless Z12_SOURCE is 'fixture' (a JSON export file) or
 * 'emulator'. The analysis itself is a pure function over an injected
 * snapshot so it is unit-testable against fixtures.
 *
 * Finding classes:
 *   (a) banned_without_board_vote - isBanned is true but bannedBy is
 *       not a 'board:<voteId>' reference from the case system.
 *   (b) blacklisted_via_setting_path - isBlacklisted is true; the path
 *       is classified from the recorded reason text (cron threshold vs
 *       issue-warning threshold vs unknown/manual).
 *   (c) warning_count_drift - stored warningCount differs from the
 *       number of warning documents on the member.
 *   (d) probation_demotion_suspect - HEURISTIC for human review: the
 *       member is flagged on probation with zero active warnings (the
 *       signature of the retired clear-probation role recompute).
 *   (e) public_mirror_mismatch - a public mirror doc (when the data
 *       source provides one) disagrees with the user doc on the
 *       disciplinary fields.
 */

export interface Z12Snapshot {
    users: Array<Record<string, any> & { uid: string }>;
    warningsByUid: Record<string, Array<Record<string, any>>>;
    publicMirrorByUid?: Record<string, Record<string, any>>;
}

export interface Z12Finding {
    uid: string;
    classes: string[];
    details: Record<string, unknown>;
}

export interface Z12Report {
    generatedAt: string;
    source: string;
    totals: { usersScanned: number; findings: number; byClass: Record<string, number> };
    findings: Z12Finding[];
}

function classifyBlacklistPath(user: Record<string, any>): string {
    const text = `${user.blacklistReason || ''} ${user.banReason || ''}`;
    if (/auto-blacklisted|exceeded \d+ warnings/i.test(text)) return 'cron_threshold';
    if (/reached \d+ active warnings|reached \d+ warnings/i.test(text)) return 'issue_warning_threshold';
    if (/manually/i.test(text)) return 'manual_admin_write';
    return 'unknown';
}

export function analyzeTrappedAccounts(snapshot: Z12Snapshot, source: string, now: Date): Z12Report {
    const findings: Z12Finding[] = [];
    const byClass: Record<string, number> = {};
    const bump = (cls: string) => {
        byClass[cls] = (byClass[cls] || 0) + 1;
    };

    for (const user of snapshot.users) {
        const classes: string[] = [];
        const details: Record<string, unknown> = {};

        // (a) banned without a Board vote
        if (user.isBanned === true) {
            const byBoard = typeof user.bannedBy === 'string' && user.bannedBy.startsWith('board:');
            if (!byBoard) {
                classes.push('banned_without_board_vote');
                details.bannedBy = user.bannedBy ?? null;
                details.banReason = user.banReason ?? null;
            }
        }

        // (b) blacklisted via a settings-threshold path
        if (user.isBlacklisted === true) {
            classes.push('blacklisted_via_setting_path');
            details.blacklistPath = classifyBlacklistPath(user);
            details.blacklistReason = user.blacklistReason ?? null;
        }

        // (c) warningCount drift vs the warning documents
        const warnings = snapshot.warningsByUid[user.uid] || [];
        const stored = typeof user.warningCount === 'number' ? user.warningCount : 0;
        if (stored !== warnings.length) {
            classes.push('warning_count_drift');
            details.storedWarningCount = stored;
            details.warningDocuments = warnings.length;
        }

        // (d) probation demotion suspect (heuristic)
        const activeWarnings = warnings.filter((w) => w.isActive === true).length;
        if (user.isOnProbation === true && activeWarnings === 0) {
            classes.push('probation_demotion_suspect');
            details.activeWarnings = 0;
            details.role = user.role ?? null;
        }

        // (e) public mirror mismatch
        const mirror = snapshot.publicMirrorByUid?.[user.uid];
        if (mirror) {
            const fields = ['warningCount', 'isBlacklisted', 'isBanned', 'isOnProbation'];
            const mismatched = fields.filter((f) => (mirror[f] ?? null) !== (user[f] ?? null));
            if (mismatched.length > 0) {
                classes.push('public_mirror_mismatch');
                details.mismatchedFields = mismatched;
            }
        }

        if (classes.length > 0) {
            classes.forEach(bump);
            findings.push({ uid: user.uid, classes, details });
        }
    }

    findings.sort((a, b) => a.uid.localeCompare(b.uid));
    return {
        generatedAt: now.toISOString(),
        source,
        totals: { usersScanned: snapshot.users.length, findings: findings.length, byClass },
        findings,
    };
}

/* ------------------------------------------------------------------ */
/* CLI: fixture-only. There is deliberately no production code path.  */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
    const source = process.env.Z12_SOURCE || '';
    if (source !== 'fixture' && source !== 'emulator') {
        console.error(
            'REFUSED: Z12_SOURCE must be "fixture" or "emulator". This generator never runs against production.',
        );
        process.exit(2);
    }
    if (source === 'emulator') {
        console.error('REFUSED: the emulator source is not wired in this build; export a fixture JSON instead.');
        process.exit(2);
    }
    const fixturePath = process.argv[2];
    if (!fixturePath) {
        console.error('Usage: Z12_SOURCE=fixture ts-node scripts/z12-trapped-accounts.ts <fixture.json>');
        process.exit(2);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const snapshot = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Z12Snapshot;
    const report = analyzeTrappedAccounts(snapshot, source, new Date());
    console.log(JSON.stringify(report, null, 2));
}

if (typeof require !== 'undefined' && require.main === module) {
    void main();
}
