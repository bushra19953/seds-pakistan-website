/**
 * @jest-environment node
 *
 * rpc-tx.test.ts — adapter rpc()/tx() contracts (cutover foundation
 * wave). The transport is the recording FakeClient, exactly the seam
 * the existing adapter tests mock: rpc assertions are on the function
 * name + argument bag the adapter hands the client, and on the error
 * mapping back. ZERO live calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupaAdapter,
  isTxFunctionName,
  txFunctionName,
  IDEMPOTENCY_ARG,
  SupaAdapterError,
  SupaUnavailableError,
  SupaTimestamp,
  type SupaAdapter,
} from '@/lib/supa/adapter';
import { FakeClient } from './fake-client';

function adapterWith(fake: FakeClient) {
  return createSupaAdapter(fake as unknown as SupabaseClient);
}

describe('rpc()', () => {
  it('calls the named function with the args as the body and returns its data', async () => {
    const fake = new FakeClient(
      {},
      { apply_points_award: { data: [{ applied: true, duplicate: false, new_total_points: 42 }] } },
    );
    const result = await adapterWith(fake).rpc('apply_points_award', {
      p_ledger_id: 'pa_T1_U1_COMPLETION',
      p_points: 10,
    });
    expect(result).toEqual([{ applied: true, duplicate: false, new_total_points: 42 }]);
    expect(fake.rpcCalls).toEqual([
      ['rpc', 'apply_points_award', { p_ledger_id: 'pa_T1_U1_COMPLETION', p_points: 10 }],
    ]);
    expect(fake.fromCalls).toEqual([]); // rpc never touches a table chain
  });

  it('defaults args to an empty object', async () => {
    const fake = new FakeClient({}, { ping: { data: 'pong' } });
    await expect(adapterWith(fake).rpc('ping')).resolves.toBe('pong');
    expect(fake.rpcCalls).toEqual([['rpc', 'ping', {}]]);
  });

  it('returns a scalar result typed as given', async () => {
    const fake = new FakeClient({}, { count_votes: { data: 7 } });
    await expect(adapterWith(fake).rpc<number>('count_votes', { p_vote_id: 'V1' })).resolves.toBe(7);
  });

  it('maps a PostgREST error to SupaAdapterError with code query-failed', async () => {
    const fake = new FakeClient(
      {},
      { boom: { error: { message: 'function boom() does not exist' } } },
    );
    const err = await adapterWith(fake)
      .rpc('boom')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupaAdapterError);
    expect((err as SupaAdapterError).code).toBe('query-failed');
    expect((err as SupaAdapterError).message).toBe(
      'rpc boom: function boom() does not exist',
    );
  });

  it('normalizes Date / Timestamp-like args to ISO strings (the storage ruling)', async () => {
    const fake = new FakeClient({}, { stamp_it: { data: null } });
    await adapterWith(fake).rpc('stamp_it', {
      p_at: new Date('2026-10-26T01:00:00.000Z'),
      p_nested: { when: { toDate: () => new Date('2026-10-26T02:00:00.000Z') } },
      p_plain: 'unchanged',
      p_num: 3,
    });
    expect(fake.rpcCalls).toEqual([
      [
        'rpc',
        'stamp_it',
        {
          p_at: '2026-10-26T01:00:00.000Z',
          p_nested: { when: '2026-10-26T02:00:00.000Z' },
          p_plain: 'unchanged',
          p_num: 3,
        },
      ],
    ]);
  });

  it('rehydrates dumped-timestamp shapes in results, like a document read', async () => {
    const fake = new FakeClient(
      {},
      { last_cast: { data: { cast_at: { _seconds: 1000, _nanoseconds: 500_000_000 } } } },
    );
    const result = await adapterWith(fake).rpc<{ cast_at: SupaTimestamp }>('last_cast');
    expect(result.cast_at).toBeInstanceOf(SupaTimestamp);
    expect(result.cast_at.toMillis()).toBe(1_000_500);
  });

  it('throws SupaUnavailableError when no client is configured', async () => {
    const adapter = createSupaAdapter(null);
    await expect(adapter.rpc('anything')).rejects.toBeInstanceOf(SupaUnavailableError);
    await expect(adapter.tx('tx_events_register')).rejects.toBeInstanceOf(
      SupaUnavailableError,
    );
  });

  it('throws SupaUnavailableError when the client predates the rpc amendment', async () => {
    const tableOnly = { from: () => { throw new Error('must not be called'); } };
    const adapter = createSupaAdapter(tableOnly as unknown as SupabaseClient);
    await expect(adapter.rpc('anything')).rejects.toBeInstanceOf(SupaUnavailableError);
  });
});

describe('tx() naming convention', () => {
  it('accepts tx_<surface>_<op> names', () => {
    expect(isTxFunctionName('tx_events_register_paid')).toBe(true);
    expect(isTxFunctionName('tx_elections_cast_ballot')).toBe(true);
    expect(isTxFunctionName('tx_motions_cast_vote')).toBe(true);
  });

  it('rejects non-conforming names', () => {
    expect(isTxFunctionName('apply_points_award')).toBe(false);
    expect(isTxFunctionName('tx_')).toBe(false);
    expect(isTxFunctionName('tx_Events_Register')).toBe(false);
    expect(isTxFunctionName('tx_events-register')).toBe(false);
    expect(isTxFunctionName('events_register_paid')).toBe(false);
  });

  it('txFunctionName builds the conventional name and sanitizes segments', () => {
    expect(txFunctionName('events', 'register_paid')).toBe('tx_events_register_paid');
    expect(txFunctionName('Elections', 'Cast Ballot')).toBe('tx_elections_cast_ballot');
    expect(() => txFunctionName(' ', ' ')).toThrow(SupaAdapterError);
  });

  it('tx() refuses a non-conventional name before any transport call', async () => {
    const fake = new FakeClient();
    const err = await adapterWith(fake)
      .tx('apply_points_award')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupaAdapterError);
    expect((err as SupaAdapterError).code).toBe('bad-tx-name');
    expect(fake.rpcCalls).toEqual([]);
  });
});

describe('tx() idempotency key pass-through', () => {
  it('injects options.idempotencyKey as the p_idempotency_key argument', async () => {
    const fake = new FakeClient({}, { tx_events_register_paid: { data: { applied: true } } });
    await adapterWith(fake).tx(
      'tx_events_register_paid',
      { p_event_id: 'E1' },
      { idempotencyKey: 'pay:E1:U1:attempt-origin-1' },
    );
    expect(fake.rpcCalls).toEqual([
      [
        'rpc',
        'tx_events_register_paid',
        { p_event_id: 'E1', [IDEMPOTENCY_ARG]: 'pay:E1:U1:attempt-origin-1' },
      ],
    ]);
  });

  it('passes an args-supplied key through untouched when options omit it', async () => {
    const fake = new FakeClient({}, { tx_motions_cast_vote: { data: null } });
    await adapterWith(fake).tx('tx_motions_cast_vote', {
      p_vote_id: 'V1',
      [IDEMPOTENCY_ARG]: 'vote:V1:U1',
    });
    expect(fake.rpcCalls[0][2]).toEqual({ p_vote_id: 'V1', [IDEMPOTENCY_ARG]: 'vote:V1:U1' });
  });

  it('accepts the same key in both places, and rejects conflicting keys loudly', async () => {
    const fake = new FakeClient({}, { tx_motions_cast_vote: { data: null } });
    const adapter = adapterWith(fake);
    await expect(
      adapter.tx(
        'tx_motions_cast_vote',
        { [IDEMPOTENCY_ARG]: 'k1' },
        { idempotencyKey: 'k1' },
      ),
    ).resolves.toBeNull();
    const err = await adapter
      .tx('tx_motions_cast_vote', { [IDEMPOTENCY_ARG]: 'k1' }, { idempotencyKey: 'k2' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupaAdapterError);
    expect((err as SupaAdapterError).code).toBe('bad-tx-args');
  });

  it('maps tx transport errors through the rpc error shape', async () => {
    const fake = new FakeClient(
      {},
      { tx_events_register_paid: { error: { message: 'deadlock detected' } } },
    );
    const err = await adapterWith(fake)
      .tx('tx_events_register_paid', { p_event_id: 'E1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupaAdapterError);
    expect((err as SupaAdapterError).code).toBe('query-failed');
    expect((err as SupaAdapterError).message).toBe(
      'rpc tx_events_register_paid: deadlock detected',
    );
  });
});

/* ------------------------------------------------ demonstration consumer */

/**
 * Demonstration tx consumer (test-only; the real consumer ships in the
 * events wave): a paid registration expressed as ONE tx call. Capacity
 * check, registration write, and seat counter are inside the Postgres
 * function — the consumer's whole job is the call shape below.
 */
async function registerPaidViaTx(
  adapter: SupaAdapter,
  input: { eventId: string; userId: string; idempotencyKey: string },
): Promise<{ applied: boolean; duplicate: boolean }> {
  return adapter.tx<{ applied: boolean; duplicate: boolean }>(
    txFunctionName('events', 'register_paid'),
    { p_event_id: input.eventId, p_user_id: input.userId },
    { idempotencyKey: input.idempotencyKey },
  );
}

describe('demonstration tx consumer (events paid registration shape)', () => {
  it('issues exactly one rpc call: conventional name, args, idempotency key', async () => {
    const fake = new FakeClient(
      {},
      { tx_events_register_paid: { data: { applied: true, duplicate: false } } },
    );
    const result = await registerPaidViaTx(adapterWith(fake), {
      eventId: 'E1',
      userId: 'U1',
      idempotencyKey: 'pay:E1:U1:origin-1',
    });
    expect(result).toEqual({ applied: true, duplicate: false });
    expect(fake.rpcCalls).toEqual([
      [
        'rpc',
        'tx_events_register_paid',
        {
          p_event_id: 'E1',
          p_user_id: 'U1',
          [IDEMPOTENCY_ARG]: 'pay:E1:U1:origin-1',
        },
      ],
    ]);
    expect(fake.fromCalls).toEqual([]); // no read-check-write across adapter calls
  });

  it('a retry with the same key replays the same call shape (function dedupes)', async () => {
    const fake = new FakeClient(
      {},
      { tx_events_register_paid: { data: { applied: false, duplicate: true } } },
    );
    const adapter = adapterWith(fake);
    const input = { eventId: 'E1', userId: 'U1', idempotencyKey: 'pay:E1:U1:origin-1' };
    await registerPaidViaTx(adapter, input);
    const retry = await registerPaidViaTx(adapter, input);
    expect(retry).toEqual({ applied: false, duplicate: true });
    expect(fake.rpcCalls).toHaveLength(2);
    expect(fake.rpcCalls[0]).toEqual(fake.rpcCalls[1]);
  });
});
