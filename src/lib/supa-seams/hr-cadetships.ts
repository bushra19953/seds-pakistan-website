export type DocData = Record<string, unknown>;
export type SupaDoc = { id: string } & DocData;
export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';
export type WhereClause = [field: string, op: WhereOp, value: unknown];
export interface ListOptions { where?: WhereClause[]; orderBy?: string | { field: string; direction?: 'asc' | 'desc' } | Array<{ field: string; direction?: 'asc' | 'desc' }>; limit?: number; startAfter?: string | number; }
export interface SupaAdapter {
  getDoc(collectionPath: string, id: string): Promise<SupaDoc | null>;
  listDocs(collectionPath: string, options?: ListOptions): Promise<SupaDoc[]>;
  countDocs(collectionPath: string, where?: WhereClause[]): Promise<number>;
  setDoc(collectionPath: string, id: string, data: DocData, options?: { merge?: boolean }): Promise<SupaDoc>;
  updateDoc(collectionPath: string, id: string, updates: DocData): Promise<SupaDoc>;
  deleteDoc(collectionPath: string, id: string): Promise<void>;
}

export function getAdapter(): SupaAdapter | null {
  return null;
}

export function useSupa(surface: string): boolean {
  return (process.env.SUPA_SURFACES ?? '').split(',').map(s => s.trim()).includes(surface);
}

export const CADETSHIPS_SURFACE = 'cadetships';

// TODO: migrate route groups behind this seam:
// - src/app/api/cadetships/route.ts
// - src/app/api/cadetships/[id]/route.ts
// - src/app/api/cadetships/[id]/attest/route.ts
// - src/app/api/cadetships/[id]/decision/route.ts
// - src/app/api/cadetships/me/acknowledge-conduct/route.ts
// - src/lib/server/cadetship/{create,access,clock,cron-stanza,serialize,dues-adapter}.ts (data-access parts)
// - src/lib/cadetship/{types,checklist}.ts (data reads)
// - src/app/admin/cadetships/page.tsx + [id]/page.tsx (document read path if served by routes above)
