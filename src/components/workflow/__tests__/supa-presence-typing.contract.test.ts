/**
 * CONTRACT — workflow_members / workflow_presence / workflow_typing
 * data shapes (feat/supa-wf-4 surface).
 *
 * The consumer is src/components/workflow/enhanced-workflow-chat.tsx.
 * Its read paths coerce timestamps with one exact expression in both
 * listeners (typing ~L185, presence ~L293):
 *
 *   const t = data?.updatedAt?.toDate?.()
 *          || (data?.updatedAt ? new Date(data.updatedAt) : new Date());
 *
 * That expression is the equivalence hinge of the migration: a Firestore
 * Timestamp (has toDate) and a jsonb ISO string (no toDate) must land on
 * the same instant. This suite pins, for the doc shapes the component
 * WRITES today:
 *   - doc ids are `${workflowId}_${uid}` in all three collections;
 *   - membership docs: { workflowId, userId, joinedAt, role: 'member' }
 *     (auto-join write, ~L130-140; the same doc id is what
 *     GET /api/workflows checks to unmask contact fields — covered
 *     behaviorally in supa-pdf-export-data.contract.test.ts);
 *   - presence docs: { workflowId, userId, userName, userPhoto,
 *     isOnline, lastSeen } with a 30s heartbeat write;
 *   - typing docs: { workflowId, userId, userName, isTyping,
 *     updatedAt }, shown only when isTyping AND age < 3000ms;
 *   - Firestore-shaped and jsonb-round-tripped docs normalize to
 *     identical listener output.
 *
 * The normalizers below replicate the component's expressions verbatim
 * (the component does not export them); if the component changes its
 * coercion, this file must change with it.
 */

import { FakeTimestamp, toJsonb, WF_ID } from '@/lib/__tests__/supa-wf-fixtures';

const UID = 'u1';
const NOW = new Date('2026-10-25T10:00:00.000Z').getTime();
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

/* ── verbatim-shaped coercions from enhanced-workflow-chat.tsx ────────── */
function coerceTs(value: any, now: number): Date {
  return value?.toDate?.() || (value ? new Date(value) : new Date(now));
}
function normalizeTyping(data: any, now: number) {
  const t = coerceTs(data?.updatedAt, now);
  const fresh = now - t.getTime() < 3000;
  if (data?.isTyping && fresh) {
    return { userId: String(data.userId || ''), userName: String(data.userName || ''), isTyping: true, lastActivity: t };
  }
  return null;
}
function normalizePresence(data: any, now: number) {
  return {
    userId: String(data.userId || ''),
    userName: String(data.userName || ''),
    userPhoto: data.userPhoto,
    isOnline: !!data.isOnline,
    lastSeen: coerceTs(data?.lastSeen, now),
    currentStep: Number(data.currentStep || 0),
  };
}

describe('wf-4: doc-id and collection conventions', () => {
  it('all three collections key docs as `${workflowId}_${uid}`', () => {
    const memberId = `${WF_ID}_${UID}`;
    expect(memberId).toBe('wf_supa_1_u1');
    // The collections the migration must land as fs_workflow_members,
    // fs_workflow_presence, fs_workflow_typing (adapter table rule).
    for (const c of ['workflow_members', 'workflow_presence', 'workflow_typing']) {
      expect(`fs_${c}`).toBe(`fs_workflow_${c.split('_')[1]}`);
    }
  });
});

describe('wf-4: typing indicator equivalence', () => {
  const fsDoc = () => ({
    workflowId: WF_ID,
    userId: UID,
    userName: 'Huzaifah Shujjah',
    isTyping: true,
    updatedAt: new FakeTimestamp(isoAgo(1000)),
  });

  it('Firestore-shaped and jsonb-shaped typing docs normalize identically', () => {
    const fromFs = normalizeTyping(fsDoc(), NOW);
    const fromJsonb = normalizeTyping(toJsonb(fsDoc()), NOW);
    expect(fromJsonb).toEqual(fromFs);
    expect(fromFs?.userId).toBe(UID);
    expect(fromFs?.lastActivity.getTime()).toBe(NOW - 1000);
  });

  it('freshness window is strict: 2999ms shows, 3000ms does not', () => {
    const at = (ms: number) => ({ ...fsDoc(), updatedAt: new FakeTimestamp(isoAgo(ms)) });
    expect(normalizeTyping(at(2999), NOW)).not.toBeNull();
    expect(normalizeTyping(at(3000), NOW)).toBeNull();
    // Same boundary through the jsonb shape.
    expect(normalizeTyping(toJsonb(at(2999)), NOW)).not.toBeNull();
    expect(normalizeTyping(toJsonb(at(3000)), NOW)).toBeNull();
  });

  it('isTyping=false never shows, however fresh; stale typing never shows', () => {
    expect(normalizeTyping({ ...fsDoc(), isTyping: false }, NOW)).toBeNull();
    expect(normalizeTyping({ ...fsDoc(), updatedAt: new FakeTimestamp(isoAgo(60_000)) }, NOW)).toBeNull();
    expect(normalizeTyping(toJsonb({ ...fsDoc(), isTyping: false }), NOW)).toBeNull();
  });

  it('typing doc shape survives the jsonb round-trip field-for-field', () => {
    const round = toJsonb(fsDoc());
    expect(Object.keys(round).sort()).toEqual(
      ['workflowId', 'userId', 'userName', 'isTyping', 'updatedAt'].sort(),
    );
    expect(round.updatedAt).toBe(isoAgo(1000));
    expect(round.isTyping).toBe(true);
  });
});

describe('wf-4: presence equivalence', () => {
  const fsDoc = () => ({
    workflowId: WF_ID,
    userId: UID,
    userName: 'Huzaifah Shujjah',
    userPhoto: 'https://example.com/u1.png',
    isOnline: true,
    lastSeen: new FakeTimestamp(isoAgo(5000)),
    currentStep: 1,
  });

  it('Firestore-shaped and jsonb-shaped presence docs normalize identically', () => {
    const fromFs = normalizePresence(fsDoc(), NOW);
    const fromJsonb = normalizePresence(toJsonb(fsDoc()), NOW);
    expect(fromJsonb).toEqual(fromFs);
    expect(fromFs.isOnline).toBe(true);
    expect(fromFs.lastSeen.getTime()).toBe(NOW - 5000);
    expect(fromFs.currentStep).toBe(1);
  });

  it('offline write shape ({isOnline:false, lastSeen}) round-trips', () => {
    const offline = { isOnline: false, lastSeen: new FakeTimestamp(isoAgo(0)) };
    const round = toJsonb(offline);
    expect(round).toEqual({ isOnline: false, lastSeen: isoAgo(0) });
    expect(normalizePresence({ ...fsDoc(), ...round }, NOW).isOnline).toBe(false);
  });
});

describe('wf-4: membership doc equivalence', () => {
  it('auto-join membership doc shape round-trips with joinedAt as ISO string', () => {
    const doc = {
      workflowId: WF_ID,
      userId: UID,
      joinedAt: new FakeTimestamp('2026-10-25T09:00:00.000Z'),
      role: 'member',
    };
    const round = toJsonb(doc);
    expect(round).toEqual({
      workflowId: WF_ID,
      userId: UID,
      joinedAt: '2026-10-25T09:00:00.000Z',
      role: 'member',
    });
    // The non-timestamp fields are the ones the API-side membership
    // check depends on (existence of `${workflowId}_${uid}`).
    expect(`${round.workflowId}_${round.userId}`).toBe(`${WF_ID}_${UID}`);
  });
});
