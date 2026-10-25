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
 *
 * Claims absorb (RP-11 structural, decision pack item 18): when the
 * caller supplies an Auth claims snapshot (options.claimsByUid), a
 * further report-only class is produced:
 *   - claims-divergence        -> the Auth custom claims disagree with
 *                                 the roles doc: either a stale `role`
 *                                 claim (the known shape: claim
 *                                 projects_director / national_marketing
 *                                 against a stored member/member_basic),
 *                                 or a missing appointment claim (the
 *                                 roles doc appoints an office but the
 *                                 claims carry no `role` at all). An
 *                                 absent claim on a basic member
 *                                 (member / member_basic) is CLEAN, not
 *                                 divergence - the bootstrap population
 *                                 is legitimately claim-free.
 * Claims are never repaired here in any mode: claims writes belong to
 * the role write path (stampRoleClaims) and to the separate per-account
 * records operation; this class only reports.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  resolveRoleForUid,
  effectiveRoleOf,
  type CatalogRoleKey,
} from '../role-catalog';
import { isFounderUid } from '@/config/founder';
import { assignRole, setMirror } from './role-writes';
import { supaListDocs } from './supa-roles-reconcile-seam';

export type ReconciliationClass =
  | 'roles-only'
  | 'users-only'
  | 'users-only-bootstrap'
  | 'conflicting-role'
  | 'stale-displayRole'
  | 'claims-divergence'
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
  options: {
    mode?: 'report' | 'repair';
    actorUid?: string;
    now?: Date;
    /**
     * Auth custom-claims snapshot, keyed by uid (RP-11 absorb). Presence
     * of a uid key means "this account's claims were read"; the value is
     * the claims object itself ({} = an Auth account with no custom
     * claims). Uids absent from the map are not claims-checked at all -
     * an unread account is never reported as claim-free or diverged.
     * When the option is omitted, no claims-divergence entries are
     * produced (the pre-absorb behaviour).
     */
    claimsByUid?: ReadonlyMap<string, Record<string, unknown>>;
  } = {},
): Promise<ReconciliationReport> {
  const mode = options.mode ?? 'report';
  const actorUid = options.actorUid ?? 'reconciliation-job';
  // Supabase migration (ROLES G4): the three full-collection reads go
  // through the seam when it is engaged (useSupa('roles')); each read
  // independently falls back to its base Firestore read when the seam
  // returns null (flag OFF / adapter unavailable / adapter error), so
  // flag OFF is byte-identical to pre-migration behaviour. Either
  // source produces { id, data }[] and everything downstream is
  // untouched. DEPENDENCY: repairs below stay exactly as-is -
  // Firestore via assignRole/setMirror imported from './role-writes';
  // their Supabase freshness comes from the G2 chokepoint mirror
  // inside role-writes at merge, NOT from this module.
  type Row = { id: string; data: Record<string, unknown> };
  const readCollection = async (collection: 'roles' | 'users' | 'roleHistory'): Promise<Row[]> => {
    const supaRows = await supaListDocs(collection);
    if (supaRows) return supaRows;
    const snap = await db.collection(collection).get();
    const rows: Row[] = [];
    snap.forEach((doc) => rows.push({ id: doc.id, data: doc.data() as Record<string, unknown> }));
    return rows;
  };
  const [rolesRows, usersRows, historyRows] = await Promise.all([
    readCollection('roles'),
    readCollection('users'),
    readCollection('roleHistory'),
  ]);

  const rolesByUid = new Map<string, Record<string, unknown>>();
  for (const row of rolesRows) rolesByUid.set(row.id, row.data);
  const usersByUid = new Map<string, Record<string, unknown>>();
  for (const row of usersRows) usersByUid.set(row.id, row.data);

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

    // Claims divergence (RP-11 absorb): independent of the doc-vs-doc
    // classes below - an account can carry a claims entry alongside any
    // other entry. Report-only in every mode; never repaired here.
    if (rolesDoc && options.claimsByUid?.has(uid)) {
      const claims = options.claimsByUid.get(uid) ?? {};
      const rolesPrimary = resolveStored(rolesDoc.role, uid);
      const claimRoleRaw = typeof claims.role === 'string' && claims.role ? claims.role : null;
      const claimRole = claimRoleRaw ? resolveStored(claimRoleRaw, uid) : null;
      const claimsRolesEffective = effectiveOf(rolesPrimary, rolesDoc.additionalRoles);
      const claimsMirrorEffective = userDoc
        ? effectiveOf(resolveStored(userDoc.role, uid), userDoc.additionalRoles)
        : null;
      if (claimRoleRaw && claimRole !== rolesPrimary) {
        entries.push({
          uid,
          class: 'claims-divergence',
          detail: `auth claim role ${claimRoleRaw} != roles doc role ${String(rolesDoc.role)} (stale role claim)`,
          rolesEffective: claimsRolesEffective,
          mirrorEffective: claimsMirrorEffective,
        });
      } else if (
        !claimRoleRaw &&
        rolesPrimary &&
        rolesPrimary !== 'member' &&
        rolesPrimary !== 'member_basic'
      ) {
        entries.push({
          uid,
          class: 'claims-divergence',
          detail: `roles doc appoints ${rolesPrimary} but auth claims carry no role claim (missing appointment claim)`,
          rolesEffective: claimsRolesEffective,
          mirrorEffective: claimsMirrorEffective,
        });
      }
    }

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
  for (const row of historyRows) {
    const uid = row.data.uid;
    if (typeof uid === 'string') historyUids.add(uid);
  }
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
    'claims-divergence': 0,
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
