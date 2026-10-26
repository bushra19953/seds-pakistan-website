'use server';

import { getDb } from '@/lib/server/firebase-admin';
import { Product, Order } from '@/types/store';
import { FieldValue } from 'firebase-admin/firestore';
import {
    getProductFromSupa,
    listPublicProductsFromSupa,
    storeActionsPrimaryEnabled,
    getStoreProductForVerification,
    createOrderViaStorePrimary,
    syncEventProductViaPrimary,
} from '@/lib/supa/store-actions';
import { makeStoreDocId, toSupaStorePayload } from '@/lib/supa/store-primary';
import { mirrorChapterApplicationUpdate, updateChapterApplicationPrimaryFirst } from '@/lib/applications-supa';

export async function getProduct(productId: string): Promise<{ success: boolean; data?: Product; error?: string }> {
    try {
        // Supabase read path (flag 'store-actions'): a non-null seam result
        // is authoritative (found or not-found); null falls through to the
        // Firestore read below byte-identically.
        const supaProduct = await getProductFromSupa(productId);
        if (supaProduct) {
            return supaProduct.found
                ? { success: true, data: supaProduct.data as unknown as Product }
                : { success: false, error: 'Product not found' };
        }
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

        // Item 9: donations flag enforcement (authoritative server gate).
        // Strict !== true means a missing doc, missing field, or any
        // non-boolean value fails closed. Runs after the blacklist check
        // and before any order write. (Kept at integration: finance's
        // CH-13 block below skips price verification for donations, so
        // this gate is the only donation control on this path.)
        if (orderData.originatingModule === 'donation') {
            const settingsSnap = await db.collection('settings').doc('siteWide').get();
            const enableDonations = settingsSnap.exists ? settingsSnap.data()?.enableDonations : undefined;
            if (enableDonations !== true) {
                throw new Error('Donations are currently disabled.');
            }
        }

        // ── Server-side price verification (CH-13, spec 2.2) ─────────────
        // Runs for EVERY non-donation module: the claimed total must equal
        // the server-priced total or the write is rejected. totalPkr below
        // comes from the verified price, never from the client claim alone.
        const isDonation = orderData.originatingModule === 'donation';
        const claimedTotal: number | null =
            typeof orderData.total === 'number' ? orderData.total
            : typeof orderData.amount === 'number' ? orderData.amount
            : null;
        let verifiedTotalPkr: number | null = claimedTotal;
        // WRITE PRIMACY (S-W3): with isSupaPrimary('store-actions') on,
        // product prices are read from fs_products (flip order puts
        // products primacy first, so Firestore prices would be stale);
        // the blacklist / donation gates above stay Firestore reads
        // exactly as today (foreign slices' read-through, design §3.3).
        // With primacy OFF every read below is the Firestore read it
        // replaces, byte-identically.
        const actionsPrimary = storeActionsPrimaryEnabled();
        const readProductPrice = async (pid: string): Promise<{ exists: boolean; price?: number }> => {
            if (actionsPrimary) {
                const v = await getStoreProductForVerification(pid);
                return { exists: !!v?.found, price: typeof v?.price === 'number' ? v.price : undefined };
            }
            const snap = await db.collection('products').doc(pid).get();
            return { exists: snap.exists, price: snap.data()?.price };
        };
        if (!isDonation) {
            if (orderData.productId) {
                const productSnap = await readProductPrice(orderData.productId);
                if (productSnap.exists) {
                    const actualPrice = productSnap.price;
                    if (actualPrice !== undefined && claimedTotal !== actualPrice) {
                        console.error(`Security Alert: Price mismatch for product ${orderData.productId}. Client sent ${claimedTotal}, DB has ${actualPrice}`);
                        throw new Error('Security Error: Price tampering detected.');
                    }
                    verifiedTotalPkr = actualPrice as number;
                }
            }
            if (Array.isArray(orderData.items) && orderData.items.length > 0) {
                let sum = 0;
                let priced = true;
                for (const item of orderData.items) {
                    if (!item?.productId) { priced = false; break; }
                    const pSnap = await readProductPrice(item.productId);
                    if (!pSnap.exists || typeof pSnap.price !== 'number') { priced = false; break; }
                    sum += (pSnap.price as number) * (item.quantity ?? 1);
                }
                if (priced) {
                    if (claimedTotal !== sum) {
                        console.error(`Security Alert: Items total mismatch. Client sent ${claimedTotal}, server sum ${sum}`);
                        throw new Error('Security Error: Price tampering detected.');
                    }
                    verifiedTotalPkr = sum;
                }
            }
        }

        // ── Canonical order shape (CH-13, spec 3.5) ──────────────────────
        // New writes carry canonical fields only, plus the compat dual-write
        // of `total`. Donations record declaredAmountPkr (totalPkr stays
        // null until verification). The legacy USD certificate product is
        // the one documented exception: it keeps total + currency and gets
        // no totalPkr, and is excluded from PKR reports.
        const isUsdCertificate = orderData.currency === 'USD';
        const finalOrder = {
            ...orderData,
            buyerUserId: orderData.userId,
            totalPkr: isDonation || isUsdCertificate ? null : verifiedTotalPkr,
            total: isUsdCertificate ? claimedTotal : (isDonation ? claimedTotal : verifiedTotalPkr),
            declaredAmountPkr: isDonation ? claimedTotal : null,
            receiptDriveId: orderData.receiptDriveId ?? null,
            isDeleted: false,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            status: 'pending_verification',
            paymentStatus: 'pending',
            securityAudit: {
                clientIp: 'logged',
                verifiedAt: FieldValue.serverTimestamp(),
                priceVerified: !isDonation
            }
        };

        // WRITE PRIMACY (S-W3, isSupaPrimary('store-actions')): ONE
        // tx_store_create_order call commits A1 (order) + A2 (event
        // registration mirror) + A3 (product stub) + A5 (audit)
        // atomically — a failure inside the tx persists NOTHING, where
        // the Firestore chain below can orphan the order. A tx error
        // propagates to this action's catch ({ success: false }) with
        // no Firestore fallback. The chapter-application link (A4)
        // stays post-tx best-effort, by design (§3.3).
        if (actionsPrimary) {
            const primaryOrderId = makeStoreDocId();
            const nowIso = new Date().toISOString();
            const supaOrderData = toSupaStorePayload(finalOrder, nowIso) as Record<string, unknown>;
            const supaRegistration = orderData.eventId ? {
                uid: orderData.userId,
                orderId: primaryOrderId,
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
                createdAt: nowIso,
                updatedAt: nowIso,
            } : null;
            const primaryResult = await createOrderViaStorePrimary({
                orderId: primaryOrderId,
                orderData: supaOrderData,
                eventId: orderData.eventId || null,
                registration: supaRegistration,
                productId: orderData.productId || null,
                auditPayload: {
                    total: orderData.total,
                    currency: orderData.currency,
                    module: orderData.originatingModule,
                    productId: orderData.productId
                },
                idempotencyKey: orderData.idempotencyKey ?? null,
            });
            const committedOrderId = primaryResult.orderId as string;
            console.log(`Order Created: ${committedOrderId} | Module: ${orderData.originatingModule} | User: ${orderData.userId}`);
            if (orderData.eventId) {
                console.log(`Registration mirrored → events/${orderData.eventId}/registrations/${orderData.userId}`);
            }
            // A4: chapter application link — post-tx best-effort, unchanged.
            if (orderData.chapterApplicationId) {
                try {
                    await db.collection('chapter_applications').doc(orderData.chapterApplicationId).update({
                        orderId: committedOrderId,
                        status: 'pending_review',
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.log(`[createOrder] Linked order ${committedOrderId} to chapter application ${orderData.chapterApplicationId}`);
                } catch (e) {
                    console.error(`[createOrder] Failed to link chapter application:`, e);
                }
            }
            return { success: true, id: committedOrderId };
        }

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
                const linkPayload = {
                    orderId: res.id,
                    status: 'pending_review',
                    updatedAt: FieldValue.serverTimestamp(),
                };
                await db.collection('chapter_applications').doc(orderData.chapterApplicationId).update(linkPayload);
                // Applications mirror completeness (apps-1): this update
                // previously never reached fs_chapter_applications (the
                // same payload as linkOrderToApplication, which does
                // mirror). Dual-write: the never-throwing seam mirror.
                // Write primacy: the throwing primary update replaces it
                // as the commit gate — its failure lands in the catch
                // below, which is this host flow's deliberate semantics
                // (an order never fails because linkage failed), so a
                // primary failure is logged loudly, not surfaced.
                const gated = await updateChapterApplicationPrimaryFirst(orderData.chapterApplicationId, linkPayload);
                if (!gated) {
                    await mirrorChapterApplicationUpdate(orderData.chapterApplicationId, linkPayload);
                }
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

        // WRITE PRIMACY (S-W4, isSupaPrimary('store-actions')): the
        // single-row write goes through the adapter; the payload is
        // byte-identical apart from timestamp representation
        // (serverTimestamp sentinel -> ISO string, the adapter's
        // storage ruling). EV-P07 semantics (category 'event_ticket',
        // product-link fields) untouched.
        const supaSync = await syncEventProductViaPrimary({
            payload: {
                ...productPayload,
                updatedAt: new Date().toISOString(),
                ...(existingProductId && existingProductId !== 'none'
                    ? {}
                    : { createdAt: new Date().toISOString() }),
            },
            existingProductId,
        });
        if (supaSync) {
            return { success: true, id: supaSync.id };
        }

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
        // Supabase read path (flag 'store-actions'): null falls through to
        // the Firestore read below byte-identically.
        const supaProducts = await listPublicProductsFromSupa();
        if (supaProducts) {
            return { success: true, data: supaProducts as unknown as Product[] };
        }
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
