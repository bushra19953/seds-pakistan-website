export interface CheckoutSessionRequest {
    type: 'event' | 'store' | 'membership';
    itemId: string;
    userId: string;
    amount: number;
    currency: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    customerEmail?: string;
    lineItems?: Array<{
        name: string;
        description?: string;
        images?: string[];
        amount: number;
        currency: string;
        quantity: number;
    }>;
}

export interface CheckoutSessionResponse {
    id: string;
    url: string;
    provider: string;
}

export interface WebhookResult {
    status: 'ignored' | 'processed' | 'failed';
    provider: string;
    orderId?: string;
    eventType?: string;
    metadata?: Record<string, string>;
}

export interface PaymentProvider {
    name: string;
    createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResponse>;
    handleWebhook(payload: any, signature: string, secret?: string): Promise<WebhookResult>;
}
