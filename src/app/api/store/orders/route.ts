import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { permissionsConfig } from '@/config/permissions.config';
import { setMoneyAudit, deriveOrderAuditAction, isSoftDeleted } from '@/lib/server/money-audit';
import { normalizeOrder } from '@/lib/finance/order-canonical';

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

        // Check if user has access using dynamic permissions
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Get pagination params from URL
        const url = new URL(request.url);
        const limitParam = parseInt(url.searchParams.get('limit') || '20');
        const limit = Math.min(Math.max(limitParam, 1), 50); // Between 1 and 50
        const cursor = url.searchParams.get('cursor'); // Last order ID for pagination
        const statusFilter = url.searchParams.get('status'); // Optional status filter
        const includeDeleted = url.searchParams.get('includeDeleted') === 'true';

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
        // Soft-delete filter (Item 7): hide soft-deleted orders unless the
        // caller explicitly opts in with ?includeDeleted=true. Firestore
        // cannot filter "field absent OR null", so filter in code.
        const fetchedDocs = includeDeleted
            ? ordersSnap.docs
            : ordersSnap.docs.filter((d: any) => !isSoftDeleted(d.data()));
        const allDocs = fetchedDocs;
        const hasMore = allDocs.length > limit;
        const docsToReturn = hasMore ? allDocs.slice(0, limit) : allDocs;

        const orders = docsToReturn.map(doc => {
            const raw = doc.data();
            // Compat reader (CH-13): stored fields are preserved AND the
            // canonical view is added alongside (totalPkr, canonical
            // status/paymentStatus/buyerUserId, receiptUrl). Existing
            // clients keep working; new clients read the canonical fields.
            const canonical = normalizeOrder(raw, doc.id);
            return {
                id: doc.id,
                ...raw,
                totalPkr: canonical.totalPkr,
                declaredAmountPkr: canonical.declaredAmountPkr,
                status: canonical.status,
                paymentStatus: canonical.paymentStatus,
                buyerUserId: canonical.buyerUserId,
                receiptUrl: canonical.receiptUrl,
                receiptDriveId: canonical.receiptDriveId,
                isDeleted: canonical.isDeleted,
                createdAt: raw.createdAt?.toDate?.()?.toISOString() || null,
                updatedAt: raw.updatedAt?.toDate?.()?.toISOString() || null,
            };
        });

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

        // Auth is REQUIRED (CH-13, spec 4.8): the previous optional-token
        // behaviour let anonymous callers create orders in anyone's name.
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        let uid: string;
        try {
            const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
            uid = decoded.uid;
        } catch {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const {
            certificateCode,
            holderUserId,
            buyer,
            amount,
            total,
            currency,
            paymentMethod,
            receiptUrl,
            receiptDriveId,
            items,
            testMode,
            originatingModule,
            productId,
        } = body;

        // Server-side price verification for every non-donation module:
        // the claimed amount must equal the server-priced total (422).
        const isDonation = originatingModule === 'donation';
        const claimed: number | null = typeof amount === 'number' ? amount : typeof total === 'number' ? total : null;
        let verifiedTotalPkr: number | null = claimed;
        if (!isDonation) {
            const pid = productId || items?.[0]?.productId;
            if (pid) {
                const pSnap = await db.collection('products').doc(pid).get();
                if (pSnap.exists && typeof pSnap.data()?.price === 'number') {
                    const serverPrice = pSnap.data()!.price as number;
                    const qty = items?.[0]?.quantity ?? 1;
                    if (claimed !== serverPrice * qty) {
                        return NextResponse.json(
                            { error: 'Price verification failed: claimed amount does not match the server price' },
                            { status: 422 },
                        );
                    }
                    verifiedTotalPkr = serverPrice * qty;
                }
            }
        }
        const isUsdCertificate = (currency || 'PKR') === 'USD';

        // Canonical order shape (CH-13, spec 3.5) + compat dual-write.
        const orderData = {
            status: 'pending_verification',
            paymentStatus: 'pending',
            certificateCode: certificateCode || null,
            holderUserId: holderUserId || null,
            buyerUserId: uid,
            userId: uid,
            buyer: buyer || {},
            totalPkr: isDonation || isUsdCertificate ? null : verifiedTotalPkr,
            total: isUsdCertificate || isDonation ? claimed : verifiedTotalPkr,
            declaredAmountPkr: isDonation ? claimed : null,
            amount: claimed,
            currency: currency || 'PKR',
            paymentMethod: paymentMethod || 'manual',
            receiptUrl: receiptUrl || null,
            receiptDriveId: receiptDriveId || null,
            isDeleted: false,
            originatingModule: originatingModule || 'store',
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

        // Check if user has access
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { orderId, updates } = body;

        if (!orderId || !updates) {
            return NextResponse.json({ error: 'Missing orderId or updates' }, { status: 400 });
        }

        // Money-field guard (CH-09/CH-13, spec 2.1): PATCH accepts ONLY
        // non-money fields now. Any money field, or a transition into a
        // money state (verified / refunded / soft_deleted), is a 409
        // pointing at the approvals flow, which performs the change with
        // maker-checker and the audit record. This closes the hole where
        // one store officer could verify money alone.
        const MONEY_FIELDS = ['total', 'totalPkr', 'amount', 'amountPkr', 'declaredAmountPkr', 'paymentStatus', 'paymentMethod', 'receiptUrl', 'receiptDriveId', 'isDeleted'];
        const MONEY_STATUSES = ['verified', 'refunded', 'soft_deleted'];
        const touchedMoney =
            MONEY_FIELDS.some((f) => f in updates) || (updates.status && MONEY_STATUSES.includes(updates.status));
        if (touchedMoney) {
            return NextResponse.json(
                {
                    error: 'Money state changes require the approvals flow',
                    useInstead: 'POST /api/admin/finance/approvals',
                },
                { status: 409 },
            );
        }

        // Allowed non-money status transitions (fulfilment movement only)
        const allowedStatuses = ['pending_verification', 'processing', 'shipped', 'delivered', 'cancelled'];
        if (updates.status && !allowedStatuses.includes(updates.status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }
        const NON_MONEY_FIELDS = ['status', 'fulfilmentNote'];
        const sanitized: Record<string, unknown> = {};
        for (const f of NON_MONEY_FIELDS) {
            if (updates[f] !== undefined) sanitized[f] = updates[f];
        }

        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        const orderData = orderSnap.data();
        const updatesToApply = {
            ...sanitized,
            updatedAt: admin.firestore.Timestamp.now(),
        };

        // Money audit (Phase 0 Item 7): audit entry + state change in ONE
        // batch, fail closed — if the audit write fails, the money change
        // does not land. Kept at integration: finance's CH-13 guard above
        // decides WHICH updates may land; this batch decides that every
        // landed money change is audited.
        const before = {
            status: (orderData as any)?.status ?? null,
            paymentStatus: (orderData as any)?.paymentStatus ?? null,
        };
        const after = {
            status: updates.status !== undefined ? updates.status : before.status,
            paymentStatus: updates.paymentStatus !== undefined ? updates.paymentStatus : before.paymentStatus,
        };
        const batch = db.batch();
        batch.update(orderRef, updatesToApply);
        setMoneyAudit(batch, db as never, {
            action: deriveOrderAuditAction(updates),
            actorUid: decoded.uid,
            actorRole: '',
            targetType: 'order',
            targetId: orderId,
            orderId,
            before,
            after,
            changedFields: Object.keys(updates),
            reason: null,
            source: 'store_orders_api',
        });
        await batch.commit();

        // NOTE (CH-13): the verified-payment event registration mirror that
        // used to run here (the legacy "Unified Ledger Bridge") now lives in
        // the money-approvals apply handlers
        // (src/lib/finance/money-approval.ts), because verification itself
        // moved behind maker-checker. It is NOT re-run here: doing both
        // would double-register attendees.

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

        // Check if user has access
        const canManage = await hasServerPermissionForUser(db, decoded.uid, 'canManageStore');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Hard delete is RETIRED (CH-13, spec 2.3): orders are never
        // destroyed. Removal is a soft delete through the approvals flow
        // (targetType order_soft_delete, reason mandatory). Phase 0's
        // in-route soft delete is superseded by that flow; the soft-delete
        // fields it stamped remain on the order type and the GET paths
        // still filter soft-deleted orders out.
        void decoded;
        return NextResponse.json(
            {
                error: 'Hard delete is retired. Orders are removed via soft delete through the approvals flow.',
                useInstead: 'POST /api/admin/finance/approvals with targetType order_soft_delete',
            },
            { status: 410 },
        );
    } catch (e: any) {
        console.error('[orders API] DELETE error:', e);
        return NextResponse.json({ error: e.message || 'Internal error' }, { status: e.status || 500 });
    }
}
