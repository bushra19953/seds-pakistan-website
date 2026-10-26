/**
 * @jest-environment node
 *
 * =====================================================================
 * README — admin-settings-writes.test.ts (TEST AUTHOR admin-5)
 * Settings-WRITE contract tests for the ADMIN cluster, covering the
 * write-path rows of cluster-admin/PARITY_TABLE.md sections 4–6 that
 * the admin-6 parity harness has NO test for:
 *   §4 discipline PUT write payload + mirror-failure invisibility
 *   §5 governance POST validation + write effects + audit-throw +
 *      mirror-failure invisibility
 *   §6 siteWide creation/save payload contract (fixtures level)
 * The REAL route handlers run here against mocked boundaries only:
 * the firebase-admin db seam, auth, founder gate, governance audit
 * writer, '@/lib/supa/adapter' + '@/lib/supa/flags' (virtual mocks —
 * src/lib/supa does not exist on this base), and
 * '@/lib/server/settings-mirror' itself, replaced by a
 * contract-faithful double: mirrorSettingsDoc / mirrorGovernanceDoc
 * resolve true/false and NEVER reject (false = mirror write failed).
 * Zero live reads; all storage is the in-memory fake below.
 *
 * STANDALONE vs BUILT-TREE split:
 * - STANDALONE (run and green on THIS branch, feat/supa-admin-5):
 *   every discipline/governance test that does not assert a mirror
 *   CALL, plus the whole siteWide CONTRACT block. On this base the
 *   routes contain no mirror hook yet (admin-3 is building it in
 *   parallel), so mirror-call assertions cannot pass here.
 * - BUILT-TREE ONLY (describe "BUILT-TREE …", auto-skipped here):
 *   the mirror-call / mirror-failure-invisibility tests. They run
 *   automatically on a tree that combines admin-3 + admin-5, detected
 *   by src/lib/server/settings-mirror.ts existing on disk (or force
 *   with ADMIN_SETTINGS_BUILT_TREE=1). The acceptance auditor runs
 *   them there; the routes still see the mirror DOUBLE above, so the
 *   assertions pin the route↔mirror contract, not admin-3's internals.
 *   VALIDATED by the author against a simulated admin-3 hookup
 *   (temporary mirror stub + route hooks, reverted after the run):
 *   18/18 green in that simulation. Note the virtual mocks for
 *   '@/lib/supa/*' and '@/lib/server/settings-mirror' are registered
 *   via jest.doMock in try/catch before the routes are required —
 *   hoisted jest.mock with the alias throws on this base (mapper
 *   rewrites to a nonexistent path), and a relative specifier does
 *   NOT intercept the routes' alias imports (both verified).
 * - siteWide CONTRACT block: asserts the payload contract re-derived
 *   from src/components/admin/site-settings-management.tsx (creation
 *   block + handleSave whitelist) and the admin-parity fixtures. It
 *   deliberately does NOT import admin-3's
 *   src/lib/site-settings-payload.ts (createSiteWidePayload /
 *   buildSiteWideSave); the auditor re-points these same assertions
 *   at that real module on the built tree.
 *
 * Exact commands:
 *   standalone:  npx jest src/lib/supa/__tests__/admin-settings-writes.test.ts
 *   built tree:  npx jest src/lib/supa/__tests__/admin-settings-writes.test.ts
 *                (same command; mirror describes auto-enable when
 *                src/lib/server/settings-mirror.ts exists, else force
 *                ADMIN_SETTINGS_BUILT_TREE=1 npx jest <same path>)
 *   harness:     npx jest src/lib/supa/__tests__/admin-parity.test.ts
 * =====================================================================
 */
import * as fs from 'fs';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/* Mocked boundaries                                                   */
/* ------------------------------------------------------------------ */

let mockDb: any;
let mockAuth: any;
let mockMirrorOutcome = true;

const mockMirrorSettingsDoc = jest.fn(async (..._args: any[]) => mockMirrorOutcome);
const mockMirrorGovernanceDoc = jest.fn(async (..._args: any[]) => mockMirrorOutcome);
// W4 primacy doubles, OFF-faithful: with SUPA_PRIMARY unset the real
// helpers return false with no side effects, so the routes run their
// original Firestore-first flow + mirror. The primacy-ON arm (adapter
// first, throws on failure) is pinned against the real seam by
// src/lib/server/__tests__/settings-notifications-primacy-w4.test.ts.
const mockSetSettingsDocPrimaryFirst = jest.fn(async (..._args: any[]) => false);
const mockSetGovernanceDocPrimaryFirst = jest.fn(async (..._args: any[]) => false);
const mockAuditWrite = jest.fn(async (..._args: any[]) => 'audit-1');
const mockAdapterSetDoc = jest.fn(async (..._args: any[]) => ({ id: 'mock' }));

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

jest.mock('@/lib/server/permissions', () => ({
  hasServerPermissionForUser: jest.fn(async () => true),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TS' },
}));

jest.mock('@/lib/server/founder-gate', () => {
  class FounderGateError extends Error {
    constructor() {
      super('Forbidden: Founder only');
      this.name = 'FounderGateError';
    }
  }
  return {
    FounderGateError,
    assertFounder: jest.fn(async () => ({ uid: 'founder-1' })),
  };
});

jest.mock('@/lib/auth/verifySession', () => ({
  toSessionErrorResponse: () => null,
}));

jest.mock('@/lib/server/governance-audit', () => ({
  writeGovernanceAuditOrThrow: (...args: any[]) => (mockAuditWrite as any)(...args),
}));

// src/lib/supa + src/lib/server/settings-mirror do not exist on this
// base — virtual mocks (task spec), registered with jest.doMock (NOT
// hoisted jest.mock) inside try/catch, BEFORE the route modules are
// required in beforeAll below:
// - On this base the '@/' moduleNameMapper rewrites the alias to a
//   path that does not exist and mock registration throws; the catch
//   swallows it, which is correct here because the base routes never
//   import these modules.
// - On the built tree (adapter + admin-3 landed) the paths exist,
//   registration succeeds, and the alias specifier is what the routes
//   themselves import, so the doubles intercept. (A relative
//   specifier was tried first: it does NOT intercept alias imports.)
try {
  jest.doMock(
    '@/lib/supa/adapter',
    () => {
      const adapter = {
        getDoc: jest.fn(async () => null),
        listDocs: jest.fn(async () => []),
        countDocs: jest.fn(async () => 0),
        setDoc: (...args: any[]) => (mockAdapterSetDoc as any)(...args),
        updateDoc: jest.fn(async () => ({ id: 'mock' })),
        deleteDoc: jest.fn(async () => undefined),
      };
      return {
        getSupaAdapter: () => adapter,
        createSupaAdapter: () => adapter,
        ...adapter,
      };
    },
    { virtual: true },
  );
} catch {
  /* module absent on this base — see note above */
}
try {
  jest.doMock(
    '@/lib/supa/flags',
    () => ({
      useSupa: () => true,
      parseSupaSurfaces: (raw: string | undefined) =>
        new Set(
          (raw ?? '')
            .split(',')
            .map((s: string) => s.trim().toLowerCase())
            .filter(Boolean),
        ),
    }),
    { virtual: true },
  );
} catch {
  /* module absent on this base — see note above */
}
// Contract-faithful mirror double: resolves boolean, never rejects.
try {
  jest.doMock(
    '@/lib/server/settings-mirror',
    () => ({
      mirrorSettingsDoc: (...args: any[]) => (mockMirrorSettingsDoc as any)(...args),
      mirrorGovernanceDoc: (...args: any[]) => (mockMirrorGovernanceDoc as any)(...args),
      setSettingsDocPrimaryFirst: (...args: any[]) => (mockSetSettingsDocPrimaryFirst as any)(...args),
      setGovernanceDocPrimaryFirst: (...args: any[]) => (mockSetGovernanceDocPrimaryFirst as any)(...args),
    }),
    { virtual: true },
  );
} catch {
  /* module absent on this base — see note above */
}

import { NextRequest } from 'next/server';
import { DEFAULT_DISCIPLINE_SETTINGS } from '@/lib/server/discipline/settings';

// Route handlers are required AFTER the doMock registrations above
// (static imports would be hoisted above them and load the real /
// unresolvable modules first).
let disciplinePUT: any;
let governancePOST: any;
beforeAll(() => {
  disciplinePUT = require('@/app/api/admin/discipline-settings/route').PUT;
  governancePOST = require('@/app/api/governance/settings/route').POST;
});
import {
  SITEWIDE_STATE,
  SITEWIDE_STUDENTS_COUNT,
} from './admin-parity-fixtures';

/* ------------------------------------------------------------------ */
/* In-memory Firestore fake (records every set with its options)       */
/* ------------------------------------------------------------------ */

type SetCall = { collection: string; id: string; data: any; opts: any };
const mockSetCalls: SetCall[] = [];
let mockStore = new Map<string, any>();

function makeMockDb() {
  mockStore = new Map();
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = mockStore.get(`${name}/${id}`);
          return {
            id,
            exists: data !== undefined,
            data: () => (data ? { ...data } : undefined),
          };
        },
        set: async (data: any, opts?: any) => {
          mockSetCalls.push({ collection: name, id, data, opts });
          const prev = mockStore.get(`${name}/${id}`);
          mockStore.set(
            `${name}/${id}`,
            opts?.merge && prev ? { ...prev, ...data } : { ...data },
          );
        },
      }),
    }),
  };
}

function resetAll() {
  mockDb = makeMockDb();
  mockSetCalls.length = 0;
  mockAuth = {
    authenticated: true,
    user: { userId: 'admin-1', uid: 'admin-1', role: 'superadmin' },
  };
  mockMirrorOutcome = true;
  mockMirrorSettingsDoc.mockClear();
  mockMirrorGovernanceDoc.mockClear();
  mockSetSettingsDocPrimaryFirst.mockClear();
  mockSetGovernanceDocPrimaryFirst.mockClear();
  mockAdapterSetDoc.mockClear();
  mockAuditWrite.mockReset();
  mockAuditWrite.mockImplementation(async () => 'audit-1');
}

beforeEach(resetAll);

/* ------------------------------------------------------------------ */
/* Request builders + shared bodies                                    */
/* ------------------------------------------------------------------ */

const DISCIPLINE_VALID = {
  shadowMode: false,
  cronReferralLive: true,
  referralWindowDays: 14,
  referralMissThreshold: 2,
  warningRegistryVariant: 'internal',
};

function disciplineReq(body: unknown) {
  return new NextRequest('http://localhost/api/admin/discipline-settings', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const GOVERNANCE_VALID = {
  consentGateMode: { sponsor_partner: 'hard' },
  flags: { consentLive: true },
  changeReason: 'turn consent live now',
};

function governanceReq(body: unknown) {
  return new NextRequest('http://localhost/api/governance/settings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/** Find the payload object among mirror-call arguments, tolerating the
 *  plausible admin-3 signatures: (collection, id, payload),
 *  (db, collection, id, payload), (payload), ({ collection, id, data }). */
function payloadFromCalls(fn: jest.Mock): any {
  for (const call of fn.mock.calls) {
    for (const arg of call) {
      if (!arg || typeof arg !== 'object') continue;
      if ('updatedBy' in arg) return arg;
      if (arg.data && typeof arg.data === 'object' && 'updatedBy' in arg.data) return arg.data;
      if (arg.payload && typeof arg.payload === 'object' && 'updatedBy' in arg.payload)
        return arg.payload;
    }
  }
  return undefined;
}
const anyMirrorPayload = () =>
  payloadFromCalls(mockMirrorSettingsDoc) ?? payloadFromCalls(mockMirrorGovernanceDoc);
const totalMirrorCalls = () =>
  mockMirrorSettingsDoc.mock.calls.length + mockMirrorGovernanceDoc.mock.calls.length;

/* ================================================================== */
/* §4 DISCIPLINE PUT — standalone (PARITY_TABLE section 4)             */
/* ================================================================== */

describe('discipline PUT write contract (route.ts PUT)', () => {
  it('valid body: Firestore payload = validated fields + updatedAt ISO + updatedBy, merge; response settings = validated value ONLY', async () => {
    const res = await disciplinePUT(disciplineReq(DISCIPLINE_VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Response carries the validated value only — no updatedAt/updatedBy.
    expect(body.settings).toEqual(DISCIPLINE_VALID);
    expect(body.defaults).toEqual(DEFAULT_DISCIPLINE_SETTINGS);

    expect(mockSetCalls).toHaveLength(1);
    const call = mockSetCalls[0];
    // W4 wiring: the primacy helper is consulted first with the
    // identical payload (OFF double returns false, Firestore-first).
    expect(mockSetSettingsDocPrimaryFirst).toHaveBeenCalledTimes(1);
    expect(mockSetSettingsDocPrimaryFirst).toHaveBeenCalledWith('settings', 'discipline', call.data);
    expect(call.collection).toBe('settings');
    expect(call.id).toBe('discipline');
    expect(call.opts).toEqual({ merge: true });
    const { updatedAt, ...rest } = call.data;
    expect(rest).toEqual({ ...DISCIPLINE_VALID, updatedBy: 'admin-1' });
    expect(typeof updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
    expect(updatedAt).toBe(new Date(updatedAt).toISOString());
  });

  it('valid body with an extra field: extra field is dropped from payload and response', async () => {
    const res = await disciplinePUT(
      disciplineReq({ ...DISCIPLINE_VALID, evilExtraField: 'must not persist' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual(DISCIPLINE_VALID);
    expect(mockSetCalls).toHaveLength(1);
    expect('evilExtraField' in mockSetCalls[0].data).toBe(false);
  });

  it('invalid body (non-boolean shadowMode) -> 400, NO write, NO mirror', async () => {
    const res = await disciplinePUT(disciplineReq({ ...DISCIPLINE_VALID, shadowMode: 'off' }));
    expect(res.status).toBe(400);
    expect(mockSetCalls).toHaveLength(0);
    expect(totalMirrorCalls()).toBe(0);
  });

  it('invalid body (fractional referralWindowDays 3.5 — read accepts it, write rejects) -> 400, NO write, NO mirror', async () => {
    const res = await disciplinePUT(
      disciplineReq({ ...DISCIPLINE_VALID, referralWindowDays: 3.5 }),
    );
    expect(res.status).toBe(400);
    expect(mockSetCalls).toHaveLength(0);
    expect(totalMirrorCalls()).toBe(0);
  });

  it('invalid body (referralMissThreshold out of range) -> 400, NO write, NO mirror', async () => {
    const res = await disciplinePUT(
      disciplineReq({ ...DISCIPLINE_VALID, referralMissThreshold: 21 }),
    );
    expect(res.status).toBe(400);
    expect(mockSetCalls).toHaveLength(0);
    expect(totalMirrorCalls()).toBe(0);
  });
});

/* ================================================================== */
/* §5 GOVERNANCE POST — standalone (PARITY_TABLE section 5)            */
/* ================================================================== */

describe('governance POST validation (route.ts POST)', () => {
  it('changeReason < 10 chars -> 400, no writes at all', async () => {
    const res = await governancePOST(governanceReq({ ...GOVERNANCE_VALID, changeReason: 'short' }));
    expect(res.status).toBe(400);
    expect(mockSetCalls).toHaveLength(0);
    expect(mockAuditWrite).not.toHaveBeenCalled();
    expect(totalMirrorCalls()).toBe(0);
  });

  it('unknown flag -> 400, no writes at all', async () => {
    const res = await governancePOST(
      governanceReq({ flags: { nopeLive: true }, changeReason: 'a long enough reason' }),
    );
    expect(res.status).toBe(400);
    expect(mockSetCalls).toHaveLength(0);
    expect(mockAuditWrite).not.toHaveBeenCalled();
    expect(totalMirrorCalls()).toBe(0);
  });

  it('non-boolean flag value -> 400, no writes at all', async () => {
    const res = await governancePOST(
      governanceReq({ flags: { consentLive: 'yes' }, changeReason: 'a long enough reason' }),
    );
    expect(res.status).toBe(400);
    expect(mockSetCalls).toHaveLength(0);
    expect(mockAuditWrite).not.toHaveBeenCalled();
    expect(totalMirrorCalls()).toBe(0);
  });

  it('empty update (valid changeReason only) -> 400, no writes at all', async () => {
    const res = await governancePOST(
      governanceReq({ changeReason: 'a long enough reason' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Nothing to update');
    expect(mockSetCalls).toHaveLength(0);
    expect(mockAuditWrite).not.toHaveBeenCalled();
    expect(totalMirrorCalls()).toBe(0);
  });
});

describe('governance POST write effects (route.ts POST)', () => {
  it('valid body: set(merge) with updatedAt/updatedBy/changeReason + governance audit entry; response = merged effective settings', async () => {
    const res = await governancePOST(governanceReq(GOVERNANCE_VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.flags.consentLive).toBe(true);
    expect(body.settings.consentGateMode.sponsor_partner).toBe('hard');
    // Untouched defaults survive the merge in the effective settings.
    expect(body.settings.consentGateMode.chapter_lifecycle).toBe('hard');
    expect(body.settings.flags.boardLive).toBe(false);

    expect(mockSetCalls).toHaveLength(1);
    const call = mockSetCalls[0];
    // W4 wiring: the primacy helper is consulted first with the
    // mirror payload (OFF double returns false, Firestore-first).
    expect(mockSetGovernanceDocPrimaryFirst).toHaveBeenCalledTimes(1);
    expect(mockSetGovernanceDocPrimaryFirst).toHaveBeenCalledWith(
      'phase2',
      expect.objectContaining({ updatedBy: 'founder-1', changeReason: 'turn consent live now' }),
    );
    expect(call.collection).toBe('governance_settings');
    expect(call.id).toBe('phase2');
    expect(call.opts).toEqual({ merge: true });
    expect(call.data).toEqual({
      consentGateMode: { sponsor_partner: 'hard' },
      flags: { consentLive: true },
      updatedAt: 'SERVER_TS', // FieldValue.serverTimestamp() sentinel from the mock
      updatedBy: 'founder-1',
      changeReason: 'turn consent live now',
    });

    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const auditEntry = mockAuditWrite.mock.calls[0][1];
    expect(auditEntry).toEqual({
      action: 'governance_settings_updated',
      actorUid: 'founder-1',
      targetType: 'governance_settings',
      targetId: 'phase2',
      details: {
        changeReason: 'turn consent live now',
        keys: ['consentGateMode', 'flags'],
      },
    });
  });

  it('audit write throwing FAILS the request (this failure is NOT invisible): POST rejects, no success response', async () => {
    mockAuditWrite.mockImplementation(async () => {
      throw new Error('audit boom');
    });
    await expect(governancePOST(governanceReq(GOVERNANCE_VALID))).rejects.toThrow('audit boom');
    // Oracle ordering in the current route: the primary set lands BEFORE
    // the audit write, so exactly one set has happened when it fails.
    expect(mockSetCalls).toHaveLength(1);
  });
});

/* ================================================================== */
/* §6 SITE-WIDE payload — CONTRACT, fixtures level (auditor re-point)  */
/*                                                                     */
/* Re-derived verbatim from site-settings-management.tsx: creation   */
/* block (missing doc) and handleSave whitelist. On the built tree   */
/* the auditor re-points these assertions at admin-3's real module   */
/* src/lib/site-settings-payload.ts:                                 */
/*   createSiteWidePayload(studentsCount, uid)  == creation below    */
/*   buildSiteWideSave(settings, studentsCount, uid) == save below   */
/* (modulo the writer-added updatedAt serverTimestamp, which the     */
/* component payload carries and the payload module may leave to     */
/* its caller — that is the one sanctioned re-point adjustment.)     */
/* ================================================================== */

function contractCreateSiteWidePayload(studentsCount: number, uid: string) {
  const { DEFAULT_SITE_SETTINGS } = require('@/types/site-settings');
  return {
    studentsEngaged: studentsCount,
    activeProjects: DEFAULT_SITE_SETTINGS.activeProjects,
    partners: DEFAULT_SITE_SETTINGS.partners,
    globalChapters: DEFAULT_SITE_SETTINGS.globalChapters,
    contactFormDestinationEmail: DEFAULT_SITE_SETTINGS.contactFormDestinationEmail,
    enableDonations: DEFAULT_SITE_SETTINGS.enableDonations,
    enableChapterRegistration: DEFAULT_SITE_SETTINGS.enableChapterRegistration,
    registrationStatus: DEFAULT_SITE_SETTINGS.registrationStatus,
    registrationNumber: DEFAULT_SITE_SETTINGS.registrationNumber,
    registrationDate: DEFAULT_SITE_SETTINGS.registrationDate,
    registrarJurisdiction: DEFAULT_SITE_SETTINGS.registrarJurisdiction,
    updatedBy: uid || 'system',
  };
}

function contractBuildSiteWideSave(settings: Record<string, any>, studentsCount: number, uid: string) {
  return {
    studentsEngaged: studentsCount,
    activeProjects: settings.activeProjects || 0,
    partners: settings.partners || 0,
    globalChapters: settings.globalChapters || 25,
    contactFormDestinationEmail: settings.contactFormDestinationEmail || '',
    bugReportEmail: settings.bugReportEmail || '',
    enableDonations: settings.enableDonations || false,
    enableChapterRegistration: settings.enableChapterRegistration || false,
    registrationStatus: settings.registrationStatus || 'in_process',
    registrationNumber: settings.registrationNumber || '',
    registrationDate: settings.registrationDate || '',
    registrarJurisdiction: settings.registrarJurisdiction || '',
    siteEnabled: settings.siteEnabled !== false,
    maintenanceMode: settings.maintenanceMode === true,
    updatedBy: uid,
  };
}

const SAVE_WHITELIST_14 = [
  'studentsEngaged',
  'activeProjects',
  'partners',
  'globalChapters',
  'contactFormDestinationEmail',
  'bugReportEmail',
  'enableDonations',
  'enableChapterRegistration',
  'registrationStatus',
  'registrationNumber',
  'registrationDate',
  'registrarJurisdiction',
  'siteEnabled',
  'maintenanceMode',
];

describe('CONTRACT siteWide payload (component oracle — re-point at site-settings-payload.ts on built tree)', () => {
  it('creation payload: defaults + dynamic students count; bugReportEmail/siteEnabled/maintenanceMode ABSENT', () => {
    const created = contractCreateSiteWidePayload(SITEWIDE_STUDENTS_COUNT, 'admin-1');
    expect(created).toEqual({
      studentsEngaged: 42,
      activeProjects: 0,
      partners: 0,
      globalChapters: 25,
      contactFormDestinationEmail: '',
      enableDonations: false,
      enableChapterRegistration: false,
      registrationStatus: 'in_process',
      registrationNumber: '',
      registrationDate: '',
      registrarJurisdiction: '',
      updatedBy: 'admin-1',
    });
    expect('bugReportEmail' in created).toBe(false);
    expect('siteEnabled' in created).toBe(false);
    expect('maintenanceMode' in created).toBe(false);
    // Component fallback: no signed-in user -> updatedBy 'system'.
    expect(contractCreateSiteWidePayload(42, '').updatedBy).toBe('system');
  });

  it('save whitelist: exactly the 14 fields (+ updatedBy) with all value traps', () => {
    const saved = contractBuildSiteWideSave(SITEWIDE_STATE, SITEWIDE_STUDENTS_COUNT, 'admin-1');
    expect(Object.keys(saved).sort()).toEqual([...SAVE_WHITELIST_14, 'updatedBy'].sort());
    expect(saved).toEqual({
      studentsEngaged: 42, // dynamic count overrides the edited 9999
      activeProjects: 12,
      partners: 4,
      globalChapters: 25, // 0 -> || 25 trap
      contactFormDestinationEmail: 'hello@example.com',
      bugReportEmail: 'bugs@example.com',
      enableDonations: true,
      enableChapterRegistration: false, // undefined -> || false
      registrationStatus: 'registered',
      registrationNumber: 'ICT-123',
      registrationDate: '2026-01-15',
      registrarJurisdiction: 'Islamabad',
      siteEnabled: true, // undefined !== false
      maintenanceMode: false, // undefined !== true (=== true check)
      updatedBy: 'admin-1',
    });
    expect('evilExtraField' in saved).toBe(false);
  });

  it('save traps, opposite polarity: explicit siteEnabled false stays false; explicit maintenanceMode true stays true', () => {
    const saved = contractBuildSiteWideSave(
      { ...SITEWIDE_STATE, siteEnabled: false, maintenanceMode: true },
      SITEWIDE_STUDENTS_COUNT,
      'admin-1',
    );
    expect(saved.siteEnabled).toBe(false);
    expect(saved.maintenanceMode).toBe(true);
  });
});

/* ================================================================== */
/* BUILT-TREE ONLY — mirror wiring (admin-3 + admin-5 combined tree)   */
/* Auto-skipped on this branch: settings-mirror.ts does not exist    */
/* here and the base routes contain no mirror hook.                  */
/* ================================================================== */

const BUILT_TREE =
  process.env.ADMIN_SETTINGS_BUILT_TREE === '1' ||
  fs.existsSync(path.join(__dirname, '../../server/settings-mirror.ts'));
const describeBuilt = BUILT_TREE ? describe : describe.skip;

describeBuilt('BUILT-TREE discipline PUT mirror wiring', () => {
  it('mirror is called with the IDENTICAL payload written to Firestore', async () => {
    const res = await disciplinePUT(disciplineReq(DISCIPLINE_VALID));
    expect(res.status).toBe(200);
    expect(mockSetCalls).toHaveLength(1);
    expect(totalMirrorCalls()).toBeGreaterThanOrEqual(1);
    expect(anyMirrorPayload()).toEqual(mockSetCalls[0].data);
  });

  it('mirror failure (double resolves false) -> response UNCHANGED (200, same body)', async () => {
    const okRes = await disciplinePUT(disciplineReq(DISCIPLINE_VALID));
    const okBody = await okRes.json();
    resetAll();
    mockMirrorOutcome = false;
    const failRes = await disciplinePUT(disciplineReq(DISCIPLINE_VALID));
    expect(totalMirrorCalls()).toBeGreaterThanOrEqual(1);
    expect(failRes.status).toBe(okRes.status);
    expect(await failRes.json()).toEqual(okBody);
  });
});

describeBuilt('BUILT-TREE governance POST mirror wiring', () => {
  it('mirror is called with the governance write payload (update + updatedBy + changeReason)', async () => {
    const res = await governancePOST(governanceReq(GOVERNANCE_VALID));
    expect(res.status).toBe(200);
    expect(mockSetCalls).toHaveLength(1);
    expect(totalMirrorCalls()).toBeGreaterThanOrEqual(1);
    const mirrored = anyMirrorPayload();
    expect(mirrored).toBeDefined();
    // Subset match (not strict equality): the Firestore payload carries
    // the serverTimestamp sentinel for updatedAt, whose mirror-side
    // representation is admin-3's choice; the substantive fields must
    // be identical.
    expect(mirrored).toMatchObject({
      consentGateMode: { sponsor_partner: 'hard' },
      flags: { consentLive: true },
      updatedBy: 'founder-1',
      changeReason: 'turn consent live now',
    });
  });

  it('mirror failure (double resolves false) -> response UNCHANGED', async () => {
    const okRes = await governancePOST(governanceReq(GOVERNANCE_VALID));
    const okBody = await okRes.json();
    resetAll();
    mockMirrorOutcome = false;
    const failRes = await governancePOST(governanceReq(GOVERNANCE_VALID));
    expect(totalMirrorCalls()).toBeGreaterThanOrEqual(1);
    expect(failRes.status).toBe(okRes.status);
    expect(await failRes.json()).toEqual(okBody);
  });
});
