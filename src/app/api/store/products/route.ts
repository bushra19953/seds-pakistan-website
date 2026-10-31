import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { buildMoneyAuditDoc, setMoneyAudit } from '@/lib/server/money-audit';
import {
    listStoreProductsFromSupa,
    storeProductsPrimaryEnabled,
    createStoreProductViaPrimary,
    updateStoreProductViaPrimary,
    deleteStoreProductViaPrimary,
    getStoreProductFromSupa,
    deleteStoreProductFromSupa,
    updateStoreProductInSupa,
} from '@/lib/supa/store-products';
import { evaluateVendorListingGates, type ListingGateFailure } from '@/lib/server/listing-gate';

/* ------------------------------------------------------------------ */
/* Vendor shop pilot fields (spec Section 2.2; PLAN-gb Section 5).     */
/* Field validation is distinct from the listing gates: bad shapes are */
/* a 400 before any gate runs, on POST and PATCH alike. Conversions    */
/* happen before the gates too, so a just-supplied competitor check    */
/* satisfies its gate in the same request.                             */
/* ------------------------------------------------------------------ */

const PRICE_RULE_VALUES = ['parts_accessibility', 'tools_accessibility'];
const WHOLE_PKR_FIELDS = ['costPricePkr', 'deliveryChargePkr', 'competitorPricePkr'];
const GATE_RELEVANT_KEYS = [
    'isActive', 'vendorId', 'currency', 'costPricePkr',
    'competitorPricePkr', 'competitorSource', 'competitorCheckedAt', 'priceRule',
];
const GATE_FIELD_KEYS = [
    'costPricePkr', 'competitorCheckedAt', 'priceRule', 'competitorPricePkr', 'competitorSource',
];

function prepareVendorFields(source: Record<string, any>): { error?: string; fields: Record<string, unknown> } {
    const fields: Record<string, unknown> = {};
    const has = (key: string) => Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;

    for (const field of WHOLE_PKR_FIELDS) {
        if (!has(field)) continue;
        if (source[field] === null) { fields[field] = null; continue; }
        const value = Number(source[field]);
        if (!Number.isInteger(value) || value < 0) {
            return { error: `${field} must be a whole number of PKR`, fields };
        }
        fields[field] = value;
    }

    if (has('priceRule')) {
        const rule = source.priceRule;
        if (rule !== null && rule !== '' && !PRICE_RULE_VALUES.includes(rule)) {
            return { error: 'priceRule must be parts_accessibility or tools_accessibility', fields };
        }
        fields.priceRule = rule;
    }

    if (has('competitorSource')) {
        fields.competitorSource = source.competitorSource ?? null;
    }

    if (has('competitorCheckedAt')) {
        const value = source.competitorCheckedAt;
        if (value === null) {
            fields.competitorCheckedAt = null;
        } else if (typeof value === 'string') {
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) {
                return { error: 'competitorCheckedAt must be a valid date', fields };
            }
            fields.competitorCheckedAt = admin.firestore.Timestamp.fromDate(parsed);
        } else if (typeof value === 'object' && typeof (value as any).toDate === 'function') {
            fields.competitorCheckedAt = value;
        } else {
            return { error: 'competitorCheckedAt must be a valid date', fields };
        }
    }

    if (has('warehousePhotoDriveIds')) {
        const ids = source.warehousePhotoDriveIds;
        if (!Array.isArray(ids) || ids.some((v) => typeof v !== 'string')) {
            return { error: 'warehousePhotoDriveIds must be a list of Drive file ids', fields };
        }
        fields.warehousePhotoDriveIds = ids;
    }

    if (has('dispatchWindowWorkingDays') && source.dispatchWindowWorkingDays !== null) {
        fields.dispatchWindowWorkingDays = Number(source.dispatchWindowWorkingDays);
    }
    if (has('deliveryPromiseDays') && source.deliveryPromiseDays !== null) {
        fields.deliveryPromiseDays = Number(source.deliveryPromiseDays);
    }

    if (has('groupBuyEligible')) {
        fields.groupBuyEligible = source.groupBuyEligible === true;
    }
    if (has('groupBuyTeamSize') && source.groupBuyTeamSize !== null) {
        fields.groupBuyTeamSize = Number(source.groupBuyTeamSize);
    }
    if (has('groupBuyWindowHours') && source.groupBuyWindowHours !== null) {
        fields.groupBuyWindowHours = Number(source.groupBuyWindowHours);
    }
    if (source.groupBuyEligible === true) {
        const size = fields.groupBuyTeamSize ?? source.groupBuyTeamSize;
        if (!Number.isInteger(size) || (size as number) < 2 || (size as number) > 5) {
            return { error: 'groupBuyTeamSize must be between 2 and 5', fields };
        }
    }

    return { fields };
}

function gateFailureResponse(failures: ListingGateFailure[]) {
    return NextResponse.json(
        {
            error: failures.map((f) => f.message).join(', '),
            code: 'LISTING_GATE_FAILED',
            failedGates: failures,
        },
        { status: 422 }
    );
}

export async function GET(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        // Get auth from header - required for admin access
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Supabase read path (flag 'store-products-api'): when the seam
        // returns rows, serve them; null means OFF / unconfigured / error
        // and the Firestore fetch below runs byte-identically.
        const supaProducts = await listStoreProductsFromSupa();
        if (supaProducts) {
            return NextResponse.json({
                ok: true,
                products: supaProducts,
                count: supaProducts.length
            });
        }

        // Fetch all products
        const productsSnap = await db.collection('products').get();
        const products = productsSnap.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
                updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
            };
        });

        return NextResponse.json({
            ok: true,
            products,
            count: products.length
        });
    } catch (e: any) {
        console.error('[products API] GET error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
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
        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { name, description, price, currency, stock, category, isActive, imageUrl, linkedEventId, linkedFormId } = body;

        if (!name) {
            return NextResponse.json({ error: 'Product name is required' }, { status: 400 });
        }

        // Vendor shop fields: validate + convert before anything is
        // built or gated (PLAN-gb Section 5.4).
        const prepared = prepareVendorFields(body);
        if (prepared.error) {
            return NextResponse.json({ error: prepared.error }, { status: 400 });
        }
        const vendorId = typeof body.vendorId === 'string' && body.vendorId !== '' ? body.vendorId : null;

        // Currency force (Section 5.3): a vendor product is always
        // stored in PKR; the response flags when a caller-supplied
        // value was changed.
        const currencyForced = !!vendorId && !!currency && currency !== 'PKR';

        // Category force (pilot scope, spec Section 2.2; audit fix):
        // vendor products are electronics-only in the pilot, with the
        // same treatment as the currency force above.
        const categoryForced = !!vendorId && !!category && category !== 'electronics';

        const productData = {
            name: name || '',
            description: description || '',
            price: Number(price) || 0,
            currency: vendorId ? 'PKR' : (currency || 'PKR'),
            stock: Number(stock) || 999,
            category: vendorId ? 'electronics' : (category || 'other'),
            isActive: isActive !== false,
            imageUrl: imageUrl || '',
            linkedEventId: linkedEventId || null,
            linkedFormId: linkedFormId || null,
            vendorId,
            ...prepared.fields,
            createdAt: admin.firestore.Timestamp.now(),
            updatedAt: admin.firestore.Timestamp.now(),
        };

        // Listing gates (Section 5.1): one choke point above the
        // primacy branch, so a failed gate writes nothing on either
        // store. Draft vendor listings (isActive false) skip the
        // gates; activation is the gated act. House products never
        // run them.
        if (vendorId && productData.isActive) {
            const failures = await evaluateVendorListingGates(db, productData);
            if (failures.length > 0) {
                return gateFailureResponse(failures);
            }
        }

        // WRITE PRIMACY (S-W1, isSupaPrimary('store-products-api')):
        // ONE tx_store_product_create call — insert + money-audit
        // atomically (the P1 delta: an audit failure rolls the product
        // back where the Firestore path below persists it and surfaces
        // the visible 500; the response stays a 500 either way). A tx
        // error propagates to the outer catch — no Firestore fallback
        // on a primary write.
        if (storeProductsPrimaryEnabled()) {
            const { createdAt: _c, updatedAt: _u, ...primaryData } = productData;
            const primaryResult = await createStoreProductViaPrimary({
                data: primaryData,
                audit: {
                    action: 'product_created',
                    actorUid: decoded.uid,
                    actorRole: '',
                    changedFields: Object.keys(productData),
                    source: 'store_products_api',
                },
            });
            if (!primaryResult.ok) {
                return NextResponse.json(
                    { error: primaryResult.message || 'Product creation failed' },
                    { status: primaryResult.httpStatus || 500 },
                );
            }
            return NextResponse.json({
                ok: true,
                productId: primaryResult.productId,
                message: 'Product created successfully',
                ...(currencyForced ? { currencyForced: true } : {}),
                ...(categoryForced ? { categoryForced: true } : {}),
            });
        }

        const docRef = await db.collection('products').add(productData);

        // Money audit (Item 7), fail closed: creation has no prior state to
        // stay atomic with, so write directly; if it throws, surface a 500
        // instead of hiding the gap (the product exists; the error is visible).
        try {
            await db.collection('audit_logs').add(buildMoneyAuditDoc({
                action: 'product_created',
                actorUid: decoded.uid,
                actorRole: '',
                targetType: 'product',
                targetId: docRef.id,
                orderId: null,
                before: null,
                after: productData,
                changedFields: Object.keys(productData),
                reason: null,
                source: 'store_products_api',
            }));
        } catch (auditErr) {
            console.error('[products API] POST audit write failed:', auditErr);
            return NextResponse.json({ error: 'Product created but audit logging failed' }, { status: 500 });
        }

        return NextResponse.json({
            ok: true,
            productId: docRef.id,
            message: 'Product created successfully',
            ...(currencyForced ? { currencyForced: true } : {}),
            ...(categoryForced ? { categoryForced: true } : {}),
        });
    } catch (e: any) {
        console.error('[products API] POST error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
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
        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { productId, updates } = body;

        if (!productId) {
            return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
        }

        const safeUpdates: Record<string, any> = { ...(updates || {}) };

        // Vendor shop fields: validate + convert before gates or any
        // write (PLAN-gb Section 5.4).
        const prepared = prepareVendorFields(safeUpdates);
        if (prepared.error) {
            return NextResponse.json({ error: prepared.error }, { status: 400 });
        }
        Object.assign(safeUpdates, prepared.fields);

        // Listing gates (Section 5.1): a pre-flight read runs ONLY
        // when the update touches a gate-relevant key; with none, the
        // route below is byte-identical to base. The gate itself sits
        // above the primacy branch, so a failed gate writes nothing
        // on either store.
        let currencyForced = false;
        let categoryForced = false;
        if (GATE_RELEVANT_KEYS.some((key) => key in safeUpdates)) {
            const preSnap = await db.collection('products').doc(productId).get();
            let storedData: Record<string, any> | null = preSnap.exists
                ? (preSnap.data() as Record<string, any>)
                : null;
            if (!storedData) {
                const supaProduct = await getStoreProductFromSupa(productId);
                if (supaProduct?.found === true) {
                    storedData = { ...supaProduct.data } as Record<string, any>;
                }
            }
            if (!storedData) {
                return NextResponse.json({ error: 'Product not found' }, { status: 404 });
            }
            const merged: Record<string, any> = { ...storedData, ...safeUpdates };
            if (typeof merged.vendorId === 'string' && merged.vendorId !== '') {
                // Currency force (Section 5.3).
                if (safeUpdates.currency !== undefined && safeUpdates.currency !== 'PKR') {
                    currencyForced = true;
                }
                safeUpdates.currency = 'PKR';
                merged.currency = 'PKR';

                // Category force (pilot scope, spec Section 2.2;
                // audit fix): vendor products are electronics-only.
                if (safeUpdates.category !== undefined && safeUpdates.category !== 'electronics') {
                    categoryForced = true;
                }
                safeUpdates.category = 'electronics';
                merged.category = 'electronics';

                // Gate re-run triggers (CHOICE-GB-4): explicit
                // activation, a vendor assignment change onto a live
                // listing, or a gate-field edit on a live listing.
                // Unrelated edits and deactivation never re-run them.
                const vendorChanged =
                    'vendorId' in safeUpdates && safeUpdates.vendorId !== (storedData.vendorId ?? null);
                const touchesGateField = GATE_FIELD_KEYS.some((key) => key in safeUpdates);
                const shouldGate =
                    safeUpdates.isActive === true ||
                    (vendorChanged && merged.isActive === true) ||
                    (storedData.isActive === true && merged.isActive === true && touchesGateField);
                if (shouldGate) {
                    const failures = await evaluateVendorListingGates(db, merged);
                    if (failures.length > 0) {
                        return gateFailureResponse(failures);
                    }
                }
            }
        }

        // WRITE PRIMACY (S-W1): ONE tx_store_product_update call —
        // the tx locks the row, captures the before-image for the
        // audit, applies the update and writes the audit atomically;
        // a missing product returns today's 404 as a value.
        if (storeProductsPrimaryEnabled()) {
            const primaryResult = await updateStoreProductViaPrimary({
                productId,
                updates: safeUpdates,
                audit: {
                    action: 'product_updated',
                    actorUid: decoded.uid,
                    actorRole: '',
                    changedFields: Object.keys(safeUpdates),
                    source: 'store_products_api',
                },
            });
            if (!primaryResult.ok) {
                return NextResponse.json(
                    { error: primaryResult.message || 'Product not found' },
                    { status: primaryResult.httpStatus || 500 },
                );
            }
            return NextResponse.json({ ok: true, productId, ...(currencyForced ? { currencyForced: true } : {}), ...(categoryForced ? { categoryForced: true } : {}) });
        }

        const productRef = db.collection('products').doc(productId);
        const productSnap = await productRef.get();

        // DEFECT 4(b): the admin list is served from the Supabase read
        // mirror when its surface is ON, so a product can be listed (and
        // offered for edit/deactivate) while having no Firestore doc.
        // Consult the mirror before declaring the product missing.
        const supaProduct = await getStoreProductFromSupa(productId);
        const inSupa = supaProduct?.found === true;

        if (!productSnap.exists && !inSupa) {
            return NextResponse.json({ error: 'Product not found' }, { status: 404 });
        }

        const beforeData: any = productSnap.exists
            ? productSnap.data() || {}
            : { ...((supaProduct as { found: true; data: Record<string, unknown> }).data) };
        const updatesToApply = {
            ...safeUpdates,
            updatedAt: admin.firestore.Timestamp.now(),
        };

        if (!productSnap.exists) {
            // Mirror-only product: update the mirror first, then write
            // the audit entry directly (the POST pattern — no batch
            // exists without a Firestore doc). Either failure is a loud
            // 500 carrying the real reason, never a silent success.
            try {
                await updateStoreProductInSupa(productId, updatesToApply);
            } catch (mirrorErr: any) {
                console.error('[products API] PATCH mirror update failed:', mirrorErr);
                return NextResponse.json(
                    { error: `Product update failed in the store read mirror (Supabase): ${mirrorErr?.message || 'unknown error'}` },
                    { status: 500 }
                );
            }
            try {
                await db.collection('audit_logs').add(buildMoneyAuditDoc({
                    action: 'product_updated',
                    actorUid: decoded.uid,
                    actorRole: '',
                    targetType: 'product',
                    targetId: productId,
                    orderId: null,
                    before: beforeData,
                    after: { ...beforeData, ...safeUpdates },
                    changedFields: Object.keys(safeUpdates),
                    reason: null,
                    source: 'store_products_api',
                }));
            } catch (auditErr) {
                console.error('[products API] PATCH audit write failed:', auditErr);
                return NextResponse.json({ error: 'Product updated but audit logging failed' }, { status: 500 });
            }
            return NextResponse.json({ ok: true, productId, ...(currencyForced ? { currencyForced: true } : {}), ...(categoryForced ? { categoryForced: true } : {}) });
        }

        // Money audit (Item 7): batch update + audit entry, fail closed.
        const batch = db.batch();
        batch.update(productRef, updatesToApply);
        setMoneyAudit(batch, db as never, {
            action: 'product_updated',
            actorUid: decoded.uid,
            actorRole: '',
            targetType: 'product',
            targetId: productId,
            orderId: null,
            before: beforeData,
            after: { ...beforeData, ...safeUpdates },
            changedFields: Object.keys(safeUpdates),
            reason: null,
            source: 'store_products_api',
        });
        await batch.commit();

        // DEFECT 4(a) twin: a Firestore-only update leaves the mirror
        // serving the old values (e.g. a deactivated product reappears
        // as active on the next list read). Mirror the same update; a
        // mirror failure is loud, not a silent stale read.
        if (inSupa) {
            try {
                await updateStoreProductInSupa(productId, updatesToApply);
            } catch (mirrorErr: any) {
                console.error('[products API] PATCH mirror update failed:', mirrorErr);
                return NextResponse.json(
                    { error: `Product updated but updating the store read mirror (Supabase) failed: ${mirrorErr?.message || 'unknown error'}` },
                    { status: 500 }
                );
            }
        }

        return NextResponse.json({ ok: true, productId, ...(currencyForced ? { currencyForced: true } : {}), ...(categoryForced ? { categoryForced: true } : {}) });
    } catch (e: any) {
        console.error('[products API] PATCH error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
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
        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const productId = searchParams.get('productId');

        if (!productId) {
            return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
        }

        // WRITE PRIMACY (S-W1): ONE tx_store_product_delete call —
        // the tx locks the row, captures the before-image, deletes and
        // writes the audit atomically; a missing product returns
        // today's 404 as a value.
        if (storeProductsPrimaryEnabled()) {
            const primaryResult = await deleteStoreProductViaPrimary({
                productId,
                audit: {
                    action: 'product_deleted',
                    actorUid: decoded.uid,
                    actorRole: '',
                    source: 'store_products_api',
                },
            });
            if (!primaryResult.ok) {
                return NextResponse.json(
                    { error: primaryResult.message || 'Product not found' },
                    { status: primaryResult.httpStatus || 500 },
                );
            }
            return NextResponse.json({ ok: true, deleted: productId });
        }

        const productRef = db.collection('products').doc(productId);
        const productSnap = await productRef.get();

        // DEFECT 4: the admin list is served from the Supabase read
        // mirror when its surface is ON. (a) A product present in both
        // stores survived a Firestore-only delete — the mirror row
        // resurrected it on the next list read while the UI toasted
        // success. (b) A product present ONLY in the mirror 404'd here
        // (and in PATCH) because Firestore was the only store checked.
        const supaProduct = await getStoreProductFromSupa(productId);
        const inSupa = supaProduct?.found === true;

        if (!productSnap.exists && !inSupa) {
            return NextResponse.json({ error: 'Product not found' }, { status: 404 });
        }

        const beforeData: any = productSnap.exists
            ? productSnap.data() || {}
            : { ...((supaProduct as { found: true; data: Record<string, unknown> }).data) };

        // Remove the mirror row FIRST: if that fails, nothing else has
        // happened, the response is a loud 500 with the real reason,
        // and a retry starts from a clean state. Returning success
        // while the mirror row survives is exactly defect (a).
        if (inSupa) {
            try {
                await deleteStoreProductFromSupa(productId);
            } catch (mirrorErr: any) {
                console.error('[products API] DELETE mirror delete failed:', mirrorErr);
                return NextResponse.json(
                    { error: `Product delete failed in the store read mirror (Supabase): ${mirrorErr?.message || 'unknown error'}` },
                    { status: 500 }
                );
            }
        }

        if (!productSnap.exists) {
            // Mirror-only product: no Firestore batch exists, so the
            // audit entry is written directly after the delete (the
            // POST pattern); a failed audit write surfaces as a 500
            // instead of hiding the gap.
            try {
                await db.collection('audit_logs').add(buildMoneyAuditDoc({
                    action: 'product_deleted',
                    actorUid: decoded.uid,
                    actorRole: '',
                    targetType: 'product',
                    targetId: productId,
                    orderId: null,
                    before: beforeData,
                    after: null,
                    changedFields: Object.keys(beforeData),
                    reason: null,
                    source: 'store_products_api',
                }));
            } catch (auditErr) {
                console.error('[products API] DELETE audit write failed:', auditErr);
                return NextResponse.json({ error: 'Product deleted but audit logging failed' }, { status: 500 });
            }
            return NextResponse.json({ ok: true, deleted: productId });
        }

        // Money audit (Item 7): product hard delete REMAINS in Phase 0, but it
        // is logged atomically — batch.delete + batch.set(audit) commit together.
        const batch = db.batch();
        batch.delete(productRef);
        setMoneyAudit(batch, db as never, {
            action: 'product_deleted',
            actorUid: decoded.uid,
            actorRole: '',
            targetType: 'product',
            targetId: productId,
            orderId: null,
            before: beforeData,
            after: null,
            changedFields: Object.keys(beforeData),
            reason: null,
            source: 'store_products_api',
        });
        await batch.commit();

        return NextResponse.json({ ok: true, deleted: productId });
    } catch (e: any) {
        console.error('[products API] DELETE error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}
