import { NextRequest, NextResponse } from 'next/server';
import { paymentService } from '@/services/payment/PaymentService';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';

export async function POST(req: NextRequest) {
    try {
        await ensureAdminInitialized();
        const db = getDb();

        const body = await req.json();
        const { type, itemId, userId } = body;

        if (!type || !itemId || !userId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        let amount = 0;
        let currency = 'USD';
        let title = 'Payment';

        if (type === 'event') {
            const eventDoc = await db.collection('events').doc(itemId).get();
            if (!eventDoc.exists) {
                return NextResponse.json({ error: 'Event not found' }, { status: 404 });
            }
            const data = eventDoc.data();
            amount = data?.paymentDetails?.amount || 0;
            currency = data?.paymentDetails?.currency || 'USD';
            title = data?.title || 'Event Ticket';

            // check if user already registered. For simplicity skipping here or you can check DB
        } else if (type === 'store') {
            // logic for store, let's keep it resilient
            amount = body.amount || 0;
            title = body.title || 'Store Purchase';
        }

        const host = req.headers.get('host') || 'localhost:9004';
        const protocol = req.headers.get('x-forwarded-proto') || 'http';
        const baseUrl = `${protocol}://${host}`;

    const session = await paymentService.createCheckout({
      type,
      itemId,
      userId,
      amount,
      currency,
      successUrl: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/payment/cancel`,
      metadata: { type, itemId, userId },
      lineItems: [
        {
          name: title,
          amount,
          currency,
          quantity: 1,
        }
      ]
    });

    return NextResponse.json(session);
  } catch (error: any) {
    console.error('Checkout error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
