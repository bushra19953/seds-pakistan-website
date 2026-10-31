import { NextRequest, NextResponse } from 'next/server';
import admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import { notificationService } from '@/lib/server/notification-service';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { permissionsConfig } from '@/config/permissions.config';
import { setMoneyAudit, deriveOrderAuditAction, isSoftDeleted } from '@/lib/server/money-audit';
import { normalizeOrder } from '@/lib/finance/order-canonical';
import {
    getStoreOrdersPageFromSupa,
    getStoreProductForOrderEnrichment,
    getVendorForOrderEnrichment,
    isoOrNull,
    storeOrdersPrimaryEnabled,
    createStoreOrderViaPrimary,
    patchStoreOrderViaPrimary,
} from '@/lib/supa/store-orders';
import { makeStoreDocId } from '@/lib/supa/store-primary';
import { getPaymentMethodsSettings } from '@/app/actions/payment-methods';
import {
    VendorOrderError,
    SHOP_METHOD_MISSING_ADMIN_MESSAGE,
    applyCreditConsumptionInTransaction,
    asVendorOrderError,
    buildVendorOrderFields,
    classifyVendorOrder,
    planStoreCreditConsumption,
    planStoreCreditsInTransaction,
    promisedDeliveryDateString,
    requireDeliveryPkr,
    requireVendorCurrencyPkr,
    requireVendorSellable,
    requireVendorStock,
    resolveShopMethodKey,
    restoreStoreCreditConsumption,
    type ReferencedLine,
    type VendorProductFacts,
} from '@/lib/server/store-vendor-order';
import {
    assertGroupBuySeatAvailable,
    registerGroupBuySeat,
    registerGroupBuySeatTx,
    releaseGroupBuySeat,
} from '@/lib/server/group-buys';
import { encodeStoreOrdersCursor, keyOfStoreOrder } from '@/lib/supa/store-orders-keyset';
import {
    PriceVerificationError,
    coerceServerPrice,
    priceOrderServerSide,
    type ServerProductRecord,
} from '@/lib/server/store-pricing';
import { createOrderWithIdempotencyClaim } from '@/lib/server/order-idempotency';
import { vendorPatchGuard } from '@/lib/server/vendor-money';
import { deliverVendorOrder } from '@/lib/server/vendor-delivery';

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

        // Supabase read path (flag 'store-orders-api'): the seam returns
        // the raw fetched page (limit+1, pre-filter) + embedded products;
        // the presentation semantics below (soft-delete filter,
        // normalizeOrder overlay, hasMore/cursor, envelope) are the same
        // code the Firestore path applies to its snapshot. A null seam
        // result (OFF / unconfigured / adapter error) falls through to
        // the Firestore fetch byte-identically.
        const supaPage = await getStoreOrdersPageFromSupa({ limit, cursor, statusFilter });
        if (supaPage && 'invalidCursor' in supaPage) {
            // Keyset cursor protocol (S-K3): an unusable cursor is a
            // client error, never a silent page-1 restart.
            return NextResponse.json(
                { error: 'invalid_cursor', code: supaPage.code },
                { status: 400 },
            );
        }
        if (supaPage) {
            const fetchedDocs = includeDeleted
                ? supaPage.fetched
                : supaPage.fetched.filter((d) => !isSoftDeleted(d.raw));
            const hasMoreSupa = fetchedDocs.length > limit;
            const docsToReturnSupa = hasMoreSupa ? fetchedDocs.slice(0, limit) : fetchedDocs;

            const ordersSupa = docsToReturnSupa.map(({ id, raw }) => {
                const canonical = normalizeOrder(raw, id);
                return {
                    id,
                    ...raw,
                    totalPkr: canonical.totalPkr,
                    declaredAmountPkr: canonical.declaredAmountPkr,
                    status: canonical.status,
                    paymentStatus: canonical.paymentStatus,
                    buyerUserId: canonical.buyerUserId,
                    receiptUrl: canonical.receiptUrl,
                    receiptDriveId: canonical.receiptDriveId,
                    isDeleted: canonical.isDeleted,
                    createdAt: isoOrNull(raw.createdAt),
                    updatedAt: isoOrNull(raw.updatedAt),
                };
            });

            // Keyset (S-K3): nextCursor is the opaque v1 cursor minted
            // from the last RETURNED row's (createdAt, id) key — never a
            // bare id, never the last fetched (pre-filter) row.
            const lastSupaRow = docsToReturnSupa[docsToReturnSupa.length - 1];
            const lastSupaKey = hasMoreSupa && lastSupaRow
                ? keyOfStoreOrder({ id: lastSupaRow.id, createdAt: lastSupaRow.raw.createdAt })
                : null;
            const nextCursorSupa = lastSupaKey
                ? encodeStoreOrdersCursor(lastSupaKey, statusFilter)
                : null;

            return NextResponse.json({
                ok: true,
                orders: ordersSupa,
                products: supaPage.products,
                count: ordersSupa.length,
                hasMore: hasMoreSupa,
                nextCursor: nextCursorSupa,
                pagination: {
                    limit,
                    cursor,
                    hasMore: hasMoreSupa,
                    nextCursor: nextCursorSupa,
                }
            });
        }

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

        // Fetch products (small collection). READ-BLEED FIX
        // (census 11): this Firestore fallback leg was an UNBOUNDED
        // .get(); bounded at 1000 like the other product loads so a
        // darkened Supabase seam cannot turn one orders view into a
        // full-collection scan as the catalogue grows. The primary
        // (Supabase) leg above is untouched.
        const productsSnap = await db.collection('products').limit(1000).get();
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
            eventId,
            groupBuyId,
        } = body;

        // Server-side price verification for every non-donation module
        // (audit item 4: FAIL CLOSED, EVERY item): the shared pricing
        // helper (src/lib/server/store-pricing.ts, the same one the
        // checkout server action uses) prices every referenced product
        // from the server-side product record; a missing, inactive, or
        // unpriced product — or a claimed total that differs from the
        // server-priced total — is a 422, never a trusted claim. (The
        // previous code priced only items[0] and trusted the claim
        // whenever that product was missing or unpriced.)
        const isDonation = originatingModule === 'donation';
        const claimed: number | null = typeof amount === 'number' ? amount : typeof total === 'number' ? total : null;
        let verifiedTotalPkr: number | null = claimed;
        // The priced lines, normalized once for both paths: the items
        // array when present, else the lone productId at quantity 1.
        const pricedItems: Array<{ productId: string; quantity: number }> =
            Array.isArray(items) && items.length > 0
                ? items.map((i: any) => ({
                    productId: typeof i?.productId === 'string' ? i.productId : '',
                    quantity: typeof i?.quantity === 'number' ? i.quantity : 1,
                }))
                : productId
                    ? [{ productId, quantity: 1 }]
                    : [];
        // WRITE PRIMACY (S-W2, isSupaPrimary('store-orders-api')): the
        // tx_store_order_create function re-reads EVERY item's price
        // inside its transaction snapshot with the same fail-closed
        // rule, so the Firestore verification below is skipped on the
        // primary path; the claimed/verified messaging and the 422
        // shape are unchanged.
        const ordersPrimary = storeOrdersPrimaryEnabled();
        // GE vendor classification and branch checks. These run on
        // BOTH legs (the primacy leg skips the Firestore pricing block
        // below), reading product facts from Firestore or, under
        // primacy, from the Supabase enrichment seam.
        let vendorCtx: {
            productId: string;
            vendorId: string;
            subtotalPkr: number;
            deliveryPkr: number;
            totalPkr: number;
            promisedDeliveryDate: string | null;
            groupBuyId: string | null;
        } | null = null;
        if (!isDonation) {
            try {
                const readFacts = async (pid: string): Promise<VendorProductFacts & { price?: unknown }> => {
                    if (ordersPrimary) {
                        const enriched = await getStoreProductForOrderEnrichment(pid);
                        if (enriched) return enriched;
                    }
                    const pSnap = await db.collection('products').doc(pid).get();
                    const data = pSnap.data();
                    return {
                        exists: pSnap.exists,
                        price: data?.price,
                        vendorId: data?.vendorId,
                        deliveryChargePkr: data?.deliveryChargePkr,
                        deliveryPromiseDays: data?.deliveryPromiseDays,
                        stock: data?.stock,
                        currency: data?.currency,
                    };
                };
                const lines: ReferencedLine[] = pricedItems
                    .filter((l) => l.productId)
                    .map((l) => ({ productId: l.productId, quantity: l.quantity }));
                const factsById = new Map<string, VendorProductFacts>();
                const priceById = new Map<string, unknown>();
                for (const pid of [...new Set(lines.map((l) => l.productId))]) {
                    const facts = await readFacts(pid);
                    factsById.set(pid, facts);
                    priceById.set(pid, facts.price);
                }
                const classification = classifyVendorOrder(lines, factsById);
                if (classification.kind === 'vendor') {
                    const facts = classification.facts;
                    requireVendorCurrencyPkr(facts);
                    requireVendorStock(facts);
                    // Creation-time sellability re-check (audit fix),
                    // mirroring readFacts' dual read path.
                    const readVendorFacts = async (vendorId: string) => {
                        if (ordersPrimary) {
                            const enriched = await getVendorForOrderEnrichment(vendorId);
                            if (enriched) return enriched;
                        }
                        const vSnap = await db.collection('vendors').doc(vendorId).get();
                        const vData = vSnap.data();
                        return {
                            exists: vSnap.exists,
                            status: vData?.status,
                            agreementStatus: vData?.agreementStatus,
                        };
                    };
                    requireVendorSellable(await readVendorFacts(facts.vendorId as string));
                    const deliveryPkr = requireDeliveryPkr(facts);
                    const shopKey = resolveShopMethodKey(await getPaymentMethodsSettings());
                    if (!shopKey) throw new VendorOrderError(SHOP_METHOD_MISSING_ADMIN_MESSAGE);
                    if (paymentMethod !== shopKey) {
                        throw new VendorOrderError('This order must use the shop payment method shown at checkout.');
                    }
                    const sanctionedGroupBuyId =
                        typeof groupBuyId === 'string' && groupBuyId !== '' ? groupBuyId : null;
                    let subtotalPkr: number;
                    if (sanctionedGroupBuyId) {
                        // R-10: locked team price, never the current price.
                        let seat: { unitPricePkr: number };
                        try {
                            seat = await assertGroupBuySeatAvailable(db, {
                                groupBuyId: sanctionedGroupBuyId,
                                userId: uid,
                                productId: classification.productId,
                            });
                        } catch (e) {
                            throw asVendorOrderError(e);
                        }
                        subtotalPkr = seat.unitPricePkr;
                    } else if (ordersPrimary) {
                        const price = coerceServerPrice(priceById.get(classification.productId));
                        if (price === null) {
                            throw new PriceVerificationError(
                                `Product ${classification.productId} is missing or has no server-side price. Order rejected.`,
                            );
                        }
                        subtotalPkr = price;
                    } else {
                        subtotalPkr = await priceOrderServerSide({
                            productId: productId || null,
                            items: Array.isArray(items) && items.length > 0 ? items : null,
                            claimedTotal: null,
                            lookup: async (pid: string): Promise<ServerProductRecord> => {
                                const pSnap = await db.collection('products').doc(pid).get();
                                const data = pSnap.data();
                                return {
                                    exists: pSnap.exists,
                                    price: data?.price,
                                    isActive: data?.isActive,
                                    category: data?.category,
                                    eventId: data?.eventId,
                                };
                            },
                        });
                    }
                    const totalPkr = subtotalPkr + deliveryPkr;
                    if (claimed !== null && claimed !== totalPkr) {
                        throw new PriceVerificationError('Security Error: Price tampering detected.');
                    }
                    vendorCtx = {
                        productId: classification.productId,
                        vendorId: facts.vendorId as string,
                        subtotalPkr,
                        deliveryPkr,
                        totalPkr,
                        promisedDeliveryDate: promisedDeliveryDateString(Date.now(), facts.deliveryPromiseDays),
                        groupBuyId: sanctionedGroupBuyId,
                    };
                    verifiedTotalPkr = totalPkr;
                }
            } catch (e) {
                if (e instanceof VendorOrderError) {
                    return NextResponse.json({ error: e.message }, { status: 422 });
                }
                if (e instanceof PriceVerificationError) {
                    return NextResponse.json(
                        { error: `Price verification failed: ${e.message}` },
                        { status: 422 },
                    );
                }
                throw e;
            }
        }
        if (!isDonation && !ordersPrimary && !vendorCtx) {
            const lookupProduct = async (pid: string): Promise<ServerProductRecord> => {
                const pSnap = await db.collection('products').doc(pid).get();
                const data = pSnap.data();
                return {
                    exists: pSnap.exists,
                    price: data?.price,
                    isActive: data?.isActive,
                    category: data?.category,
                    eventId: data?.eventId,
                };
            };
            // Event-ticket fallback, identical to the checkout action:
            // a ticket product that does not exist yet is priced from
            // the server-side event record (linked product, else
            // paymentDetails.amount), never from the claim.
            const readEventTicketPrice = async (): Promise<number | null> => {
                if (!eventId) return null;
                const evSnap = await db.collection('events').doc(eventId).get();
                if (!evSnap.exists) return null;
                const evData = evSnap.data() || {};
                const linkedPid = evData.productId || evData.linkedStoreProductId;
                if (typeof linkedPid === 'string' && linkedPid) {
                    const linked = await lookupProduct(linkedPid);
                    if (linked.exists && linked.isActive !== false) {
                        const linkedPrice = coerceServerPrice(linked.price);
                        if (linkedPrice !== null) return linkedPrice;
                    }
                }
                return coerceServerPrice(evData.paymentDetails?.amount)
                    ?? coerceServerPrice(evData.amountInput);
            };
            try {
                verifiedTotalPkr = await priceOrderServerSide({
                    productId: productId || null,
                    items: Array.isArray(items) && items.length > 0 ? items : null,
                    claimedTotal: claimed,
                    lookup: lookupProduct,
                    resolveEventTicketPrice: eventId
                        ? async (pid, product) => {
                            if (product.exists && product.eventId && product.eventId !== eventId) return null;
                            const isTicketReference =
                                pid === productId
                                || (!productId && Array.isArray(items) && items.length === 1 && items[0]?.productId === pid);
                            return isTicketReference ? readEventTicketPrice() : null;
                        }
                        : undefined,
                    resolveUnreferencedPrice: eventId ? readEventTicketPrice : undefined,
                });
            } catch (e) {
                if (e instanceof PriceVerificationError) {
                    return NextResponse.json(
                        { error: `Price verification failed: ${e.message}` },
                        { status: 422 },
                    );
                }
                throw e;
            }
        }
        const isUsdCertificate = (currency || 'PKR') === 'USD';

        // Canonical order shape (CH-13, spec 3.5) + compat dual-write.
        const orderData: Record<string, any> = {
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
        // GE: the vendor branch stamps the spec field set and the
        // top-level productId (house literal keeps lacking it, exactly
        // as today). creditAppliedPkr starts at 0: the Firestore leg's
        // hook merges the real value; the primacy leg overwrites it
        // from its credit claim before the tx call.
        if (vendorCtx) {
            Object.assign(orderData, buildVendorOrderFields({
                vendorId: vendorCtx.vendorId,
                subtotalPkr: vendorCtx.subtotalPkr,
                deliveryPkr: vendorCtx.deliveryPkr,
                promisedDeliveryDate: vendorCtx.promisedDeliveryDate,
                groupBuyId: vendorCtx.groupBuyId,
                creditAppliedPkr: 0,
            }));
            orderData.productId = vendorCtx.productId;
        }

        if (ordersPrimary) {
            // ONE tx as the only writer (no Firestore write, no
            // fallback on a write error). Idempotency: the client's
            // per-attempt key arrives as the Idempotency-Key header
            // (design §3.5); a replay returns created:false and the
            // notifications below are skipped for it — a replay is a
            // success, not an error, with the same response shape.
            // GE primacy arm (Tier 2 saga): credits are claimed and
            // the group seat registered against a pre-minted order id
            // BEFORE the tx; both are compensated when the tx rejects,
            // throws, or loses the idempotency race.
            const preMintedOrderId = makeStoreDocId();
            const headerKey = request.headers.get('idempotency-key');
            const creditClaimKey = headerKey || `srv-${preMintedOrderId}`;
            let creditClaim: { creditAppliedPkr: number; consumedIds: string[]; alreadyClaimed: boolean } | null = null;
            let seatRegistered = false;
            const compensatePrimacy = async () => {
                if (seatRegistered && vendorCtx?.groupBuyId) {
                    await releaseGroupBuySeat(db, {
                        groupBuyId: vendorCtx.groupBuyId,
                        orderId: preMintedOrderId,
                        userId: uid,
                        reason: 'order_creation_failed',
                    }).catch((err) => console.error('[orders API] seat release after primacy failure failed:', err));
                }
                if (creditClaim && !creditClaim.alreadyClaimed) {
                    await restoreStoreCreditConsumption(db, {
                        buyerUid: uid,
                        idempotencyKey: creditClaimKey,
                        consumedIds: creditClaim.consumedIds,
                    }).catch((err) => console.error('[orders API] credit restore after primacy failure failed:', err));
                }
            };
            if (vendorCtx) {
                try {
                    creditClaim = await planStoreCreditConsumption(db, {
                        buyerUid: uid,
                        idempotencyKey: creditClaimKey,
                        orderId: preMintedOrderId,
                        capPkr: vendorCtx.totalPkr,
                        nowMs: Date.now(),
                        claimTimestamp: admin.firestore.Timestamp.now(),
                    });
                    orderData.creditAppliedPkr = creditClaim.creditAppliedPkr;
                    if (vendorCtx.groupBuyId) {
                        try {
                            await registerGroupBuySeat(db, {
                                groupBuyId: vendorCtx.groupBuyId,
                                orderId: preMintedOrderId,
                                userId: uid,
                                productId: vendorCtx.productId,
                            });
                            seatRegistered = true;
                        } catch (e) {
                            const code = (e as { code?: unknown })?.code;
                            if (!(code === 'ALREADY_SEATED' && headerKey)) {
                                await compensatePrimacy();
                                throw asVendorOrderError(e);
                            }
                            // Replay of a seated order: the tx dedupe
                            // below returns the winning order (GH 4.4.6).
                        }
                    }
                } catch (e) {
                    if (e instanceof VendorOrderError) {
                        return NextResponse.json({ error: e.message }, { status: 422 });
                    }
                    throw e;
                }
            }
            let primaryResult: Awaited<ReturnType<typeof createStoreOrderViaPrimary>>;
            try {
                primaryResult = await createStoreOrderViaPrimary({
                    orderData: orderData as unknown as Record<string, unknown>,
                    idempotencyKey: headerKey,
                    productId: productId || items?.[0]?.productId || null,
                    claimed,
                    quantity: items?.[0]?.quantity ?? 1,
                    // Audit item 4: the tx prices EVERY item fail-closed
                    // from fs_products, not just the first.
                    items: pricedItems.length > 0 ? pricedItems : null,
                    isDonation,
                    isUsdCertificate,
                    orderId: vendorCtx ? preMintedOrderId : undefined,
                    deliveryPkr: vendorCtx ? vendorCtx.deliveryPkr : 0,
                });
            } catch (e) {
                await compensatePrimacy();
                throw e;
            }
            if (!primaryResult.ok) {
                await compensatePrimacy();
                return NextResponse.json(
                    { error: primaryResult.message || 'Order creation failed' },
                    { status: primaryResult.httpStatus || 500 },
                );
            }
            if (vendorCtx && primaryResult.created === false && (primaryResult.orderId as string) !== preMintedOrderId) {
                await compensatePrimacy();
            }
            const primaryOrderId = primaryResult.orderId as string;
            if (primaryResult.created === false) {
                return NextResponse.json({
                    ok: true,
                    orderId: primaryOrderId,
                    message: 'Order created successfully'
                });
            }
            // created: fall through to the shared notification block
            // with orderId bound to the tx-minted id.
            var orderId: string = primaryOrderId;
        } else {
            // SEC-RACE (audit item 11, idempotency handling only): the
            // Supa-primary leg above dedupes on the Idempotency-Key
            // header inside its tx; the Firestore leg now honors the
            // same header with a transactional (buyer, key) claim, so
            // a retried submission returns the original orderId
            // instead of minting a duplicate order. A replay skips the
            // notification block below, exactly like the primary leg.
            // GE: vendor orders always take the transactional path
            // (generated key when the header is absent) so credits and
            // the group seat commit atomically with the order.
            let claim: Awaited<ReturnType<typeof createOrderWithIdempotencyClaim>>;
            try {
                claim = await createOrderWithIdempotencyClaim(db, {
                    buyerUid: uid,
                    idempotencyKey: request.headers.get('idempotency-key') ?? (vendorCtx ? `srv-${makeStoreDocId()}` : null),
                    orderData,
                    claimTimestamp: admin.firestore.Timestamp.now(),
                    beforeOrderWrite: vendorCtx
                        ? async (t: any, orderRef: any) => {
                            const plan = await planStoreCreditsInTransaction(t, db, {
                                buyerUid: uid,
                                capPkr: vendorCtx.totalPkr,
                                nowMs: Date.now(),
                            });
                            if (vendorCtx.groupBuyId) {
                                try {
                                    await registerGroupBuySeatTx(t, db.collection('group_buys').doc(vendorCtx.groupBuyId), {
                                        orderId: orderRef.id,
                                        userId: uid,
                                        productId: vendorCtx.productId,
                                        now: new Date(),
                                    });
                                } catch (e) {
                                    throw asVendorOrderError(e);
                                }
                            }
                            applyCreditConsumptionInTransaction(t, plan, orderRef.id);
                            return { creditAppliedPkr: plan.creditAppliedPkr };
                        }
                        : undefined,
                });
            } catch (e) {
                if (e instanceof VendorOrderError) {
                    return NextResponse.json({ error: e.message }, { status: 422 });
                }
                throw e;
            }
            if (!claim.created) {
                return NextResponse.json({
                    ok: true,
                    orderId: claim.orderId,
                    message: 'Order created successfully'
                });
            }
            var orderId: string = claim.orderId;
        }

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

        // GF guard (PLAN-gf 6.4): a vendor delivery and a cancellation
        // of an order holding store credit or a group seat carry money
        // effects that live only in the GF helpers, so this bare-status
        // path refuses them before either write arm. One bounded
        // single-document read, only for these two status values.
        if (updates.status === 'delivered' || updates.status === 'cancelled') {
            const guardSnap = await db.collection('orders').doc(orderId).get();
            if (guardSnap.exists) {
                const guard = vendorPatchGuard(
                    guardSnap.data() as Record<string, unknown>,
                    updates as Record<string, unknown>,
                );
                if (guard.blocked) {
                    return NextResponse.json({ error: guard.error }, { status: guard.status });
                }
            }
        }

        // Allowed non-money status transitions (fulfilment movement only)
        const allowedStatuses = ['pending_verification', 'processing', 'shipped', 'delivered', 'cancelled'];
        if (updates.status && !allowedStatuses.includes(updates.status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }
        const NON_MONEY_FIELDS = ['status', 'fulfilmentNote', 'courierName', 'trackingNumber'];
        const sanitized: Record<string, unknown> = {};
        for (const f of NON_MONEY_FIELDS) {
            if (updates[f] !== undefined) sanitized[f] = updates[f];
        }

        // WRITE PRIMACY (S-W2, isSupaPrimary('store-orders-api')): the
        // 409 money guard above has already run verbatim; the tx takes
        // only the sanitized scalar fields + the audit fields this
        // route derives, locks the row, and writes update + audit
        // atomically. The buyer notification below then runs off the
        // committed row the tx returns, as it runs off the pre-read
        // snapshot on the Firestore path.
        if (storeOrdersPrimaryEnabled()) {
            const primaryResult = await patchStoreOrderViaPrimary({
                orderId,
                sanitized,
                audit: {
                    action: deriveOrderAuditAction(updates),
                    actorUid: decoded.uid,
                    actorRole: '',
                    changedFields: Object.keys(updates),
                    source: 'store_orders_api',
                },
            });
            if (!primaryResult.ok) {
                return NextResponse.json(
                    { error: primaryResult.message || 'Order not found' },
                    { status: primaryResult.httpStatus || 500 },
                );
            }
            const primaryOrderData = (primaryResult.order_data || {}) as Record<string, any>;
            // GF-owned delivered hook (MERGE_PLAN 3.11): after the update
            // commit, before the buyer notification block. GG widens the
            // sanitizer around this later and must not move it. The guard
            // above refuses vendor deliveries on this path, so this is a
            // safety net if one ever lands here.
            if (updates.status === 'delivered' && primaryOrderData?.vendorId) {
                try {
                    await deliverVendorOrder(db, { orderId, actorUid: decoded.uid });
                } catch (hookErr) {
                    console.error('[orders API] GF delivered hook failed:', hookErr);
                }
            }
            if (updates.status && primaryOrderData?.buyerUserId) {
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
                    let link = `/verify/${primaryOrderData.certificateCode}`;
                    if (updates.status === 'verified' && primaryOrderData?.items?.some((i: any) => i.type === 'event_ticket')) {
                        const ticketItem = primaryOrderData.items.find((i: any) => i.type === 'event_ticket');
                        title = `🎟️ Ticket Confirmed!`;
                        message = `Your registration for "${ticketItem.title || 'the event'}" is confirmed. You can now access your ticket.`;
                        link = `/events/${ticketItem.eventId || primaryOrderData.eventId}`;
                    }
                    if (message) {
                        notificationService.send(primaryOrderData.buyerUserId, {
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
        }

        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        const orderData = orderSnap.data();
        const updatesToApply: Record<string, unknown> = {
            ...sanitized,
            updatedAt: admin.firestore.Timestamp.now(),
        };

        // Relay stamp (vendor shop transition 4): when this write moves a
        // verified order to processing, the admin has relayed it to the
        // vendor. relayedAt is stamped server-side only, first writer
        // wins against the vendor-open path in /api/vendor/orders/[id].
        if (
            sanitized.status === 'processing' &&
            (orderData as any)?.status === 'verified' &&
            (orderData as any)?.vendorId &&
            !(orderData as any)?.relayedAt
        ) {
            updatesToApply.relayedAt = admin.firestore.Timestamp.now();
            updatesToApply.relayedBy = decoded.uid;
        }

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

        // GF-owned delivered hook (MERGE_PLAN 3.11): after the update
        // commit, before the buyer notification block. GG widens the
        // sanitizer around this later and must not move it. The guard
        // above refuses vendor deliveries on this path, so this is a
        // safety net if one ever lands here.
        if (sanitized.status === 'delivered' && (orderData as any)?.vendorId) {
            try {
                await deliverVendorOrder(db, { orderId, actorUid: decoded.uid });
            } catch (hookErr) {
                console.error('[orders API] GF delivered hook failed:', hookErr);
            }
        }

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
