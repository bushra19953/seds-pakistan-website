/**
 * Erasure completeness tests (Workstream F): cooling-off enforced
 * (F-G1), tombstone profile, Auth deleted exactly once, retained
 * ledger pseudonymised, request record retained as proof.
 */
jest.mock('@/lib/server/user-contact', () => ({
  clearUserContact: jest.fn(async () => undefined),
}));
import { clearUserContact } from '@/lib/server/user-contact';
import { FakeFirestore } from '../../governance/__tests__/fake-firestore';
import {
  executeErasure,
  requestErasure,
  withdrawErasure,
  type ErasureDeps,
} from '../erasure';

const T0 = new Date('2026-10-01T00:00:00.000Z');

function makeWorld() {
  const db = new FakeFirestore();
  db.seed('users', 'u-erase', {
    displayName: 'Leaving Member',
    email: 'leaving@example.com',
    memberStatus: 'active',
  });
  db.seed('roles', 'u-erase', { role: 'member' });
  db.seed('points_ledger', 'pl-1', { userId: 'u-erase', points: 40 });
  db.seed('points_ledger', 'pl-2', { userId: 'someone-else', points: 5 });
  const authDeletes: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let clock = T0;
  const deps: ErasureDeps = {
    db: db as unknown as ErasureDeps['db'],
    deleteAuthUser: async (uid) => {
      authDeletes.push(uid);
    },
    writeAudit: async (entry) => {
      audits.push(entry);
    },
    now: () => clock,
  };
  return {
    db,
    deps,
    authDeletes,
    audits,
    advanceDays: (d: number) => {
      clock = new Date(clock.getTime() + d * 24 * 60 * 60 * 1000);
    },
  };
}

describe('erasure flow', () => {
  it('enforces the 14-day cooling-off, then erases completely', async () => {
    const w = makeWorld();
    const { requestId } = await requestErasure(w.deps, 'u-erase');
    await expect(
      executeErasure(w.deps, requestId, 'admin-1'),
    ).rejects.toThrow(/Cooling-off/);
    expect(w.authDeletes).toHaveLength(0);

    w.advanceDays(15);
    const { pseudonym } = await executeErasure(w.deps, requestId, 'admin-1');

    const tombstone = w.db.getDoc('users', 'u-erase');
    expect(tombstone?.memberStatus).toBe('erased');
    expect(tombstone?.displayName).toBe('Erased member');
    expect(tombstone?.email).toBeNull();
    // Contact-gating: the gated contact doc is deleted and the four
    // extra contact fields are cleared with delete sentinels.
    expect(clearUserContact).toHaveBeenCalledWith(expect.anything(), 'u-erase');
    for (const k of ['whatsapp', 'whatsappNumber', 'email_lowercase', 'contactNumber']) {
      expect(tombstone?.[k]).toBeDefined();
      expect(String((tombstone as any)[k]?.methodName || '')).toContain('FieldValue.delete');
    }
    expect(w.authDeletes).toEqual(['u-erase']);
    expect(w.db.getDoc('points_ledger', 'pl-1')?.userId).toBe(pseudonym);
    expect(w.db.getDoc('points_ledger', 'pl-2')?.userId).toBe('someone-else');
    expect(w.db.getDoc('roles', 'u-erase')?.memberStatus).toBe('erased');
    const req = w.db.getDoc('erasure_requests', requestId);
    expect(req?.status).toBe('executed');
    expect(req?.executedBy).toBe('admin-1');
    expect(w.audits.some((a) => a.type === 'ERASURE_EXECUTED')).toBe(true);
  });

  it('rejects a duplicate open request and supports withdrawal', async () => {
    const w = makeWorld();
    const { requestId } = await requestErasure(w.deps, 'u-erase');
    await expect(requestErasure(w.deps, 'u-erase')).rejects.toThrow(
      /already/,
    );
    await withdrawErasure(w.deps, requestId, 'u-erase');
    expect(w.db.getDoc('erasure_requests', requestId)?.status).toBe(
      'withdrawn',
    );
    w.advanceDays(20);
    await expect(
      executeErasure(w.deps, requestId, 'admin-1'),
    ).rejects.toThrow(/not cooling_off/);
    expect(w.authDeletes).toHaveLength(0);
  });
});
