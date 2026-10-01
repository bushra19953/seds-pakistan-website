import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { hasServerPermission } from '@/lib/server/permissions';
import { permissionsConfig } from '@/config/permissions.config';

/** Helper: verify admin token and return role */
async function verifyAdmin(request: NextRequest) {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
}

export async function GET(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        // Get auth from header
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const userRole = decoded.role || '';

        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermission(userRole, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Get pagination params from URL
        const url = new URL(request.url);
        const limitParam = parseInt(url.searchParams.get('limit') || '20');
        const limit = Math.min(Math.max(limitParam, 1), 50); // Between 1 and 50
        const cursor = url.searchParams.get('cursor'); // Last order ID for pagination
        const statusFilter = url.searchParams.get('status'); // Optional status filter

        // Build query with pagination
        let ordersQuery = db.collection('orders').orderBy('createdAt', 'desc');

        // Apply status filter if provided
        if (statusFilter && statusFilter !== 'all') {
            ordersQuery = ordersQuery.where('status', '==', statusFilter);
        }

        // Apply cursor-based pagination (startAfter previous doc)
        if (cursor) {
            const cursorDoc = await db.collection('orders').doc(cursor).get();
            if (cursorDoc.exists) {
                ordersQuery = ordersQuery.startAfter(cursorDoc);
            }
        }

        // Fetch orders with limit + 1 to check if there are more
        const ordersSnap = await ordersQuery.limit(limit + 1).get();
        const allDocs = ordersSnap.docs;
        const hasMore = allDocs.length > limit;
        const docsToReturn = hasMore ? allDocs.slice(0, limit) : allDocs;

        const orders = docsToReturn.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
            updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
        }));

        // Get next cursor (last order ID)
        const nextCursor = hasMore && docsToReturn.length > 0
            ? docsToReturn[docsToReturn.length - 1].id
            : null;

        // Fetch products (cached - no pagination needed for small collection)
        const productsSnap = await db.collection('products').get();
        const products = productsSnap.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
            updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
        }));

        return NextResponse.json({
            ok: true,
            orders,
            products,
            count: orders.length,
            hasMore,
            nextCursor,
            pagination: {
                limit,
                cursor,
                hasMore,
                nextCursor,
            }
        });
    } catch (e: any) {
        console.error('[orders API] GET error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        // Get auth from header
        const authHeader = request.headers.get('authorization');
        let uid: string | null = null;

        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.split('Bearer ')[1];
            const decoded = await admin.auth().verifyIdToken(token);
            uid = decoded.uid;
        }

        const body = await request.json();
        const {
            certificateCode,
            holderUserId,
            buyer,
            amount,
            currency,
            paymentMethod,
            receiptUrl,
            items,
            testMode,
        } = body;

        // Create order
        const orderData = {
            status: 'pending_verification',
            certificateCode: certificateCode || null,
            holderUserId: holderUserId || null,
            buyerUserId: uid,
            buyer: buyer || {},
            amount: amount || null,
            currency: currency || 'PKR',
            paymentMethod: paymentMethod || 'manual',
            receiptUrl: receiptUrl || null,
            testMode: testMode || false,
            items: items || [],
            createdAt: admin.firestore.Timestamp.now(),
            updatedAt: admin.firestore.Timestamp.now(),
        };

        const docRef = await db.collection('orders').add(orderData);
        const orderId = docRef.id;

        // Send notification to admins with store access
        try {
            const buyerName = buyer?.fullName || 'Unknown';
            const itemDescription = items?.[0]?.title || 'Certificate';

            // Multi-channel Admin Alert (P2: In-App + Push)
            notificationService.broadcastByRoles(permissionsConfig.canManageStore, {
                title: '🛒 New Order Placed',
                body: `${buyerName} placed an order for "${itemDescription}" - ${amount} ${currency}`,
                type: 'order',
                link: `/admin/store?tab=orders&orderId=${orderId}`,
            }, 'P2').catch(err => console.error('[orders API] Admin notification failed:', err));

            console.log('[orders API] Admin notification sent for order:', orderId);
        } catch (notifError) {
            console.error('[orders API] Failed to send admin notification:', notifError);
            // Don't fail the order creation if notification fails
        }

        // Also notify the buyer
        if (uid) {
            try {
                // Multi-channel Buyer Receipt (P1: In-App + Push + Email)
                notificationService.send(uid, {
                    title: '✅ Order Created',
                    body: `Your order #${orderId.slice(0, 8)} has been submitted. We'll verify your payment shortly.`,
                    type: 'order',
                    link: `/verify/${certificateCode}`,
                }, 'P1').catch(err => console.error('[orders API] Buyer notification failed:', err));
            } catch (buyerNotifError) {
                console.error('[orders API] Failed to send buyer notification:', buyerNotifError);
            }
        }

        return NextResponse.json({
            ok: true,
            orderId,
            message: 'Order created successfully'
        });
    } catch (e: any) {
        console.error('[orders API] POST error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        // Get auth from header
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        const userRole = decoded.role || '';

        // Check if user has access
        const canManage = await hasServerPermission(userRole, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { orderId, updates } = body;

        if (!orderId || !updates) {
            return NextResponse.json({ error: 'Missing orderId or updates' }, { status: 400 });
        }

        // Allowed status transitions
        const allowedStatuses = ['pending_verification', 'verified', 'processing', 'shipped', 'delivered', 'cancelled'];
        if (updates.status && !allowedStatuses.includes(updates.status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }

        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        const orderData = orderSnap.data();
        const updatesToApply = {
            ...updates,
            updatedAt: admin.firestore.Timestamp.now(),
        };

        await orderRef.update(updatesToApply);

        // UNIFIED LEDGER BRIDGE: If an order is explicitly verified, automatically increment/register the event ticket
        if (updates.status === 'verified' && orderData?.items) {
            for (const item of orderData.items) {
                if ((item.type === 'event_ticket' || orderData.originatingModule === 'Events') && (item.eventId || orderData.eventId) && orderData.buyerUserId) {
                    try {
                        const targetEventId = item.eventId || orderData.eventId;
                        const eventRef = db.collection('events').doc(targetEventId);

                        // Unified Registration: Mark the user as a registered attendee
                        await eventRef.update({
                            attendeeIds: admin.firestore.FieldValue.arrayUnion(orderData.buyerUserId)
                        });

                        // Create the EventRegistrationDoc linking User, Event, and Transaction
                        const eventRegistrationRef = db.collection('events').doc(targetEventId).collection('registrations').doc(orderData.buyerUserId);
                        await eventRegistrationRef.set({
                            uid: orderData.buyerUserId,
                            eventId: targetEventId,
                            transactionId: orderId,
                            displayName: orderData.buyer?.fullName || 'Unknown',
                            email: orderData.buyer?.email || '',
                            status: 'confirmed',
                            paymentStatus: 'verified',
                            paymentMethod: orderData.paymentMethod || 'manual',
                            paymentRef: orderData.paymentRef || orderData.receiptUrl || '',
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });

                        console.log(`[orders API] Unified Ledger: Successfully registered user ${orderData.buyerUserId} for Event ${targetEventId} with transaction ${orderId}`);
                    } catch (err) {
                        console.error('[orders API] Unified Ledger Sync Failed:', err);
                    }
                }
            }
        }

        // Notify buyer of status change
        if (updates.status && orderData?.buyerUserId) {
            try {
                const statusMessages: Record<string, string> = {
                    'verified': 'Your payment has been verified! We\'ve processed your registration.',
                    'processing': 'Your order is being processed.',
                    'shipped': 'Your order has been shipped!',
                    'delivered': 'Your order has been delivered. Enjoy!',
                    'cancelled': 'Your order has been cancelled.',
                };

                let message = statusMessages[updates.status];
                let title = `📦 Order Update`;
                let link = `/verify/${orderData.certificateCode}`;

                // Refinement: If it's a verified ticket, give them the ticket link
                if (updates.status === 'verified' && orderData?.items?.some((i: any) => i.type === 'event_ticket')) {
                    const ticketItem = orderData.items.find((i: any) => i.type === 'event_ticket');
                    title = `🎟️ Ticket Confirmed!`;
                    message = `Your registration for "${ticketItem.title || 'the event'}" is confirmed. You can now access your ticket.`;
                    link = `/events/${ticketItem.eventId || orderData.eventId}`;
                }

                if (message) {
                    // Multi-channel Transition Alert (P1: In-App + Push + Email)
                    notificationService.send(orderData.buyerUserId, {
                        title,
                        body: message,
                        type: 'order',
                        link,
                    }, 'P1').catch(err => console.error('[orders API] Status notification failed:', err));
                }
            } catch (notifError) {
                console.error('[orders API] Failed to send status notification:', notifError);
            }
        }

        return NextResponse.json({ ok: true, orderId });
    } catch (e: any) {
        console.error('[orders API] PATCH error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });

        const decoded = await verifyAdmin(request);
        const userRole = decoded.role || '';

        // Check if user has access
        const canManage = await hasServerPermission(userRole, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const url = new URL(request.url);
        const orderId = url.searchParams.get('orderId');
        if (!orderId) return NextResponse.json({ error: 'Missing orderId query param' }, { status: 400 });

        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

        await orderRef.delete();
        console.log(`[orders API] DELETE: order ${orderId} permanently deleted by ${decoded.uid}`);

        return NextResponse.json({ ok: true, orderId, deleted: true });
    } catch (e: any) {
        console.error('[orders API] DELETE error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: e.status || 500 });
    }
}
