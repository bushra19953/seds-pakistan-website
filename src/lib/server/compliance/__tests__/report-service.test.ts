/**
 * Report service tests (spec G.10): regeneration REVISES one doc
 * (revision + 1, deliveryHistory untouched), delivery appends exactly
 * one history entry per actual delivery, and the open
 * quarterly-compliance-report instance completes exactly once via
 * 'report_delivery'.
 */

jest.mock('jspdf', () => {
  const util = require('util');
  if (!(global as any).TextEncoder) (global as any).TextEncoder = util.TextEncoder;
  if (!(global as any).TextDecoder) (global as any).TextDecoder = util.TextDecoder;
  return jest.requireActual('jspdf/dist/jspdf.node.js');
});

const mockState = {
  sent: [] as { uid: string; type: string }[],
  broadcasts: 0,
};

let mockDocs: Record<string, any> = {};
let autoId = 0;

function applyData(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) {
    next[k] = v && typeof v === 'object' && v.__fv === 'serverTimestamp' ? new Date() : v;
  }
  return next;
}
function makeDocRef(path: string): any {
  return {
    id: path.split('/').pop(),
    path,
    get: async () => {
      const data = mockDocs[path];
      return { exists: data !== undefined, data: () => data };
    },
    set: async (data: any, opts?: any) => {
      mockDocs[path] = opts?.merge ? applyData(mockDocs[path] ?? {}, data) : { ...data };
    },
    update: async (data: any) => {
      mockDocs[path] = applyData(mockDocs[path] ?? {}, data);
    },
    collection: (sub: string) => makeCollectionRef(`${path}/${sub}`),
  };
}
function makeQuery(collectionPath: string, filters: any[] = [], limitN?: number): any {
  return {
    where: (field: string, op: string, value: any) => makeQuery(collectionPath, [...filters, { field, op, value }], limitN),
    limit: (n: number) => makeQuery(collectionPath, filters, n),
    get: async () => {
      let docs = Object.entries(mockDocs)
        .filter(([p]) => p.startsWith(`${collectionPath}/`) && p.split('/').length === collectionPath.split('/').length + 1)
        .map(([p, data]) => ({ id: p.split('/').pop()!, data: () => data, ref: makeDocRef(p), exists: true }));
      for (const f of filters) {
        docs = docs.filter((d) => {
          const v = d.data()[f.field];
          return f.op === 'in' ? f.value.includes(v) : v === f.value;
        });
      }
      if (limitN) docs = docs.slice(0, limitN);
      return { empty: docs.length === 0, docs, size: docs.length, forEach: (fn: any) => docs.forEach(fn) };
    },
  };
}
function makeCollectionRef(path: string): any {
  return {
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${++autoId}`}`),
    where: (field: string, op: string, value: any) => makeQuery(path, [{ field, op, value }]),
    get: async () => makeQuery(path).get(),
  };
}
const mockDb = { collection: (name: string) => makeCollectionRef(name) };

jest.mock('firebase-admin', () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
      increment: (n: number) => ({ __fv: 'increment', n }),
    },
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
  },
}));
jest.mock('@/lib/server/firebase-admin', () => ({
  ensureAdminInitialized: () => true,
  getDb: () => mockDb,
}));
jest.mock('@/lib/drive/client', () => ({
  uploadToVault: async (fileName: string) => ({
    fileId: `drive-${fileName}`,
    webViewLink: `https://drive.google.com/file/d/${fileName}/view`,
  }),
}));
jest.mock('@/lib/server/notification-service', () => ({
  notificationService: {
    send: async (uid: string, payload: { type: string }) => {
      mockState.sent.push({ uid, type: payload.type });
    },
    broadcastByRoles: async () => {
      // The real service returns void and resolves recipients itself by
      // users.displayRole; the delivery record is built from that query.
      mockState.broadcasts += 1;
    },
  },
}));

import { generateQuarterlyReport, deliverQuarterlyReport } from '../report-service';

const REPORT_INSTANCE = 'compliance_obligations/quarterly-compliance-report__FY27__Q1';

beforeEach(() => {
  mockDocs = {};
  autoId = 0;
  mockState.sent = [];
  mockState.broadcasts = 0;
  mockDocs['roles/ac-1'] = { role: 'national_audit_compliance_chair' };
  mockDocs['roles/treasurer-1'] = { role: 'national_treasurer' };
  mockDocs['users/founder-user'] = { displayRole: 'founder_patron' };
  mockDocs['users/gov-1'] = { displayRole: 'governor_founder' };
  mockDocs[REPORT_INSTANCE] = {
    instanceKey: 'fy2026-27:quarterly-compliance-report:2027-01-05',
    templateKey: 'quarterly-compliance-report',
    officeRole: 'national_audit_compliance_chair',
    chapterId: null,
    periodKey: 'Q1',
    dueDate: new Date('2027-01-05'),
    status: 'scheduled',
    ownerUidSnapshot: null,
  };
  mockDocs['compliance_obligations/ob-1'] = {
    templateKey: 'bank-reconciliation',
    title: 'Bank reconciliation',
    officeRole: 'national_treasurer',
    chapterId: null,
    ownerUidSnapshot: 'treasurer-1',
    dueDate: new Date('2026-10-15'),
    status: 'completed',
    completedAt: new Date('2026-10-14'),
  };
});

describe('generate + deliver', () => {
  it('first generation creates revision 1 with empty deliveryHistory', async () => {
    const { revision, pdfUrl } = await generateQuarterlyReport('FY27-Q1', 'manual', new Date('2027-01-05'));
    expect(revision).toBe(1);
    expect(pdfUrl).toContain('drive.google.com');
    const doc = mockDocs['compliance_reports/FY27-Q1'];
    expect(doc.deliveryHistory).toEqual([]);
    expect(doc.pdfDriveFileId).toBeTruthy();
    expect(doc.summarySnapshot.dueInQuarter).toBe(1);
  });

  it('regeneration revises the SAME doc and never touches deliveryHistory', async () => {
    await generateQuarterlyReport('FY27-Q1', 'manual', new Date('2027-01-05'));
    await deliverQuarterlyReport('FY27-Q1', 'ngs-1', new Date('2027-01-05'));
    const historyAfterDelivery = mockDocs['compliance_reports/FY27-Q1'].deliveryHistory;
    expect(historyAfterDelivery).toHaveLength(1);

    const { revision } = await generateQuarterlyReport('FY27-Q1', 'manual', new Date('2027-01-06'));
    expect(revision).toBe(2);
    const doc = mockDocs['compliance_reports/FY27-Q1'];
    expect(doc.deliveryHistory).toHaveLength(1);
    expect(Object.keys(mockDocs).filter((p) => p.startsWith('compliance_reports/'))).toHaveLength(1);
  });

  it('delivery broadcasts, notifies the Audit Chair, and completes the report instance exactly once', async () => {
    await generateQuarterlyReport('FY27-Q1', 'cron', new Date('2027-01-05'));
    const first = await deliverQuarterlyReport('FY27-Q1', 'cron', new Date('2027-01-05'));
    expect(mockState.broadcasts).toBe(1);
    expect(mockState.sent.some((s) => s.uid === 'ac-1' && s.type === 'compliance_quarterly_report')).toBe(true);
    expect(first.deliveredTo).toEqual(expect.arrayContaining(['founder-user', 'gov-1', 'ac-1']));
    expect(first.completedInstanceId).toBe('quarterly-compliance-report__FY27__Q1');
    const instance = mockDocs[REPORT_INSTANCE];
    expect(instance.status).toBe('completed');
    expect(instance.completedVia).toBe('report_delivery');
    expect(instance.evidence.ref).toContain('drive.google.com');

    // A second delivery is a NEW history entry but never re-completes.
    const second = await deliverQuarterlyReport('FY27-Q1', 'cron', new Date('2027-01-06'));
    expect(second.completedInstanceId).toBeNull();
    expect(mockDocs['compliance_reports/FY27-Q1'].deliveryHistory).toHaveLength(2);
    expect(mockDocs[REPORT_INSTANCE].completedVia).toBe('report_delivery');
  });

  it('delivering an ungenerated report fails loudly', async () => {
    await expect(deliverQuarterlyReport('FY27-Q2', 'cron')).rejects.toThrow('REPORT_NOT_GENERATED');
  });
});
