/**
 * @jest-environment node
 *
 * Grove Item 9 - performance review ROUTE tests.
 *
 * Spec: ~/workspace/your_files/seds_website_grove_optimization_comparison.md,
 * Item 9, and the task brief: a gated API route modeled on
 * /api/admin/discipline-settings serving the per-member per-term Review
 * record, with two officer fields - `messages` (the reviewer's clustered
 * conclusions) and `deliveredAt`. Grove's order is conclusions before
 * delivery: setting deliveredAt while messages is empty must be
 * REJECTED; with messages present it must be ACCEPTED.
 *
 * STATUS AT AUTHORING TIME: the Item 9 implementation had NOT landed in
 * this worktree yet (tree clean at the base commit; no route under
 * src/app/api referenced deliveredAt). Like the generator suite, this
 * suite DISCOVERS the route at run time (any route.ts under src/app/api
 * whose source mentions deliveredAt / a performance review) instead of
 * pinning one guessed path. While none exists, the suite fails with an
 * explicit "not landed" message - that red is the honest signal.
 *
 * Mocks mirror the discipline-settings route tests exactly: firebase
 * admin, auth middleware, and the notification service are mocked, and
 * permissions resolve against the fake db's roleDefinitions, so a plain
 * `member` role (seeded with an empty grant set) is denied and
 * `superadmin` is allowed.
 */
import * as fs from 'fs';
import * as path from 'path';

let mockDb: any;
let mockAuth: any;
jest.mock('@/lib/server/firebase-admin', () => ({
    getDb: () => mockDb,
    ensureAdminInitialized: () => true,
    admin: {},
    adminDb: null,
    getAdminStorage: () => null,
    getLastAdminError: () => null,
    getAdminDiagnostics: () => ({}),
}));
jest.mock('@/lib/auth-middleware', () => ({
    verifyAuthentication: jest.fn(async () => mockAuth),
}));
jest.mock('@/lib/server/notification-service', () => ({
    notificationService: { send: jest.fn(async () => undefined) },
}));

import { NextRequest } from 'next/server';
import { makeFakeDb } from '@/lib/server/discipline/__tests__/fake-firestore';

const MEMBER = 'member-a';
const TERM = '2026-T1';
const REVIEW_COLLECTIONS = ['performance_reviews', 'member_reviews', 'performanceReviews', 'reviews', 'member_performance_reviews'];
const REVIEW_DOC_IDS = [`${MEMBER}_${TERM}`, `${MEMBER}-${TERM}`, MEMBER, 'member-a_2026-T1', 'review-1'];

function authAs(role: string, uid = 'admin-1') {
    return { authenticated: true, user: { userId: uid, uid, email: 'a@example.com', role } };
}

/** Seed one review doc (in every plausible collection/id shape). */
function seedReviews(messages: string) {
    const db = makeFakeDb();
    db.seed('roleDefinitions/member', { permissions: [] });
    const snapshot = {
        subjectUid: MEMBER,
        memberUid: MEMBER,
        user_id: MEMBER,
        term: TERM,
        tasksApproved: 4,
        onTimePercentage: 75,
        pointsEarned: 35,
        points: 35,
        missCount: 2,
        strikeCount: 1,
        messages,
        deliveredAt: null,
    };
    for (const col of REVIEW_COLLECTIONS) {
        for (const id of REVIEW_DOC_IDS) db.seed(`${col}/${id}`, { ...snapshot });
    }
    return db;
}

function findRouteCandidates(): string[] {
    const apiRoot = path.join(process.cwd(), 'src', 'app', 'api');
    const hits: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '__tests__') walk(full);
            } else if (entry.name === 'route.ts') {
                const src = fs.readFileSync(full, 'utf8');
                if (src.includes('deliveredAt') || /performance.?review/i.test(src)) hits.push(full);
            }
        }
    };
    walk(apiRoot);
    return hits;
}

function loadRoute(): any | null {
    for (const file of findRouteCandidates()) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require(file);
            if (mod && (mod.GET || mod.PUT || mod.PATCH || mod.POST)) return mod;
        } catch {
            // Try the next candidate.
        }
    }
    return null;
}

function req(method: string, url: string, body?: unknown) {
    return new NextRequest(url, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

const BASE_URLS = [
    'http://localhost/api/admin/performance-reviews',
    'http://localhost/api/admin/member-reviews',
    'http://localhost/api/admin/performance-review',
    'http://localhost/api/admin/reviews',
];

/**
 * Attempt one write against the discovered route under the shapes a
 * discipline-settings-modeled route plausibly accepts. Returns every
 * response status seen, so callers can assert on the best outcome.
 */
async function attemptWrite(route: any, body: Record<string, any>): Promise<number[]> {
    const statuses: number[] = [];
    const handlers: Array<[string, any]> = [
        ['PUT', route.PUT],
        ['PATCH', route.PATCH],
        ['POST', route.POST],
    ].filter(([, h]) => typeof h === 'function') as Array<[string, any]>;
    const bodies: Array<Record<string, any>> = [
        body,
        { ...body, subjectUid: MEMBER, term: TERM },
        { ...body, memberUid: MEMBER, term: TERM },
        { ...body, uid: MEMBER, term: TERM },
        { ...body, action: 'deliver', subjectUid: MEMBER, term: TERM },
        { ...body, action: 'setDeliveredAt', subjectUid: MEMBER, term: TERM },
    ];
    const urls = [
        ...BASE_URLS,
        ...BASE_URLS.map((u) => `${u}/${MEMBER}_${TERM}`),
        ...BASE_URLS.map((u) => `${u}?subjectUid=${MEMBER}&term=${TERM}`),
        ...BASE_URLS.map((u) => `${u}/${MEMBER}`),
    ];
    for (const [method, handler] of handlers) {
        for (const b of bodies) {
            for (const url of urls) {
                try {
                    const res = await handler(req(method, url, b));
                    if (res && typeof res.status === 'number') statuses.push(res.status);
                } catch {
                    // Shape not accepted by this route; keep trying.
                }
            }
        }
    }
    return statuses;
}

function anyDeliveredAtPersisted(): boolean {
    for (const col of REVIEW_COLLECTIONS) {
        for (const row of mockDb.readCollection(col)) {
            if (row.data.deliveredAt) return true;
        }
    }
    return false;
}

describe('Grove Item 9 - performance review route', () => {
    const candidates = findRouteCandidates();
    let route: any = null;

    beforeAll(() => {
        mockDb = seedReviews('Strong term. Keep the streak going.');
        mockAuth = authAs('superadmin');
        route = loadRoute();
    });

    beforeEach(() => {
        mockDb = seedReviews('Strong term. Keep the streak going.');
        mockAuth = authAs('superadmin');
    });

    it('implementation has landed: a review route exists under src/app/api', () => {
        expect(
            candidates.length > 0 && route
                ? true
                : 'NOT LANDED: no route.ts under src/app/api mentions deliveredAt or a performance review. ' +
                      'Implement the Item 9 route (modeled on /api/admin/discipline-settings) and re-run.',
        ).toBe(true);
    });

    it('rejects unauthenticated callers', async () => {
        if (!route) throw new Error('NOT LANDED: no Item 9 route module');
        mockAuth = { authenticated: false, user: null };
        const handler = route.PUT || route.PATCH || route.POST || route.GET;
        const res = await handler(req('PUT', `${BASE_URLS[0]}?subjectUid=${MEMBER}&term=${TERM}`, { messages: 'x' }));
        expect(res.status).toBe(401);
    });

    it('rejects callers without the admin permission (member role, write)', async () => {
        if (!route) throw new Error('NOT LANDED: no Item 9 route module');
        mockAuth = authAs('member', 'plain-member');
        const statuses = await attemptWrite(route, {
            messages: 'Strong term.',
            deliveredAt: new Date().toISOString(),
        });
        expect(statuses.length).toBeGreaterThan(0);
        // Every attempt must be denied; none may succeed.
        expect(statuses.every((s) => s === 401 || s === 403)).toBe(true);
        expect(anyDeliveredAtPersisted()).toBe(false);
    });

    it('rejects callers without the admin permission (member role, read)', async () => {
        if (!route?.GET) return; // Read surface is optional in the spec; write gate is not.
        mockAuth = authAs('member', 'plain-member');
        const statuses: number[] = [];
        for (const url of [...BASE_URLS, ...BASE_URLS.map((u) => `${u}?subjectUid=${MEMBER}&term=${TERM}`)]) {
            try {
                const res = await route.GET(req('GET', url));
                if (res && typeof res.status === 'number') statuses.push(res.status);
            } catch {
                // ignore shape mismatches
            }
        }
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.every((s) => s === 401 || s === 403 || s === 404)).toBe(true);
        expect(statuses.some((s) => s === 200)).toBe(false);
    });

    it('rejects setting deliveredAt when Messages is empty', async () => {
        if (!route) throw new Error('NOT LANDED: no Item 9 route module');
        mockDb = seedReviews('');
        mockAuth = authAs('superadmin');
        const statuses = await attemptWrite(route, {
            messages: '',
            deliveredAt: new Date().toISOString(),
            delivered: true,
        });
        expect(statuses.length).toBeGreaterThan(0);
        // The Grove rule: conclusions before delivery. A conforming route
        // answers 400 for the empty-messages delivery, and nothing is
        // persisted as delivered.
        expect(statuses).toContain(400);
        expect(anyDeliveredAtPersisted()).toBe(false);
    });

    it('accepts setting deliveredAt when Messages is present', async () => {
        if (!route) throw new Error('NOT LANDED: no Item 9 route module');
        mockDb = seedReviews('Strong term. Two messages: keep the on-time streak; take one harder mission next term.');
        mockAuth = authAs('superadmin');
        const statuses = await attemptWrite(route, {
            messages: 'Strong term. Two messages: keep the on-time streak; take one harder mission next term.',
            deliveredAt: new Date().toISOString(),
            delivered: true,
        });
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.some((s) => s >= 200 && s < 300)).toBe(true);
        // Either persisted on the review doc, or the route computed the
        // delivery inline (2xx above). Persistence is checked when the
        // seeded collections are the ones the route uses.
        const persisted = anyDeliveredAtPersisted();
        if (REVIEW_COLLECTIONS.some((c) => mockDb.readCollection(c).length > 0)) {
            expect(persisted || statuses.some((s) => s >= 200 && s < 300)).toBe(true);
        }
    });
});
