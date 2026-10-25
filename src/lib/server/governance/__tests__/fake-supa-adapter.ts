// In-memory fake of the Supabase adapter contract (src/lib/supa) for
// governance seam tests. NOT a test file (no .test. suffix).
//
// Faithful in the ways the seams depend on:
// - reads return flattened docs ({ id, ...data }) or null;
// - writes store Dates as canonical ISO strings (the real adapter's
//   normalizeForStorage ruling), so seam date revival is exercised
//   exactly as against PostgREST jsonb;
// - listDocs honours where (== / in / array-contains), orderBy with
//   the orderBy-existence rule + id tiebreak, and limit;
// - subcollection paths ('motions/{id}/tokenIssueLog',
//   'governance_votes/{id}/ballots') are keyed by the full path.
// Setting `failAll = true` makes every call throw, for fallback tests.

import type { GovSupaAdapter } from "../supa-shared";

type DocData = Record<string, unknown>;

function toStored(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toStored);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.toDate === "function") {
      try {
        return (rec.toDate as () => Date)().toISOString();
      } catch {
        return value;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (v !== undefined) out[k] = toStored(v);
    }
    return out;
  }
  return value;
}

function clone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((v) => clone(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clone(v);
  return out as T;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class FakeSupaAdapter implements GovSupaAdapter {
  failAll = false;
  private store = new Map<string, Map<string, DocData>>();

  private col(path: string): Map<string, DocData> {
    let c = this.store.get(path);
    if (!c) {
      c = new Map();
      this.store.set(path, c);
    }
    return c;
  }

  private guard() {
    if (this.failAll) throw new Error("fake-supa: adapter unavailable");
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, clone(toStored(data) as DocData));
  }

  raw(path: string, id: string): DocData | undefined {
    const d = this.store.get(path)?.get(id);
    return d === undefined ? undefined : clone(d);
  }

  all(path: string): Array<{ id: string; data: DocData }> {
    return [...(this.store.get(path)?.entries() ?? [])].map(([id, data]) => ({
      id,
      data: clone(data),
    }));
  }

  async getDoc(collectionPath: string, id: string) {
    this.guard();
    const data = this.store.get(collectionPath)?.get(id);
    return data === undefined ? null : { id, ...clone(data) };
  }

  async listDocs(
    collectionPath: string,
    options: {
      where?: Array<[string, string, unknown]>;
      orderBy?: string | { field: string; direction?: "asc" | "desc" } | Array<{ field: string; direction?: "asc" | "desc" }>;
      limit?: number;
    } = {},
  ) {
    this.guard();
    let rows = [...(this.store.get(collectionPath)?.entries() ?? [])].map(([id, data]) => ({
      id,
      data: clone(data),
    }));
    for (const [field, op, value] of options.where ?? []) {
      rows = rows.filter((r) => {
        const actual = r.data[field];
        if (op === "==") return actual === value;
        if (op === "in") return Array.isArray(value) && value.includes(actual);
        if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
        throw new Error(`fake-supa: unsupported op ${op}`);
      });
    }
    const orders = (
      options.orderBy === undefined
        ? []
        : typeof options.orderBy === "string"
          ? [{ field: options.orderBy, direction: "asc" as const }]
          : Array.isArray(options.orderBy)
            ? options.orderBy
            : [options.orderBy]
    ).map((o) => ({ field: o.field, direction: o.direction ?? "asc" }));
    for (const order of orders) {
      if (order.field !== "id") {
        rows = rows.filter((r) => Object.prototype.hasOwnProperty.call(r.data, order.field));
      }
    }
    if (orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const order of orders) {
          const c =
            order.field === "id"
              ? compare(a.id, b.id)
              : compare(a.data[order.field], b.data[order.field]);
          if (c !== 0) return order.direction === "desc" ? -c : c;
        }
        return compare(a.id, b.id);
      });
    }
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map((r) => ({ id: r.id, ...r.data }));
  }

  async countDocs(collectionPath: string, where?: Array<[string, string, unknown]>) {
    const docs = await this.listDocs(collectionPath, { where: where as never });
    return docs.length;
  }

  async setDoc(
    collectionPath: string,
    id: string,
    data: DocData,
    options?: { merge?: boolean },
  ) {
    this.guard();
    const col = this.col(collectionPath);
    const stored = toStored(data) as DocData;
    if (options?.merge && col.has(id)) {
      col.set(id, { ...col.get(id), ...clone(stored) });
    } else {
      col.set(id, clone(stored));
    }
    return { id, ...clone(col.get(id)!) };
  }

  async updateDoc(collectionPath: string, id: string, updates: DocData) {
    this.guard();
    const col = this.col(collectionPath);
    const existing = col.get(id);
    if (!existing) throw new Error(`fake-supa: updateDoc on missing ${collectionPath}/${id}`);
    col.set(id, { ...existing, ...clone(toStored(updates) as DocData) });
    return { id, ...clone(col.get(id)!) };
  }

  async deleteDoc(collectionPath: string, id: string) {
    this.guard();
    this.store.get(collectionPath)?.delete(id);
  }
}

export function createFakeSupaAdapter(): FakeSupaAdapter {
  return new FakeSupaAdapter();
}
