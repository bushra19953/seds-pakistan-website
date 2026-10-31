
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
    /**
     * CANONICAL identity field (CH-13, spec Part C 3.5). userId below is a
     * deprecated alias kept only for legacy readers; new writes set
     * buyerUserId and mirror userId during the dual-write window.
     */
    buyerUserId: string;
    /** @deprecated legacy alias of buyerUserId */
    userId?: string;
    items: OrderItem[];
    /** CANONICAL amount in whole PKR (spec 3.5). Null for donation orders until verification. */
    totalPkr: number | null;
    /** @deprecated compat dual-write mirroring totalPkr (removed after the migration window) */
    total?: number;
    /** Donation orders: the donor-declared amount until verification sets totalPkr. */
    declaredAmountPkr?: number | null;
    currency: string;
    /** CANONICAL status enum (spec 3.5). */
    status: 'pending_verification' | 'verified' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded' | 'soft_deleted';
    paymentMethod?: string; // e.g., 'bank_transfer', 'easypaisa', 'jazzcash'
    paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded';
    receiptUrl?: string | null;
    receiptDriveId?: string | null;
    /** Soft-delete (spec 2.3): orders are never hard-deleted. */
    isDeleted?: boolean;
    deletedBy?: string;
    deleteReason?: string;
    deleteApprovalId?: string;
    fulfilmentNote?: string;
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
    /** Vendor shop pilot (GF, ruling R-16): an open return claim holds the order's commission entry. Absent means false. */
    returnClaimOpen?: boolean;
    receiptUrl?: string; // Legacy field, mapping to proofOfPaymentUrl for consistency
    deletedAt?: Timestamp | null;
    deletedBy?: string | null;
    deletedByRole?: string | null;
    deleteReason?: string | null;
}
