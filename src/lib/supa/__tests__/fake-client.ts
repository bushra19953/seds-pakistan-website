/**
 * Recording fake for the supa adapter's structural client seam.
 *
 * Implements the exact builder surface adapter.ts uses, records every call
 * (method + args) per chain, and resolves with per-table canned outcomes.
 * No network, no real Supabase client.
 */

export type RecordedCall = [method: string, ...args: unknown[]];

export interface FakeOutcome {
  /** Rows resolved when a select chain is awaited (listDocs). */
  rows?: Array<{ id: string; data: unknown }>;
  /** Row resolved by maybeSingle (getDoc); null means "not found". */
  single?: { id: string; data: unknown } | null;
  /** Count resolved when a head/count select chain is awaited. */
  count?: number | null;
  /** Error applied to select/update/delete chains. */
  error?: { message: string } | null;
  /** Error applied to upsert. */
  upsertError?: { message: string } | null;
}

const CHAIN_METHODS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'is',
  'not',
  'filter',
  'order',
  'limit',
] as const;

export class FakeChain {
  readonly calls: RecordedCall[] = [];

  constructor(
    readonly kind: 'select' | 'update' | 'delete',
    private readonly outcome: FakeOutcome,
  ) {
    for (const method of CHAIN_METHODS) {
      (this as unknown as Record<string, unknown>)[method] = (
        ...args: unknown[]
      ) => {
        this.calls.push([method, ...args]);
        return this;
      };
    }
  }

  maybeSingle(): Promise<{
    data: { id: string; data: unknown } | null;
    error: { message: string } | null;
    count: null;
  }> {
    this.calls.push(['maybeSingle']);
    return Promise.resolve({
      data: this.outcome.single ?? null,
      error: this.outcome.error ?? null,
      count: null,
    });
  }

  then<TResult1, TResult2>(
    onFulfilled?: (
      value: {
        data: Array<{ id: string; data: unknown }>;
        error: { message: string } | null;
        count: number | null;
      },
    ) => TResult1 | PromiseLike<TResult1>,
    onRejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({
      data: this.outcome.rows ?? [],
      error: this.outcome.error ?? null,
      count: this.outcome.count ?? null,
    }).then(onFulfilled, onRejected);
  }
}

export class FakeTable {
  readonly chains: FakeChain[] = [];
  readonly selectCalls: RecordedCall[] = [];
  readonly upsertCalls: RecordedCall[] = [];
  readonly updateCalls: RecordedCall[] = [];

  constructor(private readonly outcome: FakeOutcome) {}

  select(...args: unknown[]): FakeChain {
    this.selectCalls.push(['select', ...args]);
    const chain = new FakeChain('select', this.outcome);
    this.chains.push(chain);
    return chain;
  }

  upsert(...args: unknown[]): Promise<{
    data: null;
    error: { message: string } | null;
    count: null;
  }> {
    this.upsertCalls.push(['upsert', ...args]);
    return Promise.resolve({
      data: null,
      error: this.outcome.upsertError ?? null,
      count: null,
    });
  }

  update(...args: unknown[]): FakeChain {
    this.updateCalls.push(['update', ...args]);
    const chain = new FakeChain('update', this.outcome);
    this.chains.push(chain);
    return chain;
  }

  delete(): FakeChain {
    const chain = new FakeChain('delete', this.outcome);
    this.chains.push(chain);
    return chain;
  }

  /** All filter/order/limit calls across every chain, in order. */
  allCalls(): RecordedCall[] {
    return this.chains.flatMap((c) => c.calls);
  }
}

export interface FakeRpcOutcome {
  data?: unknown;
  error?: { message: string } | null;
}

export class FakeClient {
  readonly tables = new Map<string, FakeTable>();
  readonly fromCalls: string[] = [];
  readonly rpcCalls: RecordedCall[] = [];

  constructor(
    private readonly outcomes: Record<string, FakeOutcome> = {},
    private readonly rpcOutcomes: Record<string, FakeRpcOutcome> = {},
  ) {}

  /** Recording fake for the client's rpc method (adapter rpc()/tx()). */
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null; count: null }> {
    this.rpcCalls.push(['rpc', fn, args ?? {}]);
    const outcome = this.rpcOutcomes[fn] ?? {};
    return Promise.resolve({
      data: outcome.data ?? null,
      error: outcome.error ?? null,
      count: null,
    });
  }

  from(table: string): FakeTable {
    this.fromCalls.push(table);
    let existing = this.tables.get(table);
    if (!existing) {
      existing = new FakeTable(this.outcomes[table] ?? {});
      this.tables.set(table, existing);
    }
    return existing;
  }

  table(name: string): FakeTable {
    const t = this.tables.get(name);
    if (!t) throw new Error(`fake: table ${name} was never requested`);
    return t;
  }
}
