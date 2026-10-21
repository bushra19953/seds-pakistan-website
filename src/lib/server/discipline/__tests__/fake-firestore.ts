/**
 * fake-firestore.ts - in-memory Firestore fake for discipline tests.
 *
 * Supports the subset of the Admin SDK the discipline services use:
 * collection/doc refs, get/set/update/delete, where/orderBy/limit
 * queries, batches, and runTransaction with BUFFERED writes (ops apply
 * only when the callback resolves, so a throw mid-transaction rolls
 * back - which is what spec test T18 asserts).
 */

type DocData = Record<string, any>;

function normalize(v: any): any {
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    if (v instanceof Date) return v.getTime();
    return v;
}

function matches(data: DocData, field: string, op: string, value: any): boolean {
    const raw = data[field];
    const a = normalize(raw);
    const b = normalize(value);
    switch (op) {
        case '==':
            return a === b || (a == null && b == null);
        case '!=':
            return a !== b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case 'in':
            return Array.isArray(value) && value.map(normalize).includes(a);
        case 'array-contains':
            return Array.isArray(raw) && raw.map(normalize).includes(b);
        default:
            throw new Error(`fake-firestore: unsupported op ${op}`);
    }
}

export class FakeDocRef {
    constructor(
        public store: Map<string, Map<string, DocData>>,
        public path: string,
    ) {}
    get id(): string {
        return this.path.split('/').pop() as string;
    }
    collection(name: string): FakeCollectionRef {
        return new FakeCollectionRef(this.store, `${this.path}/${name}`);
    }
    private colPath(): string {
        return this.path.split('/').slice(0, -1).join('/');
    }
    async get(): Promise<any> {
        const col = this.store.get(this.colPath());
        const data = col?.get(this.id);
        return {
            id: this.id,
            exists: data !== undefined,
            data: () => (data ? { ...data } : undefined),
            ref: this,
        };
    }
    async set(data: DocData, opts?: { merge?: boolean }): Promise<void> {
        const colPath = this.colPath();
        if (!this.store.has(colPath)) this.store.set(colPath, new Map());
        const col = this.store.get(colPath) as Map<string, DocData>;
        if (opts?.merge && col.has(this.id)) {
            col.set(this.id, { ...col.get(this.id), ...data });
        } else {
            col.set(this.id, { ...data });
        }
    }
    async update(data: DocData): Promise<void> {
        const colPath = this.colPath();
        const col = this.store.get(colPath);
        if (!col || !col.has(this.id)) throw new Error(`fake-firestore: update on missing doc ${this.path}`);
        col.set(this.id, { ...(col.get(this.id) as DocData), ...data });
    }
    async delete(): Promise<void> {
        this.store.get(this.colPath())?.delete(this.id);
    }
}

interface Filter {
    field: string;
    op: string;
    value: any;
}

export class FakeCollectionRef {
    private filters: Filter[] = [];
    private order: { field: string; dir: 'asc' | 'desc' } | null = null;
    private limitN: number | null = null;
    constructor(
        public store: Map<string, Map<string, DocData>>,
        public path: string,
    ) {}
    doc(id?: string): FakeDocRef {
        const docId = id || `auto_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
        return new FakeDocRef(this.store, `${this.path}/${docId}`);
    }
    async add(data: DocData): Promise<FakeDocRef> {
        const ref = this.doc();
        await ref.set(data);
        return ref;
    }
    where(field: string, op: string, value: any): this {
        this.filters.push({ field, op, value });
        return this;
    }
    orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): this {
        this.order = { field, dir };
        return this;
    }
    limit(n: number): this {
        this.limitN = n;
        return this;
    }
    async get(): Promise<any> {
        const col = this.store.get(this.path);
        let entries: Array<[string, DocData]> = col ? Array.from(col.entries()) : [];
        for (const f of this.filters) {
            entries = entries.filter(([, data]) => matches(data, f.field, f.op, f.value));
        }
        if (this.order) {
            const { field, dir } = this.order;
            entries.sort((a, b) => {
                const av = normalize(a[1][field]);
                const bv = normalize(b[1][field]);
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                return dir === 'desc' ? -cmp : cmp;
            });
        }
        if (this.limitN != null) entries = entries.slice(0, this.limitN);
        const docs = entries.map(([id, data]) => ({
            id,
            exists: true,
            data: () => ({ ...data }),
            ref: new FakeDocRef(this.store, `${this.path}/${id}`),
        }));
        return {
            docs,
            empty: docs.length === 0,
            size: docs.length,
            forEach: (cb: (d: any) => void) => docs.forEach(cb),
        };
    }
}

class FakeTransaction {
    public ops: Array<() => Promise<void>> = [];
    constructor(private store: Map<string, Map<string, DocData>>) {}
    async get(ref: FakeDocRef): Promise<any> {
        return ref.get();
    }
    set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }): this {
        this.ops.push(() => ref.set(data, opts));
        return this;
    }
    update(ref: FakeDocRef, data: DocData): this {
        this.ops.push(() => ref.update(data));
        return this;
    }
    delete(ref: FakeDocRef): this {
        this.ops.push(() => ref.delete());
        return this;
    }
}

class FakeBatch {
    private ops: Array<() => Promise<void>> = [];
    set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }): this {
        this.ops.push(() => ref.set(data, opts));
        return this;
    }
    update(ref: FakeDocRef, data: DocData): this {
        this.ops.push(() => ref.update(data));
        return this;
    }
    delete(ref: FakeDocRef): this {
        this.ops.push(() => ref.delete());
        return this;
    }
    async commit(): Promise<void> {
        for (const op of this.ops) await op();
    }
}

export class FakeFirestore {
    public store = new Map<string, Map<string, DocData>>();
    collection(path: string): FakeCollectionRef {
        return new FakeCollectionRef(this.store, path);
    }
    doc(path: string): FakeDocRef {
        return new FakeDocRef(this.store, path);
    }
    batch(): FakeBatch {
        return new FakeBatch();
    }
    async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
        const tx = new FakeTransaction(this.store);
        const result = await fn(tx);
        for (const op of tx.ops) await op();
        return result;
    }
    // Test helpers
    seed(path: string, data: DocData): void {
        const parts = path.split('/');
        const id = parts.pop() as string;
        const colPath = parts.join('/');
        if (!this.store.has(colPath)) this.store.set(colPath, new Map());
        (this.store.get(colPath) as Map<string, DocData>).set(id, { ...data });
    }
    read(path: string): DocData | undefined {
        const parts = path.split('/');
        const id = parts.pop() as string;
        return this.store.get(parts.join('/'))?.get(id);
    }
    readCollection(path: string): Array<{ id: string; data: DocData }> {
        const col = this.store.get(path);
        if (!col) return [];
        return Array.from(col.entries()).map(([id, data]) => ({ id, data }));
    }
}

export function makeFakeDb(): FakeFirestore {
    return new FakeFirestore();
}
