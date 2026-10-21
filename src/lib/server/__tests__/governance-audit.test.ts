/**
 * @jest-environment node
 *
 * Tests for src/lib/server/governance-audit.ts.
 *
 * Pins the governance rule that separates this writer from the existing
 * best-effort loggers: a failed audit write THROWS GovernanceAuditError
 * so the calling governance action fails with no unaudited state change.
 * The batch path only adds a set op (commit errors are the caller's).
 */

import { FieldValue } from 'firebase-admin/firestore';
import { writeGovernanceAuditOrThrow, GovernanceAuditError } from '../governance-audit';

type SetCall = { ref: any; data: any };

function makeDb(opts: { setThrows?: boolean } = {}) {
  const setCalls: SetCall[] = [];
  let counter = 0;
  const db: any = {
    collection: (name: string) => {
      if (name !== 'audit_logs') throw new Error(`unexpected collection ${name}`);
      return {
        doc: () => {
          const id = `audit-${++counter}`;
          const ref = {
            id,
            path: `audit_logs/${id}`,
            set: async (data: any) => {
              if (opts.setThrows) throw new Error('firestore unavailable');
              setCalls.push({ ref, data });
            },
          };
          return ref;
        },
      };
    },
  };
  return { db, setCalls };
}

describe('writeGovernanceAuditOrThrow', () => {
  it('writes the expected fields to audit_logs and returns the doc id', async () => {
    const { db, setCalls } = makeDb();

    const id = await writeGovernanceAuditOrThrow(db, {
      action: 'consent_request_decided',
      actorUid: 'actor-1',
      targetType: 'consent_request',
      targetId: 'req-42',
      details: { decision: 'approved', note: undefined },
    });

    expect(id).toBe('audit-1');
    expect(setCalls).toHaveLength(1);
    const data = setCalls[0].data;
    expect(data.action).toBe('consent_request_decided');
    expect(data.actorUid).toBe('actor-1');
    expect(data.targetType).toBe('consent_request');
    expect(data.targetId).toBe('req-42');
    // undefined values are stripped before the write.
    expect(data.details).toEqual({ decision: 'approved' });
    expect(data.createdAt).toEqual(FieldValue.serverTimestamp());
  });

  it('omits targetType/targetId when not provided', async () => {
    const { db, setCalls } = makeDb();

    await writeGovernanceAuditOrThrow(db, { action: 'vote_opened', actorUid: 'actor-1' });

    const data = setCalls[0].data;
    expect(data.targetType).toBeUndefined();
    expect(data.targetId).toBeUndefined();
    expect(data.details).toBeNull();
    expect(data.createdAt).toEqual(FieldValue.serverTimestamp());
  });

  it('throws GovernanceAuditError when the db write fails', async () => {
    const { db } = makeDb({ setThrows: true });

    await expect(
      writeGovernanceAuditOrThrow(db, { action: 'vote_opened', actorUid: 'actor-1' })
    ).rejects.toBeInstanceOf(GovernanceAuditError);
  });

  it('batch path adds a set op without awaiting a write', async () => {
    const { db, setCalls } = makeDb();
    const batchSetCalls: SetCall[] = [];
    const batch: any = {
      set: (ref: any, data: any) => {
        batchSetCalls.push({ ref, data });
      },
      commit: jest.fn(async () => undefined),
    };

    const id = await writeGovernanceAuditOrThrow(
      db,
      {
        action: 'consent_request_created',
        actorUid: 'actor-1',
        targetType: 'consent_request',
        targetId: 'req-7',
      },
      { batch }
    );

    expect(id).toBe('audit-1');
    expect(batchSetCalls).toHaveLength(1);
    expect(batchSetCalls[0].ref.path).toBe('audit_logs/audit-1');
    expect(batchSetCalls[0].data.action).toBe('consent_request_created');
    expect(batchSetCalls[0].data.createdAt).toEqual(FieldValue.serverTimestamp());
    // The direct (non-batch) write path was not used and nothing was committed.
    expect(setCalls).toHaveLength(0);
    expect(batch.commit).not.toHaveBeenCalled();
  });
});
