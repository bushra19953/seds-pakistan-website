/**
 * Role-store reconciliation (Phase 1, spec B.6).
 *
 * Compares roles/{uid} (authoritative) against the users/{uid} mirror for
 * every user and classifies divergence. REPORT MODE IS THE DEFAULT and
 * performs zero role-store writes. Repair mode fixes only the classes
 * whose correct end state is unambiguous:
 *   - stale-displayRole        -> setMirror
 *   - conflicting-role         -> setMirror (the roles doc wins) when the
 *                                 stored roles token resolves to a catalog key
 *   - users-only-bootstrap     -> assignRole(member_basic) from the mirror claim
 * roles-only, users-only (a real role claim with no roles record), and
 * orphan-roleHistory are report-only forever: a human decides those.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  resolveRoleForUid,
  effectiveRoleOf,
  type CatalogRoleKey,
} from '../role-catalog';
import { isFounderUid } from '@/config/founder';
import { assignRole, setMirror } from './role-writes';

export type ReconciliationClass =
  | 'roles-only'
  | 'users-only'
  | 'users-only-bootstrap'
  | 'conflicting-role'
  | 'stale-displayRole'
  | 'orphan-roleHistory';

export interface ReconciliationEntry {
  uid: string;
  class: ReconciliationClass;
  detail: string;
  rolesEffective: CatalogRoleKey | null;
  mirrorEffective: CatalogRoleKey | null;
  repaired?: string;
  repairError?: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  mode: 'report' | 'repair';
  totalUsers: number;
  counts: Record<ReconciliationClass, number>;
  entries: ReconciliationEntry[];
}

function resolveStored(raw: unknown, uid: string): CatalogRoleKey | null {
  if (typeof raw !== 'string' || !raw) return null;
  const result = resolveRoleForUid(raw, uid, isFounderUid);
  if (result.kind === 'catalog' || result.kind === 'legacy') return result.key;
  return null;
}

function effectiveOf(
  primary: CatalogRoleKey | null,
  additionalRaw: unknown,
): CatalogRoleKey | null {
  if (!primary) return null;
  const additional: CatalogRoleKey[] = Array.isArray(additionalRaw)
    ? (additionalRaw as unknown[]).filter(
        (r): r is CatalogRoleKey => typeof r === 'string' && resolveStored(r, '') !== null,
      )
    : [];
  return effectiveRoleOf(primary, additional);
}

export async function reconcileRoles(
  db: Firestore,
  options: { mode?: 'report' | 'repair'; actorUid?: string; now?: Date } = {},
): Promise<ReconciliationReport> {
  const mode = options.mode ?? 'report';
  const actorUid = options.actorUid ?? 'reconciliation-job';
  const [rolesSnap, usersSnap, historySnap] = await Promise.all([
    db.collection('roles').get(),
    db.collection('users').get(),
    db.collection('roleHistory').get(),
  ]);

  const rolesByUid = new Map<string, Record<string, unknown>>();
  rolesSnap.forEach((doc) => rolesByUid.set(doc.id, doc.data() as Record<string, unknown>));
  const usersByUid = new Map<string, Record<string, unknown>>();
  usersSnap.forEach((doc) => usersByUid.set(doc.id, doc.data() as Record<string, unknown>));

  const entries: ReconciliationEntry[] = [];
  const allUids = new Set<string>([...rolesByUid.keys(), ...usersByUid.keys()]);

  const repair = async (entry: ReconciliationEntry, fn: () => Promise<string>): Promise<void> => {
    if (mode !== 'repair') return;
    try {
      entry.repaired = await fn();
    } catch (err) {
      entry.repairError = err instanceof Error ? err.message : String(err);
    }
  };

  for (const uid of [...allUids].sort()) {
    const rolesDoc = rolesByUid.get(uid);
    const userDoc = usersByUid.get(uid);

    if (rolesDoc && !userDoc) {
      entries.push({
        uid,
        class: 'roles-only',
        detail: 'roles record exists; no users doc to mirror onto',
        rolesEffective: effectiveOf(resolveStored(rolesDoc.role, uid), rolesDoc.additionalRoles),
        mirrorEffective: null,
      });
      continue;
    }
    if (!rolesDoc && userDoc) {
      const mirrorPrimary = resolveStored(userDoc.role, uid);
      const isBootstrapClaim =
        !userDoc.role || mirrorPrimary === 'member' || mirrorPrimary === 'member_basic';
      const entry: ReconciliationEntry = {
        uid,
        class: isBootstrapClaim ? 'users-only-bootstrap' : 'users-only',
        detail: isBootstrapClaim
          ? 'mirror claims only basic membership; no roles record'
          : `mirror claims ${String(userDoc.role)} with no roles record; human decision required`,
        rolesEffective: null,
        mirrorEffective: effectiveOf(mirrorPrimary, userDoc.additionalRoles),
      };
      if (isBootstrapClaim) {
        await repair(entry, async () => {
          await assignRole(db, {
            uid,
            role: 'member_basic',
            chapterId: (userDoc.chapterId as string | null) ?? null,
            actorUid,
            reason: 'Reconciliation bootstrap: mirror claimed basic membership with no roles record',
            source: 'reconciliation_repair',
            idempotencyKey: `recon-bootstrap:${uid}`,
          });
          return 'assignRole(member_basic)';
        });
      }
      entries.push(entry);
      continue;
    }
    if (rolesDoc && userDoc) {
      const rawRolesEffective = effectiveOf(resolveStored(rolesDoc.role, uid), rolesDoc.additionalRoles);
      const rawMirrorEffective = effectiveOf(resolveStored(userDoc.role, uid), userDoc.additionalRoles);
      // Founder identity (spec R.5.2 case 1): on the Founder's own record,
      // the legacy claims 'admin' and 'superadmin' in either store both
      // denote the founder; the effective role is founder_patron by UID.
      // The stores still count as conflicting when the resolved claims
      // differ - that divergence is exactly what the report exists for.
      const founderIdentity =
        isFounderUid(uid) &&
        (rolesDoc.role === 'admin' ||
          rolesDoc.role === 'superadmin' ||
          rolesDoc.role === 'founder_patron' ||
          userDoc.role === 'admin' ||
          userDoc.role === 'superadmin' ||
          userDoc.role === 'founder_patron');
      const rolesEffective = founderIdentity ? ('founder_patron' as CatalogRoleKey) : rawRolesEffective;
      const mirrorEffective = founderIdentity ? ('founder_patron' as CatalogRoleKey) : rawMirrorEffective;
      if (rawRolesEffective !== rawMirrorEffective) {
        const entry: ReconciliationEntry = {
          uid,
          class: 'conflicting-role',
          detail: `roles effective ${rolesEffective ?? 'unresolvable'} != mirror effective ${mirrorEffective ?? 'unresolvable'}`,
          rolesEffective,
          mirrorEffective,
        };
        // The Founder's own record is never auto-repaired: identity
        // outranks both stores and a human reviews the founder record.
        if (rolesEffective && !founderIdentity) {
          await repair(entry, async () => {
            await setMirror(db, uid);
            return 'setMirror';
          });
        }
        entries.push(entry);
      } else if (userDoc.displayRole !== userDoc.role) {
        const entry: ReconciliationEntry = {
          uid,
          class: 'stale-displayRole',
          detail: `displayRole ${String(userDoc.displayRole)} != role ${String(userDoc.role)}`,
          rolesEffective,
          mirrorEffective,
        };
        await repair(entry, async () => {
          await setMirror(db, uid);
          return 'setMirror';
        });
        entries.push(entry);
      }
    }
  }

  // Orphan history: roleHistory records whose uid has neither doc.
  const historyUids = new Set<string>();
  historySnap.forEach((doc) => {
    const uid = (doc.data() as Record<string, unknown>).uid;
    if (typeof uid === 'string') historyUids.add(uid);
  });
  for (const uid of [...historyUids].sort()) {
    if (!rolesByUid.has(uid) && !usersByUid.has(uid)) {
      entries.push({
        uid,
        class: 'orphan-roleHistory',
        detail: 'roleHistory records exist for a uid with no roles or users doc; retained permanently',
        rolesEffective: null,
        mirrorEffective: null,
      });
    }
  }

  const counts: Record<ReconciliationClass, number> = {
    'roles-only': 0,
    'users-only': 0,
    'users-only-bootstrap': 0,
    'conflicting-role': 0,
    'stale-displayRole': 0,
    'orphan-roleHistory': 0,
  };
  for (const entry of entries) counts[entry.class] += 1;

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    mode,
    totalUsers: usersByUid.size,
    counts,
    entries,
  };
}
