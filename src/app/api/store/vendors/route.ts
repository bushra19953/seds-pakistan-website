import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { RoleWriteError } from '@/lib/server/role-writes';
import {
    ensureVendorRoleDefinition,
    grantVendorRole,
    getVendorByUserId,
} from '@/lib/server/vendor-access';
import { mirrorVendorShopSet } from '@/lib/supa/vendor-shop-mirror';

/**
 * /api/store/vendors (vendor shop pilot, PLAN-gb Section 4).
 * Admin-only vendor CRUD: POST creates the vendor record and grants
 * the vendor system role through the single role write path; GET
 * lists full admin-tier records for the founder's Vendors tab and the
 * product form's vendor picker. No public or vendor-facing list.
 *
 * Writes go through the Admin SDK Firestore path and mirror to
 * Supabase through GA's vendor-shop mirror helper, best-effort: the
 * mirror never throws, so a mirror gap never fails the request.
 * Server logs carry vendorId and uid only: never CNIC, bank fields,
 * phone, or email (no PII in logs).
 */

const REQUIRED_FIELDS = ['userId', 'businessName', 'contactName', 'phone', 'email', 'city'] as const;

function isBlank(value: unknown): boolean {
    return typeof value !== 'string' || value.trim() === '';
}

function optionalString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    return typeof value === 'string' ? value : '';
}

function isoOrNull(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const candidate = value as { toDate?: () => Date };
    if (typeof candidate.toDate === 'function') {
        return candidate.toDate().toISOString();
    }
    return null;
}

function millisOf(value: unknown): number {
    if (value === null || value === undefined) return 0;
    const candidate = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
    if (typeof candidate.toMillis === 'function') return candidate.toMillis();
    if (typeof candidate.toDate === 'function') return candidate.toDate().getTime();
    if (typeof candidate.seconds === 'number') return candidate.seconds * 1000;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return Date.parse(value) || 0;
    if (typeof value === 'number') return value;
    return 0;
}

async function requireStoreManager(request: NextRequest) {
    const db = getDb();
    if (!db) {
        return { error: NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 }) };
    }
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');
    if (!canManage) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { db, actorUid: decoded.uid };
}

export async function POST(request: NextRequest) {
    try {
        const gate = await requireStoreManager(request);
        if ('error' in gate) return gate.error;
        const { db, actorUid } = gate;

        const body = (await request.json()) as Record<string, unknown>;

        // Allowlist validation (mass-assignment guard): only the named
        // fields are ever read from the body. A client-sent status,
        // agreementStatus, createdBy, or id is ignored, not an error.
        for (const field of REQUIRED_FIELDS) {
            if (isBlank(body[field])) {
                return NextResponse.json({ error: `${field} is required` }, { status: 400 });
            }
        }
        if (body.commissionRate !== undefined) {
            const rate = body.commissionRate;
            if (typeof rate !== 'number' || Number.isNaN(rate) || rate < 0 || rate > 1) {
                return NextResponse.json(
                    { error: 'commissionRate must be a number between 0 and 1' },
                    { status: 400 }
                );
            }
        }

        const userId = body.userId as string;

        // The founder picks the account in the admin UI; the route
        // trusts the uid, never a name (people lookup is by email).
        const userSnap = await db.collection('users').doc(userId).get();
        if (!userSnap.exists) {
            return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
        }

        // One vendor record per userId (spec Section 2.1).
        const existing = await getVendorByUserId(db, userId);
        if (existing) {
            return NextResponse.json(
                { error: 'A vendor record already exists for this user' },
                { status: 409 }
            );
        }

        // G0: the role definition must be present and exact before any
        // grant. Drift fails the create before anything is written.
        const definitionOk = await ensureVendorRoleDefinition(db);
        if (!definitionOk) {
            return NextResponse.json(
                {
                    error:
                        'Vendor role definition drift detected. Fix the roleDefinitions/vendor document before granting the vendor role.',
                },
                { status: 500 }
            );
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        const vendorData: Record<string, unknown> = {
            userId,
            businessName: body.businessName,
            contactName: body.contactName,
            phone: body.phone,
            email: body.email,
            city: body.city,
            warehouseAddress: optionalString(body, 'warehouseAddress'),
            cnicNumber: optionalString(body, 'cnicNumber'),
            bankName: optionalString(body, 'bankName'),
            bankAccountTitle: optionalString(body, 'bankAccountTitle'),
            bankAccountNumber: optionalString(body, 'bankAccountNumber'),
            agreementStatus: 'none',
            agreementDriveFileId: null,
            agreementSignedAt: null,
            commissionRate: typeof body.commissionRate === 'number' ? body.commissionRate : 0.1,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            createdBy: actorUid,
        };

        const docRef = await db.collection('vendors').add(vendorData);
        const vendorId = docRef.id;
        await mirrorVendorShopSet('vendors', vendorId, vendorData);

        // G1+G2: grant the vendor role. A record without its grant is
        // never a success: on any grant failure the just-created doc
        // is deleted (compensating delete) before responding.
        try {
            await grantVendorRole(db, actorUid, userId, vendorId);
        } catch (grantErr) {
            try {
                await db.collection('vendors').doc(vendorId).delete();
            } catch (deleteErr) {
                console.error(
                    `[vendors API] POST compensating delete failed for vendor ${vendorId}:`,
                    deleteErr
                );
                return NextResponse.json(
                    {
                        error: `Vendor created but the role grant failed. Vendor record ${vendorId} needs manual cleanup.`,
                    },
                    { status: 500 }
                );
            }
            if (grantErr instanceof RoleWriteError) {
                return NextResponse.json(
                    { error: grantErr.message, code: grantErr.code },
                    { status: grantErr.httpStatus }
                );
            }
            throw grantErr;
        }

        // The role_change audit is written by role-writes itself; this
        // entry records the vendor act. An audit failure is logged and
        // does not fail the request: the record and grant are the
        // system of record, and a vendor record is not a money movement.
        try {
            await db.collection('audit_logs').add({
                action: 'vendor_created',
                actorUid,
                targetType: 'vendor',
                targetId: vendorId,
                details: { userId, businessName: body.businessName },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (auditErr) {
            console.error(`[vendors API] POST audit write failed for vendor ${vendorId}:`, auditErr);
        }

        return NextResponse.json({
            ok: true,
            vendorId,
            message: 'Vendor created successfully',
        });
    } catch (e: any) {
        console.error('[vendors API] POST error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function GET(request: NextRequest) {
    try {
        const gate = await requireStoreManager(request);
        if ('error' in gate) return gate.error;
        const { db } = gate;

        const snap = await db.collection('vendors').get();
        // Ordered by createdAt descending (PLAN-gb Section 4.4).
        // Sorted here, on the raw values before serialisation, so the
        // list order does not depend on a composite index; the pilot
        // vendor count is a handful of records.
        const vendors = snap.docs
            .map((doc: any) => {
                const data = doc.data();
                return {
                    createdMillis: millisOf(data.createdAt),
                    vendor: {
                        id: doc.id,
                        ...data,
                        agreementSignedAt: isoOrNull(data.agreementSignedAt),
                        createdAt: isoOrNull(data.createdAt),
                        updatedAt: isoOrNull(data.updatedAt),
                    },
                };
            })
            .sort((a: any, b: any) => b.createdMillis - a.createdMillis)
            .map((entry: any) => entry.vendor);

        return NextResponse.json({ ok: true, vendors, count: vendors.length });
    } catch (e: any) {
        console.error('[vendors API] GET error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}
