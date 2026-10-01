import Stripe from 'stripe';
import { CheckoutSessionRequest, CheckoutSessionResponse, PaymentProvider, WebhookResult } from '../PaymentProvider';

export class StripeProvider implements PaymentProvider {
    public name = 'stripe';
    private _stripe: Stripe | null = null;

    private get stripe(): Stripe {
        if (!this._stripe) {
            const key = process.env.STRIPE_SECRET_KEY || '';
            if (!key) {
                // If it's build time, we might not have the key. 
                // We'll throw only when an actual operation is attempted.
                console.warn('StripeProvider: STRIPE_SECRET_KEY is missing. Stripe operations will fail.');
            }
            this._stripe = new Stripe(key, {
                apiVersion: '2025-01-27.acacia',
            });
        }
        return this._stripe;
    }

    constructor() {
        // No longer initializing stripe here to avoid build-time errors
    }

    async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResponse> {
        const sessionItems: Stripe.Checkout.SessionCreateParams.LineItem[] = request.lineItems ? request.lineItems.map(item => ({
            price_data: {
                currency: item.currency,
                product_data: {
                    name: item.name,
                    description: item.description,
                    images: item.images,
                },
                unit_amount: Math.round(item.amount * 100), // Stripe expects cents/smallest currency unit for most currencies
            },
            quantity: item.quantity,
        })) : [
            {
                price_data: {
                    currency: request.currency,
                    product_data: {
                        name: `${request.type.toUpperCase()} - ${request.itemId}`,
          },
          unit_amount: Math.round(request.amount * 100),
        },
        quantity: 1,
      }
    ];

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: sessionItems,
      mode: 'payment',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      customer_email: request.customerEmail,
      client_reference_id: request.userId,
      metadata: {
        ...request.metadata,
        type: request.type,
        itemId: request.itemId,
        userId: request.userId,
      },
    });

    if (!session.url) {
      throw new Error("Failed to create Stripe checkout session URL.");
    }

    return {
      id: session.id,
      url: session.url,
      provider: this.name,
    };
  }

  async handleWebhook(payload: any, signature: string, secret?: string): Promise<WebhookResult> {
    try {
      const webhookSecret = secret || process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        throw new Error("Missing STRIPE_WEBHOOK_SECRET");
      }

      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret
      );

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          status: 'processed',
          provider: this.name,
          orderId: session.id, // we might match on session.metadata.orderId if we created one beforehand
          eventType: event.type,
          metadata: session.metadata as Record<string, string> | undefined,
        };
      }

      return {
        status: 'ignored',
        provider: this.name,
        eventType: event.type,
      };
    } catch (err: any) {
      console.error(`Stripe webhook signature verification failed: ${err.message}`);
      return {
        status: 'failed',
        provider: this.name,
      };
    }
  }
}
