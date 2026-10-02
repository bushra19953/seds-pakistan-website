import { NextRequest, NextResponse } from 'next/server';
import { paymentService } from '@/services/payment/PaymentService';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { FieldValue } from 'firebase-admin/firestore';

export async function POST(req: NextRequest) {
    try {
        const signature = req.headers.get('stripe-signature');
        if (!signature) {
            return NextResponse.json({ error: 'No signature' }, { status: 400 });
        }

        const payload = await req.text();
        const result = await paymentService.handleWebhook('stripe', payload, signature);

        if (result.status === 'failed') {
            return NextResponse.json({ error: 'Webhook processing failed' }, { status: 400 });
        }

        if (result.status === 'processed' && result.eventType === 'checkout.session.completed') {
            await ensureAdminInitialized();
            const db = getDb();
            if (!db) {
                console.error('[payments:webhook] Firestore not initialized');
                return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
            }

            const { metadata } = result;
            if (metadata && metadata.type === 'event') {
                const { itemId, userId } = metadata;

                // 1. Add user to event's registered attendees
                const eventRef = db.collection('events').doc(itemId);
                await eventRef.update({
                    attendeeIds: FieldValue.arrayUnion(userId),
                });

                // 2. Add to a central orders/payments collection so the user has a transaction history
                await db.collection('orders').add({
                    status: "paid",
                    originatingModule: "Events",
                    eventId: itemId,
                    buyerUserId: userId,
                    paymentMethod: "stripe",
                    externalOrderId: result.orderId,
                    createdAt: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp(),
                });
                // 3. Multi-channel Notification (P1: In-App + Push + Email)
                const eventData = (await eventRef.get()).data();
                notificationService.send(userId, {
                    type: 'event_payment_confirmed',
                    title: '🎟️ Payment Confirmed!',
                    body: `Your payment for "${eventData?.title || 'the event'}" has been confirmed. Your ticket is being issued.`,
                    link: `/profile/unified?uid=${userId}`,
                }, 'P1').catch(err => console.error('[payments/webhook] Notification failed:', err));
            }

            // handle other types like 'store' or 'membership' here mapping their specific business logic
        }

        return NextResponse.json({ received: true });
    } catch (error: any) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
