import { CheckoutSessionRequest, CheckoutSessionResponse, PaymentProvider, WebhookResult } from './PaymentProvider';
import { StripeProvider } from './providers/StripeProvider';

export class PaymentService {
    private providers: Map<string, PaymentProvider>;
    private defaultProvider: string;

    constructor() {
        this.providers = new Map();
        // Register providers
        this.registerProvider(new StripeProvider());
        this.defaultProvider = 'stripe';
    }

    registerProvider(provider: PaymentProvider) {
        this.providers.set(provider.name, provider);
    }

    async createCheckout(request: CheckoutSessionRequest, providerName?: string): Promise<CheckoutSessionResponse> {
        const name = providerName || this.defaultProvider;
        const provider = this.providers.get(name);

        if (!provider) {
            throw new Error(`Payment provider '${name}' not found.`);
    }

    return provider.createCheckoutSession(request);
  }

  async handleWebhook(providerName: string, payload: any, signature: string, secret?: string): Promise<WebhookResult> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Payment provider '${providerName}' not found.`);
    }

    return provider.handleWebhook(payload, signature, secret);
  }
}

// Singleton instance
export const paymentService = new PaymentService();
