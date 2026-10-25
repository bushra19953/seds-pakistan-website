/**
 * Shared fixtures for the Supabase workflows+missions contract suites
 * (feat/supa-wf-6). NOT a test file.
 *
 * Two shapes of the SAME logical documents:
 *  - Firestore-shaped: timestamp fields are Timestamp-like objects exposing
 *    toDate() / seconds (what the Admin SDK hands the current routes).
 *  - jsonb-shaped: what the Supabase adapter returns after a round-trip
 *    through an fs_* jsonb column — timestamps are ISO strings, everything
 *    else identical. `toJsonb()` performs exactly that conversion.
 *
 * The contract suites assert both shapes produce byte-identical outputs
 * from the current production code paths.
 */

export class FakeTimestamp {
  seconds: number;
  nanoseconds = 0;
  constructor(iso: string) {
    this.seconds = Math.floor(new Date(iso).getTime() / 1000);
  }
  toDate(): Date {
    return new Date(this.seconds * 1000);
  }
  toISOString(): string {
    return new Date(this.seconds * 1000).toISOString();
  }
}

export const ts = (iso: string) => new FakeTimestamp(iso);

/** Deep-convert a Firestore-shaped value into its jsonb round-trip shape. */
export function toJsonb<T>(value: T): T {
  if (value instanceof FakeTimestamp) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => toJsonb(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonb(v);
    return out as T;
  }
  return value;
}

export const WF_ID = 'wf_supa_1';
export const CHAPTER_ID = 'chap_ist';
export const ORIGIN = 'http://localhost';

/** One workflow, three steps, mixed statuses, primary + co-assignees. */
export function firestoreSteps(): Array<Record<string, any>> {
  return [
    {
      id: 'step1',
      workflowId: WF_ID,
      workflowTitle: 'Poster Blitz',
      title: 'Print posters',
      description: 'Print 35 sheets',
      status: 'completed',
      sequenceIndex: 0,
      points: 5,
      role: 'Volunteer',
      chapterId: CHAPTER_ID,
      projectId: null,
      assigneeId: 'u1',
      assigneeIds: ['u1', 'u2'],
      guidance: { description: 'Strategic intent text' },
      deadline: ts('2026-10-20T10:00:00.000Z'),
      individualDeadline: ts('2026-10-19T10:00:00.000Z'),
      completedAt: ts('2026-10-18T09:30:00.000Z'),
      createdAt: ts('2026-10-17T08:00:00.000Z'),
      updatedAt: ts('2026-10-18T09:30:00.000Z'),
      releasedAt: ts('2026-10-17T08:05:00.000Z'),
      isCurrentStep: false,
      estimatedDuration: 120,
    },
    {
      id: 'step2',
      workflowId: WF_ID,
      workflowTitle: 'Poster Blitz',
      title: 'Mount posters',
      description: 'Mount at 8 choke points',
      status: 'submitted-for-review',
      sequenceIndex: 1,
      points: 5,
      role: 'Volunteer',
      chapterId: CHAPTER_ID,
      projectId: null,
      assigneeId: 'u2',
      assigneeIds: ['u2'],
      deadline: ts('2026-10-20T10:00:00.000Z'),
      individualDeadline: ts('2026-10-21T10:00:00.000Z'),
      completedAt: null,
      createdAt: ts('2026-10-17T08:00:00.000Z'),
      updatedAt: ts('2026-10-19T11:00:00.000Z'),
      releasedAt: null,
      isCurrentStep: true,
      estimatedDuration: 60,
    },
    {
      id: 'step3',
      workflowId: WF_ID,
      workflowTitle: 'Poster Blitz',
      title: 'Report back',
      description: 'Post photo proof',
      status: 'changes-requested',
      sequenceIndex: 2,
      points: 10,
      role: 'Lead',
      chapterId: CHAPTER_ID,
      projectId: null,
      assigneeId: 'u1',
      assigneeIds: ['u1'],
      deadline: ts('2026-10-22T10:00:00.000Z'),
      individualDeadline: ts('2026-10-22T10:00:00.000Z'),
      completedAt: null,
      createdAt: ts('2026-10-17T08:00:00.000Z'),
      updatedAt: ts('2026-10-19T12:00:00.000Z'),
      releasedAt: null,
      isCurrentStep: false,
      estimatedDuration: 30,
    },
  ];
}

export function firestoreUsers(): Record<string, Record<string, any>> {
  return {
    u1: {
      displayName: 'Huzaifah Shujjah',
      email: 'huzaifah@example.com',
      whatsapp: '03001111111',
      whatsappNumber: '03001111111',
      chapterId: CHAPTER_ID,
      role: 'vice_president',
      position: 'National VP Operations',
      photoURL: 'https://example.com/u1.png',
    },
    u2: {
      displayName: 'Ahmed Kamran',
      email: 'ahmed@example.com',
      whatsapp: '03002222222',
      chapterId: CHAPTER_ID,
      chapterName: 'SEDS IST',
      role: 'chapter_events_chair',
      title: 'Chair Events',
      photoURL: null,
      profileImageUrl: 'https://example.com/u2.png',
    },
  };
}

export function firestoreChapters(): Record<string, Record<string, any>> {
  return { [CHAPTER_ID]: { name: 'SEDS IST' } };
}

/** Supa-side store: the same docs after a jsonb round-trip. */
export function jsonbSteps() {
  return firestoreSteps().map((s) => toJsonb(s));
}
export function jsonbUsers() {
  return toJsonb(firestoreUsers());
}
export function jsonbChapters() {
  return toJsonb(firestoreChapters());
}

/**
 * Controllable mock for '@/lib/supa' implementing the LANDED adapter API
 * (feat/supa-adapter @ 85e657f + f7defc3):
 *   useSupa(surface) — reads SUPA_SURFACES semantics (case-insensitive,
 *     comma list, '*' = all, unset/empty = OFF)
 *   getSupaClient() — null when unconfigured, never throws
 *   getSupaAdapter() — { getDoc, listDocs, countDocs, setDoc, updateDoc, deleteDoc }
 *   SupaAdapterError / SupaUnavailableError — must trigger Firestore fallback
 *
 * Suites drive it through `state` and assert on `calls`.
 */
export interface MockSupaState {
  /** raw SUPA_SURFACES value the mock flag should honour */
  surfaces: string | undefined;
  clientNull: boolean;
  adapterMode: 'ok' | 'throw';
  store: {
    tasks: Array<Record<string, any>>;
    users: Record<string, Record<string, any>>;
    chapters: Record<string, Record<string, any>>;
    roles: Record<string, Record<string, any>>;
    workflow_members: Record<string, Record<string, any>>;
  };
  calls: Array<{ method: string; collection: string; args: any[] }>;
}

export function freshMockSupaState(): MockSupaState {
  return {
    surfaces: undefined,
    clientNull: false,
    adapterMode: 'ok',
    store: { tasks: [], users: {}, chapters: {}, roles: {}, workflow_members: {} },
    calls: [],
  };
}

/** Build the jest.mock('@/lib/supa') module from a shared state object. */
export function buildMockSupaModule(state: MockSupaState) {
  class SupaAdapterError extends Error {
    code: string;
    constructor(message: string, code = 'query-failed') {
      super(message);
      this.name = 'SupaAdapterError';
      this.code = code;
    }
  }
  class SupaUnavailableError extends Error {
    constructor(message = 'Supabase client is not configured') {
      super(message);
      this.name = 'SupaUnavailableError';
    }
  }

  const parse = (raw: string | undefined): Set<string> =>
    new Set((raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

  function useSupa(surface: string): boolean {
    const set = parse(state.surfaces);
    if (set.size === 0) return false;
    if (set.has('*')) return true;
    return set.has(surface.trim().toLowerCase());
  }

  function getSupaClient(): object | null {
    return state.clientNull ? null : { __mockSupaClient: true };
  }

  function rowsFor(collection: string): Array<Record<string, any>> {
    if (collection === 'tasks') return state.store.tasks;
    const map = (state.store as any)[collection] as Record<string, any> | undefined;
    if (map) return Object.entries(map).map(([id, data]) => ({ id, ...data }));
    return [];
  }

  function guard(method: string, collection: string, args: any[]) {
    state.calls.push({ method, collection, args });
    if (state.adapterMode === 'throw') {
      throw new SupaAdapterError(`mock adapter failure in ${method} ${collection}`);
    }
    if (state.clientNull) throw new SupaUnavailableError();
  }

  function matches(row: Record<string, any>, where: any[] = []): boolean {
    return where.every(([field, op, value]: any[]) => {
      const actual = row[field];
      switch (op) {
        case '==': return actual === value;
        case '!=': return actual !== value;
        case 'in': return Array.isArray(value) && value.includes(actual);
        case 'array-contains': return Array.isArray(actual) && actual.includes(value);
        case '>': return actual > value;
        case '<': return actual < value;
        case '>=': return actual >= value;
        case '<=': return actual <= value;
        default: return true;
      }
    });
  }

  const adapter = {
    async getDoc(collection: string, id: string) {
      guard('getDoc', collection, [id]);
      const row = rowsFor(collection).find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async listDocs(collection: string, options: any = {}) {
      guard('listDocs', collection, [options]);
      let rows = rowsFor(collection).filter((r) => matches(r, options?.where || []));
      const order = options?.orderBy;
      if (order) {
        const specs = Array.isArray(order) ? order : [order];
        for (const spec of [...specs].reverse()) {
          const field = typeof spec === 'string' ? spec : spec.field;
          const dir = typeof spec === 'string' ? 'asc' : spec.direction || 'asc';
          rows = [...rows].sort((a, b) => {
            const c = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
            return dir === 'desc' ? -c : c;
          });
        }
      }
      if (typeof options?.limit === 'number') rows = rows.slice(0, options.limit);
      return rows.map((r) => ({ ...r }));
    },
    async countDocs(collection: string, where: any[] = []) {
      guard('countDocs', collection, [where]);
      return rowsFor(collection).filter((r) => matches(r, where)).length;
    },
    async setDoc() { throw new SupaAdapterError('writes are out of scope for read contract tests', 'unsupported'); },
    async updateDoc() { throw new SupaAdapterError('writes are out of scope for read contract tests', 'unsupported'); },
    async deleteDoc() { throw new SupaAdapterError('writes are out of scope for read contract tests', 'unsupported'); },
  };

  return {
    useSupa,
    parseSupaSurfaces: parse,
    getSupaClient,
    getSupaAdapter: () => adapter,
    createSupaAdapter: () => adapter,
    SupaAdapterError,
    SupaUnavailableError,
  };
}
