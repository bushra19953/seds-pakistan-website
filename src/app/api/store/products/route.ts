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
} from '@/lib/supa/store-products';

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

        const productData = {
            name: name || '',
            description: description || '',
            price: Number(price) || 0,
            currency: currency || 'PKR',
            stock: Number(stock) || 999,
            category: category || 'other',
            isActive: isActive !== false,
            imageUrl: imageUrl || '',
            linkedEventId: linkedEventId || null,
            linkedFormId: linkedFormId || null,
            createdAt: admin.firestore.Timestamp.now(),
            updatedAt: admin.firestore.Timestamp.now(),
        };

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
                message: 'Product created successfully'
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
            message: 'Product created successfully'
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

        const safeUpdates = updates || {};

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
            return NextResponse.json({ ok: true, productId });
        }

        const productRef = db.collection('products').doc(productId);
        const productSnap = await productRef.get();

        if (!productSnap.exists) {
            return NextResponse.json({ error: 'Product not found' }, { status: 404 });
        }

        const beforeData: any = productSnap.data() || {};
        const updatesToApply = {
            ...safeUpdates,
            updatedAt: admin.firestore.Timestamp.now(),
        };

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

        return NextResponse.json({ ok: true, productId });
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

        if (!productSnap.exists) {
            return NextResponse.json({ error: 'Product not found' }, { status: 404 });
        }

        const beforeData: any = productSnap.data() || {};

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
