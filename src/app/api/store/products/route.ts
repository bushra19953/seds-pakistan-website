import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

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
        const userRole = (decoded as any).role || '';

        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermission(userRole, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
        const userRole = (decoded as any).role || '';

        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermission(userRole, 'canManageStore');

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

        const docRef = await db.collection('products').add(productData);

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
        const userRole = (decoded as any).role || '';

        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermission(userRole, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { productId, updates } = body;

        if (!productId) {
            return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
        }

        const productRef = db.collection('products').doc(productId);
        const productSnap = await productRef.get();

        if (!productSnap.exists) {
            return NextResponse.json({ error: 'Product not found' }, { status: 404 });
        }

        const updatesToApply = {
            ...updates,
            updatedAt: admin.firestore.Timestamp.now(),
        };

        await productRef.update(updatesToApply);

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
        const userRole = (decoded as any).role || '';

        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermission(userRole, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const productId = searchParams.get('productId');

        if (!productId) {
            return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
        }

        const productRef = db.collection('products').doc(productId);
        const productSnap = await productRef.get();

        if (!productSnap.exists) {
            return NextResponse.json({ error: 'Product not found' }, { status: 404 });
        }

        await productRef.delete();

        return NextResponse.json({ ok: true, deleted: productId });
    } catch (e: any) {
        console.error('[products API] DELETE error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}
