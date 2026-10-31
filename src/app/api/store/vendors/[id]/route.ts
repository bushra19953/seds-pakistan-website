import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { RoleWriteError } from '@/lib/server/role-writes';
import { getVendorById, revokeVendorRole } from '@/lib/server/vendor-access';
import { mirrorVendorShopUpdate } from '@/lib/supa/vendor-shop-mirror';

/**
 * PATCH /api/store/vendors/[id] (vendor shop pilot, PLAN-gb
 * Section 4.3). Admin-only. Edits go through an allowlist (mass
 * assignment guard); agreement recording and the status transitions
 * carry the pilot's semantics:
 * - paused: doc update only. The stored role grant remains, but every
 *   vendor check fails because vendor resolution requires an active
 *   record.
 * - active from paused: doc update only; access resumes.
 * - active from exited: 409. Exit removed the role; reactivating
 *   would silently re-grant a founder decision.
 * - exited: doc update, then the role revoke through the single role
 *   write path. A repeated exit runs the revoke again (retry
 *   semantics) and succeeds.
 * Audit details record field NAMES changed, plus before/after for
 * status, agreementStatus, and commissionRate only: never CNIC or
 * bank values.
 */

const EDITABLE_FIELDS = [
    'businessName',
    'contactName',
    'phone',
    'email',
    'city',
    'warehouseAddress',
    'cnicNumber',
    'bankName',
    'bankAccountTitle',
    'bankAccountNumber',
    'commissionRate',
    'agreementStatus',
    'agreementDriveFileId',
    'agreementSignedAt',
    'status',
] as const;

const NON_BLANK_FIELDS = ['businessName', 'contactName', 'phone', 'email', 'city'] as const;
const VENDOR_STATUSES = ['active', 'paused', 'exited'] as const;

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');
        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const actorUid = decoded.uid;

        const { id: vendorId } = await params;
        const stored = await getVendorById(db, vendorId);
        if (!stored) {
            return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
        }

        const body = (await request.json()) as Record<string, unknown>;

        // The role grant hangs off the original uid; changing it would
        // orphan the grant.
        if (body.userId !== undefined && body.userId !== stored.userId) {
            return NextResponse.json(
                { error: 'userId cannot be changed on a vendor record' },
                { status: 400 }
            );
        }

        for (const field of NON_BLANK_FIELDS) {
            const value = body[field];
            if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
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
        if (
            body.agreementStatus !== undefined &&
            body.agreementStatus !== 'none' &&
            body.agreementStatus !== 'signed'
        ) {
            return NextResponse.json(
                { error: 'agreementStatus must be none or signed' },
                { status: 400 }
            );
        }
        if (
            body.status !== undefined &&
            !(VENDOR_STATUSES as readonly string[]).includes(body.status as string)
        ) {
            return NextResponse.json(
                { error: 'status must be active, paused or exited' },
                { status: 400 }
            );
        }

        const updates: Record<string, unknown> = {};
        for (const field of EDITABLE_FIELDS) {
            if (body[field] !== undefined) updates[field] = body[field];
        }

        // Agreement recording (spec Section 3.2 step 3): a signed
        // record requires the filed Drive copy.
        if (updates.agreementStatus === 'signed') {
            const effectiveFileId =
                updates.agreementDriveFileId !== undefined
                    ? updates.agreementDriveFileId
                    : stored.agreementDriveFileId;
            if (typeof effectiveFileId !== 'string' || effectiveFileId.trim() === '') {
                return NextResponse.json(
                    { error: 'agreementDriveFileId is required to record a signed agreement' },
                    { status: 400 }
                );
            }
        }
        if (updates.agreementSignedAt !== undefined && updates.agreementSignedAt !== null) {
            const parsed = new Date(updates.agreementSignedAt as string);
            if (Number.isNaN(parsed.getTime())) {
                return NextResponse.json(
                    { error: 'agreementSignedAt must be a valid date' },
                    { status: 400 }
                );
            }
            updates.agreementSignedAt = admin.firestore.Timestamp.fromDate(parsed);
        }
        if (updates.agreementStatus === 'signed') {
            if (updates.agreementSignedAt === undefined && !stored.agreementSignedAt) {
                updates.agreementSignedAt = admin.firestore.Timestamp.now();
            }
        }
        if (updates.agreementStatus === 'none') {
            // An unsigned record must not keep a stale signed date or
            // file id, unless the body explicitly provides them.
            if (updates.agreementDriveFileId === undefined) updates.agreementDriveFileId = null;
            if (body.agreementSignedAt === undefined) updates.agreementSignedAt = null;
        }

        // Status transitions.
        const statusChanged = updates.status !== undefined && updates.status !== stored.status;
        if (statusChanged && stored.status === 'exited' && updates.status === 'active') {
            return NextResponse.json(
                { error: 'An exited vendor cannot be reactivated. Create a new vendor record.' },
                { status: 409 }
            );
        }
        const isExit = updates.status === 'exited' && stored.status !== 'exited';
        const isExitRetry = updates.status === 'exited' && stored.status === 'exited';

        const changedFields = Object.keys(updates);
        const skipDocUpdate = isExitRetry && changedFields.length === 1;
        if (!skipDocUpdate && changedFields.length > 0) {
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            await db.collection('vendors').doc(vendorId).update(updates);
            await mirrorVendorShopUpdate('vendors', vendorId, updates);
        }
        // A pure exit retry writes nothing to the doc; it only re-runs
        // the revoke below.

        if (isExit || isExitRetry) {
            try {
                await revokeVendorRole(db, actorUid, stored.userId, vendorId);
            } catch (revokeErr) {
                // The record stays exited, and because vendor
                // resolution checks record status first, the vendor
                // has no working access in the interim. The founder
                // retries by PATCHing status to exited again.
                console.error(
                    `[vendors API] PATCH revoke failed for vendor ${vendorId}:`,
                    revokeErr
                );
                if (revokeErr instanceof RoleWriteError) {
                    return NextResponse.json(
                        {
                            error: `Vendor ${vendorId} is exited but the role revoke failed at step role_revoke: ${revokeErr.message}`,
                            code: revokeErr.code,
                        },
                        { status: 500 }
                    );
                }
                return NextResponse.json(
                    {
                        error: `Vendor ${vendorId} is exited but the role revoke failed at step role_revoke.`,
                    },
                    { status: 500 }
                );
            }
        }

        const agreementChanged =
            updates.agreementStatus !== undefined && updates.agreementStatus !== stored.agreementStatus;
        const action = statusChanged
            ? 'vendor_status_changed'
            : agreementChanged
              ? 'vendor_agreement_recorded'
              : 'vendor_updated';
        const details: Record<string, unknown> = { changedFields };
        if (statusChanged) {
            details.statusBefore = stored.status;
            details.statusAfter = updates.status;
        }
        if (agreementChanged) {
            details.agreementStatusBefore = stored.agreementStatus;
            details.agreementStatusAfter = updates.agreementStatus;
        }
        if (updates.commissionRate !== undefined && updates.commissionRate !== stored.commissionRate) {
            details.commissionRateBefore = stored.commissionRate;
            details.commissionRateAfter = updates.commissionRate;
        }
        try {
            await db.collection('audit_logs').add({
                action,
                actorUid,
                targetType: 'vendor',
                targetId: vendorId,
                details,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (auditErr) {
            console.error(`[vendors API] PATCH audit write failed for vendor ${vendorId}:`, auditErr);
        }

        return NextResponse.json({ ok: true, vendorId });
    } catch (e: any) {
        console.error('[vendors API] PATCH error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}
