'use server';

import { getDb } from '@/lib/server/firebase-admin';
import { Product, Order } from '@/types/store';
import { FieldValue } from 'firebase-admin/firestore';

export async function getProduct(productId: string): Promise<{ success: boolean; data?: Product; error?: string }> {
    try {
        const db = await getDb();
        if (!db) {
            throw new Error('Database connection failed');
        }
        const docRef = db.collection('products').doc(productId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return { success: false, error: 'Product not found' };
        }

        const data = docSnap.data();

        // Helper to serialize timestamps
        const serializeToken = (data: any): any => {
            if (!data) return data;
            const result = { ...data, id: docSnap.id };
            if (result.createdAt && typeof result.createdAt.toDate === 'function') {
                result.createdAt = result.createdAt.toDate().toISOString();
            }
            if (result.updatedAt && typeof result.updatedAt.toDate === 'function') {
                result.updatedAt = result.updatedAt.toDate().toISOString();
            }
            return result;
        }

        return { success: true, data: serializeToken(data) as Product };
    } catch (error: any) {
        console.error('Error fetching product:', error);
        return { success: false, error: error.message };
    }
}

export async function createOrder(orderData: any): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
        const db = await getDb();
        if (!db) {
            throw new Error('Database connection failed');
        }

        if (!orderData.userId) {
            throw new Error('Unauthorized: User ID required');
        }

        // 🛑 ENFORCEMENT CHECK: Block blacklisted users
        const [userSnap, configSnap] = await Promise.all([
            db.collection('users').doc(orderData.userId).get(),
            db.collection('warningConfig').doc('global').get()
        ]);

        const userData = userSnap.data() || {};
        const configData = configSnap.data() || { enforcementEnabled: true };

        if (configData.enforcementEnabled && userData.isBlacklisted === true) {
            throw new Error('Transaction Blocked: Your account is currently blacklisted. Event registration and store purchases are restricted.');
        }

        if (orderData.originatingModule !== 'donation' && orderData.productId) {
            const productRef = db.collection('products').doc(orderData.productId);
            const productSnap = await productRef.get();
            if (productSnap.exists) {
                const actualPrice = productSnap.data()?.price;
                if (actualPrice !== undefined && orderData.total !== actualPrice) {
                    console.error(`Security Alert: Price mismatch for product ${orderData.productId}. Client sent ${orderData.total}, DB has ${actualPrice}`);
                    throw new Error('Security Error: Price tampering detected.');
                }
            }
        }

        const finalOrder = {
            ...orderData,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            status: 'pending',
            paymentStatus: 'pending',
            securityAudit: {
                clientIp: 'logged',
                verifiedAt: FieldValue.serverTimestamp(),
                priceVerified: orderData.originatingModule !== 'donation'
            }
        };

        const res = await db.collection('orders').add(finalOrder);

        console.log(`Order Created: ${res.id} | Module: ${orderData.originatingModule} | User: ${orderData.userId}`);

        // ── Mirror into events/{eventId}/registrations subcollection ─────────
        // CRITICAL: The ticket issue API looks up registrations by userId (uid).
        // We MUST use userId as the doc ID so the ticket system can find it.
        if (orderData.eventId) {
            const registrationDoc = {
                uid: orderData.userId,
                orderId: res.id,
                eventId: orderData.eventId,
                displayName: orderData.buyer?.fullName || '',
                email: orderData.buyer?.email || '',
                whatsappE164: orderData.buyer?.phone || orderData.buyer?.whatsappNumber || '',
                status: 'pending',
                paymentStatus: 'pending',
                paymentMethod: orderData.paymentMethod || 'bank_transfer',
                paymentRef: orderData.proofOfPaymentUrl || '',
                notes: orderData.notes || '',
                formResponses: orderData.formResponses || {},
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            };
            await db
                .collection('events')
                .doc(orderData.eventId)
                .collection('registrations')
                .doc(orderData.userId)
                .set(registrationDoc, { merge: true });
            console.log(`Registration mirrored → events/${orderData.eventId}/registrations/${orderData.userId}`);

            // ── Ensure a Product record exists in Store Central Command ────────
            // If no productId was supplied, or the product doc doesn't exist,
            // auto-create a stub so it appears in the admin Inventory tab.
            if (orderData.productId) {
                const pSnap = await db.collection('products').doc(orderData.productId).get();
                if (!pSnap.exists) {
                    // Product referenced by checkout URL no longer exists — re-create it
                    // Pull event info to get title/price
                    const evSnap = await db.collection('events').doc(orderData.eventId).get();
                    const evData = evSnap.data() || {};
                    await db.collection('products').doc(orderData.productId).set({
                        name: `${evData.title || 'Event'} — Ticket`,
                        description: `Auto-created from checkout. Event: ${orderData.eventId}`,
                        price: orderData.total || 0,
                        currency: orderData.currency || 'PKR',
                        category: 'event_ticket',
                        eventId: orderData.eventId,
                        isActive: true,
                        stock: 999,
                        imageUrl: evData.imageUrl || evData.image || '',
                        autoCreated: true,
                        createdAt: FieldValue.serverTimestamp(),
                        updatedAt: FieldValue.serverTimestamp(),
                    }, { merge: true });
                    console.log(`[createOrder] Auto-created product ${orderData.productId} for event ${orderData.eventId}`);
                }
            } else {
                // No productId at all — create a generic product entry keyed by eventId
                const epRef = db.collection('products').where('eventId', '==', orderData.eventId).limit(1);
                const epSnap = await epRef.get();
                if (epSnap.empty) {
                    const evSnap = await db.collection('events').doc(orderData.eventId).get();
                    const evData = evSnap.data() || {};
                    await db.collection('products').add({
                        name: `${evData.title || 'Event'} — Ticket`,
                        description: `Auto-created from checkout. Event: ${orderData.eventId}`,
                        price: orderData.total || 0,
                        currency: orderData.currency || 'PKR',
                        category: 'event_ticket',
                        eventId: orderData.eventId,
                        isActive: true,
                        stock: 999,
                        imageUrl: evData.imageUrl || evData.image || '',
                        autoCreated: true,
                        createdAt: FieldValue.serverTimestamp(),
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.log(`[createOrder] Auto-created product for event ${orderData.eventId} (no productId on order)`);
                }
            }
        }

        // ── Chapter Application Linkage ─────────────────────────────────────
        if (orderData.chapterApplicationId) {
            try {
                await db.collection('chapter_applications').doc(orderData.chapterApplicationId).update({
                    orderId: res.id,
                    status: 'pending_review',
                    updatedAt: FieldValue.serverTimestamp(),
                });
                console.log(`[createOrder] Linked order ${res.id} to chapter application ${orderData.chapterApplicationId}`);
            } catch (e) {
                console.error(`[createOrder] Failed to link chapter application:`, e);
            }
        }

        await db.collection('audit_logs').add({
            action: 'ORDER_CREATED',
            actorUid: orderData.userId,
            targetUidOrResource: res.id,
            payload: {
                total: orderData.total,
                currency: orderData.currency,
                module: orderData.originatingModule,
                productId: orderData.productId
            },
            timestamp: FieldValue.serverTimestamp(),
            source: 'server-action'
        });

        return { success: true, id: res.id };
    } catch (error: any) {
        console.error('Error creating order:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Assassination Trigger: Atomically syncs an event to the Store Products collection.
 * This ensures that a Paid Event is ALWAYS represented as a Store Product.
 */
export async function syncEventToProduct(eventData: any, existingProductId?: string) {
    try {
        const db = await getDb();
        if (!db) throw new Error('Database connection failed');

        const productPayload: any = {
            name: eventData.title,
            description: eventData.description || "",
            price: parseFloat(eventData.amountInput) || 0,
            currency: eventData.currency || "PKR",
            category: "event_ticket",
            eventId: eventData.id || eventData.slug,
            isActive: !!eventData.isPaid,
            imageUrl: eventData.imageUrl || eventData.image || "",
            updatedAt: FieldValue.serverTimestamp(),
            stock: eventData.capacity ? parseInt(eventData.capacity) : 999,
        };

        if (existingProductId && existingProductId !== 'none') {
            await db.collection('products').doc(existingProductId).update(productPayload);
            return { success: true, id: existingProductId };
        } else {
            const newRef = await db.collection('products').add({
                ...productPayload,
                createdAt: FieldValue.serverTimestamp(),
            });
            return { success: true, id: newRef.id };
        }
    } catch (error: any) {
        console.error('Error syncing event to product:', error);
        return { success: false, error: error.message };
    }
}

export async function getPublicProducts(): Promise<{ success: boolean; data?: Product[]; error?: string }> {
    try {
        const db = await getDb();
        if (!db) throw new Error('Database connection failed');

        const productsSnap = await db.collection('products')
            .where('isActive', '==', true)
            .get();

        const products = productsSnap.docs.map(doc => {
            const data = doc.data();
            return {
                ...data,
                id: doc.id,
                createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt,
                updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt,
            } as Product;
        });

        return { success: true, data: products };
    } catch (error: any) {
        console.error('Error fetching public products:', error);
        return { success: false, error: error.message };
    }
}
