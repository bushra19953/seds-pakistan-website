/**
 * @jest-environment node
 *
 * Warning sunset ladder (Founder decision 2026-11-06): Warning 1
 * lapses after 30 consecutive clean days, Warning 2 after 60,
 * Warning 3 never. Chains: a warning issued while the previous one
 * runs joins its chain and the chain lapses as a whole.
 */
import {
    buildWarningChains,
    currentWarningLevel,
    ladderExpiryMap,
    WARNING_SUNSET_DAYS,
} from '../warning-ladder';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');

function w(id: string, createdMs: number, extra: Record<string, any> = {}) {
    return { id, createdAt: new Date(createdMs).toISOString(), isActive: true, ...extra };
}

describe('warning sunset ladder', () => {
    test('the ladder constants are the founder-approved 30 / 60 / permanent', () => {
        expect(WARNING_SUNSET_DAYS[1]).toBe(30);
        expect(WARNING_SUNSET_DAYS[2]).toBe(60);
    });

    test('a single warning lapses exactly 30 days after issuance', () => {
        const warnings = [w('w1', T0)];
        const map = ladderExpiryMap(warnings);
        expect(map.get('w1')).toBe(T0 + 30 * DAY);
        expect(currentWarningLevel(warnings, T0 + 29 * DAY)).toBe(1);
        expect(currentWarningLevel(warnings, T0 + 30 * DAY)).toBe(0);
        expect(currentWarningLevel(warnings, T0 + 31 * DAY)).toBe(0);
    });

    test('a second warning inside the window joins the chain: both lapse 60 days after the second', () => {
        const warnings = [w('w1', T0), w('w2', T0 + 10 * DAY)];
        const chains = buildWarningChains(warnings);
        expect(chains).toHaveLength(1);
        expect(chains[0].members.map((m) => m.level)).toEqual([1, 2]);
        // Warning 1 does NOT lapse at its own day 30: the new default
        // at day 10 broke its clean run. The chain lapses together.
        const map = ladderExpiryMap(warnings);
        expect(map.get('w1')).toBe(T0 + 10 * DAY + 60 * DAY);
        expect(map.get('w2')).toBe(T0 + 10 * DAY + 60 * DAY);
        expect(currentWarningLevel(warnings, T0 + 30 * DAY)).toBe(2);
        expect(currentWarningLevel(warnings, T0 + 69 * DAY)).toBe(2);
        expect(currentWarningLevel(warnings, T0 + 70 * DAY)).toBe(0);
    });

    test('a third warning in the chain never expires', () => {
        const warnings = [w('w1', T0), w('w2', T0 + 5 * DAY), w('w3', T0 + 20 * DAY)];
        const map = ladderExpiryMap(warnings);
        expect(map.get('w3')).toBe(Number.POSITIVE_INFINITY);
        expect(map.get('w1')).toBe(Number.POSITIVE_INFINITY);
        expect(currentWarningLevel(warnings, T0 + 10 * 365 * DAY)).toBe(3);
    });

    test('a warning issued after the previous chain lapsed starts a new chain at level 1', () => {
        const warnings = [w('w1', T0), w('w2', T0 + 45 * DAY)];
        const chains = buildWarningChains(warnings);
        expect(chains).toHaveLength(2);
        expect(chains[1].members[0].level).toBe(1);
        // At day 50 the first chain is long gone; standing is level 1.
        expect(currentWarningLevel(warnings, T0 + 50 * DAY)).toBe(1);
        expect(currentWarningLevel(warnings, T0 + 76 * DAY)).toBe(0);
    });

    test('an explicitly permanent warning never lapses', () => {
        const warnings = [w('w1', T0, { isPermanent: true })];
        expect(ladderExpiryMap(warnings).get('w1')).toBe(Number.POSITIVE_INFINITY);
        expect(currentWarningLevel(warnings, T0 + 10 * 365 * DAY)).toBe(1);
    });

    test('revoked, archived, and formal case warnings never join a chain', () => {
        const warnings = [
            w('revoked', T0, { status: 'revoked', revokedAt: new Date(T0).toISOString() }),
            w('archived', T0, { isActive: false, status: 'probation_cleared' }),
            w('formal', T0, { kind: 'formal_warning', isPermanent: true, expiresAt: null }),
            w('live', T0 + DAY),
        ];
        const chains = buildWarningChains(warnings);
        expect(chains).toHaveLength(1);
        expect(chains[0].members).toHaveLength(1);
        expect(chains[0].members[0].warning.id).toBe('live');
        expect(currentWarningLevel(warnings, T0 + 2 * DAY)).toBe(1);
    });

    test('warnings without a derivable issuance instant are left to the legacy fallback', () => {
        const warnings = [{ id: 'nodate', isActive: true }];
        expect(buildWarningChains(warnings as any)).toHaveLength(0);
        expect(ladderExpiryMap(warnings as any).has('nodate')).toBe(false);
        expect(currentWarningLevel(warnings as any, T0)).toBe(0);
    });

    test('Firestore-shaped timestamps (seconds) are honored', () => {
        const warnings = [
            { id: 'w1', createdAt: { seconds: Math.floor(T0 / 1000) }, isActive: true },
        ];
        expect(ladderExpiryMap(warnings as any).get('w1')).toBe(T0 + 30 * DAY);
    });
});
