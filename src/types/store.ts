
import { Timestamp } from 'firebase/firestore';

export interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    stock: number;
    category: string;
    eventId?: string;
    formId?: string; // Link to a custom form (from /admin/forms)
    isActive: boolean;
    imageUrl?: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy?: string;
}

export interface OrderItem {
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    subtotal: number;
}

export interface Order {
    id: string;
    userId: string;
    items: OrderItem[];
    total: number;
    currency: string;
    status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
    paymentMethod?: string; // e.g., 'bank_transfer', 'easypaisa', 'jazzcash'
    paymentStatus?: 'pending' | 'completed' | 'failed' | 'refunded';
    proofOfPaymentUrl?: string; // Receipt URL
    shippingAddress?: {
        name: string;
        address: string;
        city: string;
        postalCode: string;
        country: string;
    };
    buyer?: {
        fullName: string;
        email: string;
        phone?: string;
    };
    notes?: string;
    formResponses?: Record<string, any>; // Responses to the custom linked form
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy: string;
    updatedBy?: string;
    originatingModule?: string; // 'store', 'chapter-registration', 'donation'
    eventId?: string;
    productId?: string; // For single-product orders
    testMode?: boolean;
    receiptUrl?: string; // Legacy field, mapping to proofOfPaymentUrl for consistency
}
