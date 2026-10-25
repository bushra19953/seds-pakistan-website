/**
 * @jest-environment node
 *
 * Supabase migration, ROLES cluster G4: custom-role expiry sweep
 * parity. The SAME expired-grant fixture is processed identically
 * flag OFF (FakeFirestore) and flag ON (REAL-SHAPED fake Supabase
 * adapter returning flattened docs; Firestore behind it holds only
 * the grant doc the assignRole-adjacent paths need - assignRole
 * itself is mocked and recorded). The flag-ON fixture carries
 * expiresAt as an ISO string (the Supabase storage shape) where the
 * flag-OFF fixture carries a Firestore Timestamp; the sweep's outcome
 * (summary, assignRole input, governance audit details, mirror
 * behaviour) must be identical. Mocks/fakes only, zero live reads.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { FakeFirestore } from '../../__tests__/helpers/fake-firestore';

const mockNotifications: Array<{ userId: string; payload: any; priority: string }> = [];
const mockAuditEntries: Array<Record<string, unknown>> = [];
const mockAssignCalls: Array<Record<string, unknown>> = [];
const mockMirrorUpdates: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [];

jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: jest.fn(async (userId: string, payload: any, priority: string) => {
      mockNotifications.push({ userId, payload, priority });
    }),
  },
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: jest.fn(async (_db: unknown, entry: Record<string, unknown>) => {
    mockAuditEntries.push(entry);
    return 'audit-id';
  }),
}));

jest.mock('../role-writes', () => ({
  assignRole: jest.fn(async (_db: unknown, input: Record<string, unknown>) => {
    mockAssignCalls.push(input);
  }),
  setMirror: jest.fn(async () => undefined),
}));

import { runCustomRoleExpirySweep } from '../custom-role-expiry-sweep';
import {
  __setSupaAdapterForTests,
  type SupaRolesAdapter,
} from '../supa-roles-reconcile-seam';

const CHAPTER = 'seds-ist-chapter';
const CUSTOM = 'custom_poster_team_lead';
const CUSTOM_OLD = 'custom_old_team';
const UID = 'u-exp-parity';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const EXPIRED_ISO = '2026-10-20T00:00:00.000Z';

type DocMap = Record<string, Record<string, Record<string, unknown>>>;

function grantData(expiresAt: unknown): Record<string, unknown> {
  return {
    role: 'chapter_secretary',
    additionalRoles: [CUSTOM_OLD, CUSTOM],
    chapterId: CHAPTER,
    grantedBy: 'admin-actor-uid',
    lastChangedBy: 'admin-actor-uid',
    source: 'admin_ui',
    schemaVersion: 2,
    expiresAt,
    expiresRoleKey: CUSTOM,
    priorRole: 'chapter_secretary',
    priorAdditionalRoles: [CUSTOM_OLD],
    expiryAlertStage: 'none',
  };
}

function userData(): Record<string, unknown> {
  return {
    displayName: UID,
    chapterId: CHAPTER,
    role: 'chapter_secretary',
    displayRole: 'chapter_secretary',
    additionalRoles: [CUSTOM_OLD, CUSTOM],
    roleSource: 'roles',
  };
}

function fakeAdapter(docs: DocMap): SupaRolesAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    useSupa: () => true,
    getDoc: async (collection: string, id: string) => {
      calls.push(`getDoc:${collection}/${id}`);
      const data = docs[collection]?.[id];
      return data ? { id, ...data } : null;
    },
    listDocs: async (collection: string) => {
      calls.push(`listDocs:${collection}`);
      return Object.entries(docs[collection] ?? {}).map(([id, data]) => ({ id, ...data }));
    },
    updateDoc: async (collection: string, id: string, data: Record<string, unknown>) => {
      calls.push(`updateDoc:${collection}/${id}`);
      mockMirrorUpdates.push({ collection, id, data });
      return undefined;
    },
  };
}

beforeEach(() => {
  mockNotifications.length = 0;
  mockAuditEntries.length = 0;
  mockAssignCalls.length = 0;
  mockMirrorUpdates.length = 0;
});

afterEach(() => {
  __setSupaAdapterForTests(null);
});

describe('runCustomRoleExpirySweep parity (flag OFF vs flag ON)', () => {
  it('processes the same expired grant identically in both states (restored_prior, dropped deleted-definition prior)', async () => {
    // Flag OFF: Firestore Timestamp shape, everything in FakeFirestore.
    __setSupaAdapterForTests(null);
    const offDb = new FakeFirestore();
    offDb.seed('roles', UID, grantData(Timestamp.fromDate(new Date(EXPIRED_ISO))));
    offDb.seed('users', UID, userData());
    // No roleDefinitions doc for CUSTOM_OLD in either state: dropped.
    const offSummary = await runCustomRoleExpirySweep(offDb.asDb(), NOW);
    const offAssign = [...mockAssignCalls];
    const offAudits = mockAuditEntries.map((e) => e.details);
    const offNotifCount = mockNotifications.length;

    mockAssignCalls.length = 0;
    mockAuditEntries.length = 0;
    mockNotifications.length = 0;

    // Flag ON: ISO-string expiresAt (Supabase storage shape), docs
    // served flattened by the adapter; Firestore holds nothing.
    const docs: DocMap = {
      roles: { [UID]: grantData(EXPIRED_ISO) },
      users: { [UID]: userData() },
      roleDefinitions: {},
    };
    const adapter = fakeAdapter(docs);
    __setSupaAdapterForTests(adapter);
    const onDb = new FakeFirestore();
    const onSummary = await runCustomRoleExpirySweep(onDb.asDb(), NOW);

    expect(onSummary).toEqual(offSummary);
    expect(onSummary).toEqual({
      reminded: [],
      expiredMaterialised: [{ uid: UID, roleKey: CUSTOM, branch: 'restored_prior' }],
      failures: [],
    });
    expect(mockAssignCalls).toEqual(offAssign);
    expect(mockAssignCalls).toHaveLength(1);
    expect(mockAssignCalls[0]).toMatchObject({
      uid: UID,
      role: 'chapter_secretary',
      additionalRoles: [],
      expiresAt: null,
      expiresRoleKey: CUSTOM,
      idempotencyKey: `expiry:${UID}:${CUSTOM}:${EXPIRED_ISO}`,
    });
    expect(mockAuditEntries.map((e) => e.details)).toEqual(offAudits);
    expect(mockNotifications.length).toBe(offNotifCount);
    // The seam served the scan, the ban check and the definition check.
    expect(adapter.calls).toEqual(
      expect.arrayContaining([
        'listDocs:roles',
        `getDoc:users/${UID}`,
        `getDoc:roleDefinitions/${CUSTOM_OLD}`,
      ]),
    );
  });

  it('warn stage: Firestore stamp is primary in both states; flag ON also mirrors the same payload, flag OFF never calls the adapter', async () => {
    const expiresAt = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000);
    const warnGrant = (exp: unknown) => ({
      ...grantData(exp),
      additionalRoles: [CUSTOM],
      priorAdditionalRoles: [],
    });

    // Flag OFF with an OFF adapter injected.
    const offAdapter = fakeAdapter({});
    offAdapter.useSupa = () => false;
    __setSupaAdapterForTests(offAdapter);
    const offDb = new FakeFirestore();
    offDb.seed('roles', UID, warnGrant(Timestamp.fromDate(expiresAt)));
    offDb.seed('users', UID, userData());
    const offSummary = await runCustomRoleExpirySweep(offDb.asDb(), NOW);
    expect(offSummary.reminded).toEqual([{ uid: UID, roleKey: CUSTOM, stage: 't30_sent' }]);
    expect(offDb.read('roles', UID)?.expiryAlertStage).toBe('t30_sent');
    expect(offAdapter.calls).toEqual([]);
    expect(mockMirrorUpdates).toEqual([]);

    // Flag ON: grant served by the adapter, stamp lands on Firestore
    // (empty here, so the fake update creates the doc shell) AND is
    // mirrored with the identical payload.
    const docs: DocMap = {
      roles: { [UID]: warnGrant(expiresAt.toISOString()) },
      users: { [UID]: userData() },
      roleDefinitions: {},
    };
    const onAdapter = fakeAdapter(docs);
    __setSupaAdapterForTests(onAdapter);
    const onDb = new FakeFirestore();
    const onSummary = await runCustomRoleExpirySweep(onDb.asDb(), NOW);
    expect(onSummary.reminded).toEqual(offSummary.reminded);
    expect(mockMirrorUpdates).toEqual([
      { collection: 'roles', id: UID, data: { expiryAlertStage: 't30_sent' } },
    ]);
  });
});
