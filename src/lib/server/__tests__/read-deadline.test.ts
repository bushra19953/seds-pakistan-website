/**
 * @jest-environment node
 *
 * App-level Firestore read deadlines (perf program, 2026-10-30).
 *
 * WHY THIS EXISTS: the app set NO deadline of its own on Firestore
 * work, so the GAPIC defaults were the effective timeout (60 s per
 * RPC attempt, 600 s total retry budget). On the single free-tier
 * instance, one degraded read that retry-storms for tens of seconds
 * pins the process and every request behind it queues into the
 * edge's 502 (proven live 2026-10-30; see
 * ~/workspace/known_issues/site_502_diagnosis_2026-10-30.md Q5
 * mechanism 3). The consent-picker fix proved the cure at one site
 * (parallel arms + an 8 s per-arm race + a truthful 503); this module
 * is that pattern generalized for every server read path.
 *
 * These tests pin the helper contract with REAL timers and small
 * budgets: pass-through on success, the wrapped error rethrown
 * untouched, a ReadDeadlineError when the read outlives its budget,
 * and a shared budget that refuses to issue further reads once it is
 * spent.
 */
import {
  ReadDeadlineError,
  createReadBudget,
  withReadDeadline,
} from '@/lib/server/read-deadline';

const hang = () => new Promise<never>(() => undefined);

describe('withReadDeadline', () => {
  it('passes the read result through when it settles in time', async () => {
    await expect(
      withReadDeadline('test:fast', 1_000, async () => ({ ok: true })),
    ).resolves.toEqual({ ok: true });
  });

  it('rethrows the read error untouched when it fails in time', async () => {
    const boom = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
    await expect(
      withReadDeadline('test:fail', 1_000, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('rejects with ReadDeadlineError when the read never settles', async () => {
    const err = await withReadDeadline('test:hang', 30, hang).catch((e) => e);
    expect(err).toBeInstanceOf(ReadDeadlineError);
    expect(err.name).toBe('ReadDeadlineError');
    expect(err.label).toBe('test:hang');
    expect(err.timeoutMs).toBe(30);
    expect(err.message).toContain('test:hang');
    expect(err.message).toContain('30ms');
  });

  it('a late rejection from the losing read does not surface', async () => {
    const late = new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error('late boom')), 40),
    );
    await expect(withReadDeadline('test:late', 10, () => late)).rejects.toBeInstanceOf(
      ReadDeadlineError,
    );
    // Let the loser settle; the race subscription must consume it
    // (an unhandled rejection would fail this test run on its own).
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

describe('createReadBudget', () => {
  it('shares one deadline across sequential reads', async () => {
    const budget = createReadBudget(50);
    await expect(budget.withBudget('b:first', async () => 'one')).resolves.toBe('one');
    expect(budget.remainingMs()).toBeLessThanOrEqual(50);
    expect(budget.remainingMs()).toBeGreaterThan(0);
  });

  it('a hung read consumes the budget; the next read is refused WITHOUT being issued', async () => {
    const budget = createReadBudget(30);
    await expect(budget.withBudget('b:hang', hang)).rejects.toBeInstanceOf(ReadDeadlineError);
    expect(budget.remainingMs()).toBe(0);
    const issued = jest.fn(async () => 'never');
    await expect(budget.withBudget('b:after', issued)).rejects.toBeInstanceOf(ReadDeadlineError);
    expect(issued).not.toHaveBeenCalled();
  });

  it('parallel reads race the same remaining budget', async () => {
    const budget = createReadBudget(40);
    const [a, b] = await Promise.allSettled([
      budget.withBudget('b:p1', hang),
      budget.withBudget('b:p2', hang),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    if (a.status === 'rejected') expect(a.reason).toBeInstanceOf(ReadDeadlineError);
    if (b.status === 'rejected') expect(b.reason).toBeInstanceOf(ReadDeadlineError);
  });
});
