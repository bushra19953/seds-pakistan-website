'use server';

import { getDb } from '@/lib/server/firebase-admin';
import { Product, Order } from '@/types/store';
import { FieldValue } from 'firebase-admin/firestore';
import {
    getProductFromSupa,
    listPublicProductsFromSupa,
    storeActionsPrimaryEnabled,
    getStoreProductForVerification,
    getStoreOrderFromSupa,
    updateOrderNotFoundViaPrimary,
    createOrderViaStorePrimary,
    syncEventProductViaPrimary,
} from '@/lib/supa/store-actions';
import { getPaymentMethodsSettings } from '@/app/actions/payment-methods';
import { listAvailableCreditsForUser } from '@/lib/server/vendor-shop';
import {
    VendorOrderError,
    SHOP_METHOD_MISSING_ADMIN_MESSAGE,
    applyCreditConsumptionInTransaction,
    asVendorOrderError,
    buildVendorOrderFields,
    classifyVendorOrder,
    creditsForSelection,
    planStoreCreditConsumption,
    planStoreCreditsInTransaction,
    promisedDeliveryDateString,
    requireDeliveryPkr,
    requireVendorCurrencyPkr,
    requireVendorSellable,
    requireVendorStock,
    resolveShopMethodKey,
    restoreStoreCreditConsumption,
    selectStoreCredits,
    stripVendorSpecFields,
    timestampToMs,
    type ReferencedLine,
    type VendorProductFacts,
} from '@/lib/server/store-vendor-order';
import {
    assertGroupBuySeatAvailable,
    registerGroupBuySeat,
    registerGroupBuySeatTx,
    releaseGroupBuySeat,
} from '@/lib/server/group-buys';
import { makeStoreDocId, toSupaStorePayload } from '@/lib/supa/store-primary';
import { mirrorChapterApplicationUpdate, updateChapterApplicationPrimaryFirst } from '@/lib/applications-supa';
import {
    PriceVerificationError,
    coerceServerPrice,
    priceOrderServerSide,
    type ServerProductRecord,
} from '@/lib/server/store-pricing';
import { createOrderWithIdempotencyClaim } from '@/lib/server/order-idempotency';

export async function getProduct(productId: string): Promise<{ success: boolean; data?: Product; error?: string }> {
    try {
        // Supabase read path (flag 'store-actions'): a non-null seam result
        // is authoritative (found or not-found); null falls through to the
        // Firestore read below byte-identically.
        const supaProduct = await getProductFromSupa(productId);
        if (supaProduct) {
            return supaProduct.found
                ? { success: true, data: supaProduct.data as unknown as Product }
                : { success: false, error: 'Product not found' };
        }
        const db = await getDb();
        if (!db) {
            throw new Error('Database connection failed');
        }
        const docRef = db.collection('products').doc(productId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return { success: false, error: 'Product not found' };
        }

        const data = docSnap.data();

        // Helper to serialize timestamps
        const serializeToken = (data: any): any => {
            if (!data) return data;
            const result = { ...data, id: docSnap.id };
            if (result.createdAt && typeof result.createdAt.toDate === 'function') {
                result.createdAt = result.createdAt.toDate().toISOString();
            }
            if (result.updatedAt && typeof result.updatedAt.toDate === 'function') {
                result.updatedAt = result.updatedAt.toDate().toISOString();
            }
            return result;
        }

        return { success: true, data: serializeToken(data) as Product };
    } catch (error: any) {
        console.error('Error fetching product:', error);
        return { success: false, error: error.message };
    }
}

export async function createOrder(orderData: any): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
        const db = await getDb();
        if (!db) {
            throw new Error('Database connection failed');
        }

        if (!orderData.userId) {
            throw new Error('Unauthorized: User ID required');
        }

        // GE mass-assignment closure (OWASP): the 15 spec fields are
        // stripped from client input before anything spreads it into a
        // stored order. groupBuyId is the one sanctioned client input:
        // kept aside here and validated server-side on the vendor branch.
        const { clean: strippedOrderData, groupBuyId: sanctionedGroupBuyId } =
            stripVendorSpecFields(orderData);
        orderData = strippedOrderData;

        // 🛑 ENFORCEMENT CHECK: Block blacklisted users
        const [userSnap, configSnap] = await Promise.all([
            db.collection('users').doc(orderData.userId).get(),
            db.collection('warningConfig').doc('global').get()
        ]);

        const userData = userSnap.data() || {};
        const configData = configSnap.data() || { enforcementEnabled: true };

        if (configData.enforcementEnabled && userData.isBlacklisted === true) {
            throw new Error('Transaction Blocked: Your account is currently blacklisted. Event registration and store purchases are restricted.');
        }

        // Item 9: donations flag enforcement (authoritative server gate).
        // Strict !== true means a missing doc, missing field, or any
        // non-boolean value fails closed. Runs after the blacklist check
        // and before any order write. (Kept at integration: finance's
        // CH-13 block below skips price verification for donations, so
        // this gate is the only donation control on this path.)
        if (orderData.originatingModule === 'donation') {
            const settingsSnap = await db.collection('settings').doc('siteWide').get();
            const enableDonations = settingsSnap.exists ? settingsSnap.data()?.enableDonations : undefined;
            if (enableDonations !== true) {
                throw new Error('Donations are currently disabled.');
            }
        }

        // ── Server-side price verification (CH-13, spec 2.2; audit
        // item 4: FAIL CLOSED) ─────────────────────────────────────────
        // Runs for EVERY non-donation module through the one shared
        // pricing helper (src/lib/server/store-pricing.ts): every item
        // is priced from the server-side product record, and a product
        // that is missing, inactive, or unpriced REJECTS the order —
        // the previous fail-open "trust the claim" arms are gone, and
        // a checkout never creates a product (the stub block below the
        // Firestore write was removed with this fix).
        //
        // Event-ticket exception (documented in the helper): the
        // legitimate paid-event checkout synthesises its product
        // client-side from the event page when no store product exists
        // yet for the event, so a missing/unpriced ticket product is
        // priced from the SERVER-SIDE event record instead — the
        // event's linked store product (EV-P07 link fields) when that
        // product exists and is priced, else the event's
        // paymentDetails.amount (falling back to amountInput, the same
        // chain the checkout page displays). An INACTIVE product never
        // falls back: it rejects.
        const isDonation = orderData.originatingModule === 'donation';
        const claimedTotal: number | null =
            typeof orderData.total === 'number' ? orderData.total
            : typeof orderData.amount === 'number' ? orderData.amount
            : null;
        let verifiedTotalPkr: number | null = claimedTotal;
        // WRITE PRIMACY (S-W3): with isSupaPrimary('store-actions') on,
        // product prices are read from fs_products (flip order puts
        // products primacy first, so Firestore prices would be stale);
        // the blacklist / donation gates above stay Firestore reads
        // exactly as today (foreign slices' read-through, design §3.3).
        // With primacy OFF every read below is the Firestore read it
        // replaces, byte-identically.
        const actionsPrimary = storeActionsPrimaryEnabled();
        const readServerProduct = async (pid: string): Promise<ServerProductRecord> => {
            if (actionsPrimary) {
                const v = await getStoreProductForVerification(pid);
                if (!v) throw new Error('Store price source unavailable');
                return {
                    exists: !!v.found,
                    price: v.price,
                    isActive: v.isActive,
                    category: v.category,
                    eventId: v.eventId,
                    vendorId: v.vendorId,
                    deliveryChargePkr: v.deliveryChargePkr,
                    deliveryPromiseDays: v.deliveryPromiseDays,
                    stock: v.stock,
                    currency: v.currency,
                };
            }
            const snap = await db.collection('products').doc(pid).get();
            const data = snap.data();
            return {
                exists: snap.exists,
                price: data?.price,
                isActive: data?.isActive,
                category: data?.category,
                eventId: data?.eventId,
                vendorId: data?.vendorId,
                deliveryChargePkr: data?.deliveryChargePkr,
                deliveryPromiseDays: data?.deliveryPromiseDays,
                stock: data?.stock,
                currency: data?.currency,
            };
        };
        // The event record is the server-side source of truth for a
        // ticket's price when the ticket product does not exist yet.
        // Read from Firestore (the read the removed stub block used);
        // under events primacy the committed event is mirrored back to
        // Firestore by the events seam, so this read stays current.
        const readEventTicketPrice = async (): Promise<number | null> => {
            if (!orderData.eventId) return null;
            const evSnap = await db.collection('events').doc(orderData.eventId).get();
            if (!evSnap.exists) return null;
            const evData = evSnap.data() || {};
            const linkedPid = evData.productId || evData.linkedStoreProductId;
            if (typeof linkedPid === 'string' && linkedPid) {
                const linked = await readServerProduct(linkedPid);
                if (linked.exists && linked.isActive !== false) {
                    const linkedPrice = coerceServerPrice(linked.price);
                    if (linkedPrice !== null) return linkedPrice;
                }
            }
            return coerceServerPrice(evData.paymentDetails?.amount)
                ?? coerceServerPrice(evData.amountInput);
        };
        const resolveEventTicketPrice = async (
            _productId: string,
            product: ServerProductRecord,
        ): Promise<number | null> => {
            if (!orderData.eventId) return null;
            // The fallback prices THIS order's event ticket only: the
            // referenced product must not be a real product belonging
            // to a different event, and the reference must be the
            // order's ticket reference (its productId, or its single
            // item when no productId was sent) — never an arbitrary
            // extra item in a multi-item order.
            if (product.exists && product.eventId && product.eventId !== orderData.eventId) {
                return null;
            }
            const isTicketReference =
                _productId === orderData.productId
                || (!orderData.productId
                    && Array.isArray(orderData.items)
                    && orderData.items.length === 1
                    && orderData.items[0]?.productId === _productId);
            if (!isTicketReference) return null;
            return readEventTicketPrice();
        };
        // GE vendor classification: each referenced product is read
        // once through the same closure pricing uses. A house order
        // runs the pricing call below exactly as before; a vendor
        // order takes the vendor branch (stock, shop payment method,
        // group seat price, delivery) and never the event-ticket
        // resolver.
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
            const lines: ReferencedLine[] = [];
            if (Array.isArray(orderData.items)) {
                for (const item of orderData.items) {
                    if (item && typeof item.productId === 'string' && item.productId) {
                        lines.push({
                            productId: item.productId,
                            quantity: typeof item.quantity === 'number' ? item.quantity : 1,
                        });
                    }
                }
            }
            if (orderData.productId && !lines.some((l) => l.productId === orderData.productId)) {
                lines.push({ productId: orderData.productId, quantity: 1 });
            }
            const factsById = new Map<string, VendorProductFacts>();
            for (const pid of [...new Set(lines.map((l) => l.productId))]) {
                const rec = await readServerProduct(pid);
                factsById.set(pid, {
                    exists: rec.exists,
                    vendorId: rec.vendorId,
                    deliveryChargePkr: rec.deliveryChargePkr,
                    deliveryPromiseDays: rec.deliveryPromiseDays,
                    stock: rec.stock,
                    currency: rec.currency,
                });
            }
            const classification = classifyVendorOrder(lines, factsById);
            if (classification.kind === 'vendor') {
                const facts = classification.facts;
                requireVendorCurrencyPkr(facts);
                requireVendorStock(facts);
                // Creation-time sellability re-check (audit fix): the
                // vendor record itself, not only the product, must be
                // active with a signed agreement right now.
                const vendorSnap = await db.collection('vendors').doc(facts.vendorId as string).get();
                requireVendorSellable({
                    exists: vendorSnap.exists,
                    status: vendorSnap.data()?.status,
                    agreementStatus: vendorSnap.data()?.agreementStatus,
                });
                const deliveryPkr = requireDeliveryPkr(facts);
                const shopKey = resolveShopMethodKey(await getPaymentMethodsSettings());
                if (!shopKey) throw new VendorOrderError(SHOP_METHOD_MISSING_ADMIN_MESSAGE);
                if (orderData.paymentMethod !== shopKey) {
                    throw new VendorOrderError('This order must use the shop payment method shown at checkout.');
                }
                let subtotalPkr: number;
                if (sanctionedGroupBuyId) {
                    // R-10: group orders price at the team's LOCKED
                    // unit price, never the product's current price.
                    let seat: { unitPricePkr: number };
                    try {
                        seat = await assertGroupBuySeatAvailable(db, {
                            groupBuyId: sanctionedGroupBuyId,
                            userId: orderData.userId,
                            productId: classification.productId,
                        });
                    } catch (e) {
                        throw asVendorOrderError(e);
                    }
                    subtotalPkr = seat.unitPricePkr;
                } else {
                    subtotalPkr = await priceOrderServerSide({
                        productId: orderData.productId || null,
                        items: Array.isArray(orderData.items) ? orderData.items : null,
                        claimedTotal: null,
                        lookup: readServerProduct,
                    });
                }
                const totalPkr = subtotalPkr + deliveryPkr;
                if (claimedTotal !== null && claimedTotal !== totalPkr) {
                    console.error(
                        `Security Alert: Order total mismatch. Client sent ${claimedTotal}, server sum ${totalPkr}`,
                    );
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
            } else {
                verifiedTotalPkr = await priceOrderServerSide({
                    productId: orderData.productId || null,
                    items: Array.isArray(orderData.items) ? orderData.items : null,
                    claimedTotal,
                    lookup: readServerProduct,
                    resolveEventTicketPrice: orderData.eventId ? resolveEventTicketPrice : undefined,
                    resolveUnreferencedPrice: orderData.eventId ? readEventTicketPrice : undefined,
                });
            }
        }

        // ── Canonical order shape (CH-13, spec 3.5) ──────────────────────
        // New writes carry canonical fields only, plus the compat dual-write
        // of `total`. Donations record declaredAmountPkr (totalPkr stays
        // null until verification). The legacy USD certificate product is
        // the one documented exception: it keeps total + currency and gets
        // no totalPkr, and is excluded from PKR reports.
        const isUsdCertificate = orderData.currency === 'USD';
        let finalOrder: Record<string, any> = {
            ...orderData,
            buyerUserId: orderData.userId,
            totalPkr: isDonation || isUsdCertificate ? null : verifiedTotalPkr,
            total: isUsdCertificate ? claimedTotal : (isDonation ? claimedTotal : verifiedTotalPkr),
            declaredAmountPkr: isDonation ? claimedTotal : null,
            receiptDriveId: orderData.receiptDriveId ?? null,
            isDeleted: false,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            status: 'pending_verification',
            paymentStatus: 'pending',
            securityAudit: {
                clientIp: 'logged',
                verifiedAt: FieldValue.serverTimestamp(),
                priceVerified: !isDonation
            }
        };
        // GE: vendor fields are applied AFTER the client-derived
        // spread, so no client value can survive in a spec field.
        // creditAppliedPkr is a placeholder here: the Firestore leg's
        // transaction hook merges the real value in, and the primacy
        // leg overwrites it from its credit claim before the tx call.
        // House orders get no new keys at all.
        if (vendorCtx) {
            Object.assign(finalOrder, buildVendorOrderFields({
                vendorId: vendorCtx.vendorId,
                subtotalPkr: vendorCtx.subtotalPkr,
                deliveryPkr: vendorCtx.deliveryPkr,
                promisedDeliveryDate: vendorCtx.promisedDeliveryDate,
                groupBuyId: vendorCtx.groupBuyId,
                creditAppliedPkr: 0,
            }));
        }

        // WRITE PRIMACY (S-W3, isSupaPrimary('store-actions')): ONE
        // tx_store_create_order call commits A1 (order) + A2 (event
        // registration mirror) + A5 (audit)
        // atomically — a failure inside the tx persists NOTHING, where
        // the Firestore chain below can orphan the order. A tx error
        // propagates to this action's catch ({ success: false }) with
        // no Firestore fallback. The chapter-application link (A4)
        // stays post-tx best-effort, by design (§3.3).
        if (actionsPrimary) {
            const primaryOrderId = makeStoreDocId();
            // GE primacy arm (Tier 2 saga, PLAN-ge 6.4 + GH 4.4):
            // credits are claimed and the group seat is registered
            // against the pre-minted order id BEFORE the tx, and both
            // are compensated if the tx fails or loses the race.
            let creditClaim: { creditAppliedPkr: number; consumedIds: string[]; alreadyClaimed: boolean } | null = null;
            let seatRegistered = false;
            let seatPreExisting = false;
            const creditClaimKey = typeof orderData.idempotencyKey === 'string' && orderData.idempotencyKey
                ? orderData.idempotencyKey
                : `srv-${primaryOrderId}`;
            if (vendorCtx) {
                creditClaim = await planStoreCreditConsumption(db, {
                    buyerUid: orderData.userId,
                    idempotencyKey: creditClaimKey,
                    orderId: primaryOrderId,
                    capPkr: vendorCtx.totalPkr,
                    nowMs: Date.now(),
                    claimTimestamp: FieldValue.serverTimestamp(),
                });
                finalOrder = { ...finalOrder, creditAppliedPkr: creditClaim.creditAppliedPkr };
                if (vendorCtx.groupBuyId) {
                    try {
                        await registerGroupBuySeat(db, {
                            groupBuyId: vendorCtx.groupBuyId,
                            orderId: primaryOrderId,
                            userId: orderData.userId,
                            productId: vendorCtx.productId,
                        });
                        seatRegistered = true;
                    } catch (e) {
                        const code = (e as { code?: unknown })?.code;
                        if (code === 'ALREADY_SEATED' && typeof orderData.idempotencyKey === 'string' && orderData.idempotencyKey) {
                            // Replay of a seated order: the tx dedupe
                            // below returns the winning order (GH 4.4.6).
                            seatPreExisting = true;
                        } else {
                            if (creditClaim && !creditClaim.alreadyClaimed) {
                                await restoreStoreCreditConsumption(db, {
                                    buyerUid: orderData.userId,
                                    idempotencyKey: creditClaimKey,
                                    consumedIds: creditClaim.consumedIds,
                                }).catch((err) => console.error('[createOrder] credit restore after seat failure failed:', err));
                            }
                            throw asVendorOrderError(e);
                        }
                    }
                }
            }
            const nowIso = new Date().toISOString();
            const supaOrderData = toSupaStorePayload(finalOrder, nowIso) as Record<string, unknown>;
            const supaRegistration = orderData.eventId ? {
                uid: orderData.userId,
                orderId: primaryOrderId,
                eventId: orderData.eventId,
                displayName: orderData.buyer?.fullName || '',
                email: orderData.buyer?.email || '',
                whatsappE164: orderData.buyer?.phone || orderData.buyer?.whatsappNumber || '',
                status: 'pending',
                paymentStatus: 'pending',
                paymentMethod: orderData.paymentMethod || 'bank_transfer',
                paymentRef: orderData.proofOfPaymentUrl || '',
                notes: orderData.notes || '',
                formResponses: orderData.formResponses || {},
                createdAt: nowIso,
                updatedAt: nowIso,
            } : null;
            const primaryResult = await createOrderViaStorePrimary({
                orderId: primaryOrderId,
                orderData: supaOrderData,
                eventId: orderData.eventId || null,
                registration: supaRegistration,
                productId: orderData.productId || null,
                auditPayload: {
                    total: orderData.total,
                    currency: orderData.currency,
                    module: orderData.originatingModule,
                    productId: orderData.productId
                },
                idempotencyKey: orderData.idempotencyKey ?? null,
            }).catch(async (e) => {
                // GE compensation: the order never committed, so the
                // seat and the credit claim from this attempt are undone.
                if (seatRegistered && vendorCtx?.groupBuyId) {
                    await releaseGroupBuySeat(db, {
                        groupBuyId: vendorCtx.groupBuyId,
                        orderId: primaryOrderId,
                        userId: orderData.userId,
                        reason: 'order_creation_failed',
                    }).catch((err) => console.error('[createOrder] seat release after tx failure failed:', err));
                }
                if (creditClaim && !creditClaim.alreadyClaimed) {
                    await restoreStoreCreditConsumption(db, {
                        buyerUid: orderData.userId,
                        idempotencyKey: creditClaimKey,
                        consumedIds: creditClaim.consumedIds,
                    }).catch((err) => console.error('[createOrder] credit restore after tx failure failed:', err));
                }
                throw e;
            });
            const committedOrderId = primaryResult.orderId as string;
            if (vendorCtx && primaryResult.created === false && committedOrderId !== primaryOrderId) {
                // The idempotency race was won by another attempt: undo
                // this attempt's seat and credits; the winner's stand.
                if (seatRegistered && vendorCtx.groupBuyId) {
                    await releaseGroupBuySeat(db, {
                        groupBuyId: vendorCtx.groupBuyId,
                        orderId: primaryOrderId,
                        userId: orderData.userId,
                        reason: 'order_creation_failed',
                    }).catch((err) => console.error('[createOrder] seat release after replay failed:', err));
                }
                if (creditClaim && !creditClaim.alreadyClaimed) {
                    await restoreStoreCreditConsumption(db, {
                        buyerUid: orderData.userId,
                        idempotencyKey: creditClaimKey,
                        consumedIds: creditClaim.consumedIds,
                    }).catch((err) => console.error('[createOrder] credit restore after replay failed:', err));
                }
            }
            if (seatPreExisting && primaryResult.created !== false) {
                console.error(`[createOrder] group seat pre-existed but a new order committed: ${committedOrderId}`);
            }
            console.log(`Order Created: ${committedOrderId} | Module: ${orderData.originatingModule} | User: ${orderData.userId}`);
            if (orderData.eventId) {
                console.log(`Registration mirrored → events/${orderData.eventId}/registrations/${orderData.userId}`);
            }
            // A4: chapter application link — post-tx best-effort, unchanged.
            if (orderData.chapterApplicationId) {
                try {
                    await db.collection('chapter_applications').doc(orderData.chapterApplicationId).update({
                        orderId: committedOrderId,
                        status: 'pending_review',
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    console.log(`[createOrder] Linked order ${committedOrderId} to chapter application ${orderData.chapterApplicationId}`);
                } catch (e) {
                    console.error(`[createOrder] Failed to link chapter application:`, e);
                }
            }
            return { success: true, id: committedOrderId };
        }

        // SEC-RACE (audit item 11): when the checkout sends its
        // per-attempt idempotency key, the order write is claimed
        // transactionally on (buyer, key) — a retried submission
        // returns the original order id instead of minting a
        // duplicate (the Supa-primary leg above dedupes the same key
        // inside tx_store_create_order). A replay skips every side
        // effect below: the winner already ran them. Keyless callers
        // keep the plain add, unchanged. (Idempotency handling only —
        // no pricing logic is touched here.)
        // GE: a vendor order always takes the transactional path (a
        // generated key when the caller sent none) so credit
        // consumption and the group seat commit atomically with the
        // order. The generated key is unique per call, so keyless
        // semantics (no dedupe) are preserved. House keyless calls
        // keep the plain add, byte-identical.
        const claim = await createOrderWithIdempotencyClaim(db, {
            buyerUid: orderData.userId,
            idempotencyKey: orderData.idempotencyKey ?? (vendorCtx ? `srv-${makeStoreDocId()}` : null),
            orderData: finalOrder,
            claimTimestamp: FieldValue.serverTimestamp(),
            beforeOrderWrite: vendorCtx
                ? async (t: any, orderRef: any) => {
                    const plan = await planStoreCreditsInTransaction(t, db, {
                        buyerUid: orderData.userId,
                        capPkr: vendorCtx.totalPkr,
                        nowMs: Date.now(),
                    });
                    if (vendorCtx.groupBuyId) {
                        try {
                            await registerGroupBuySeatTx(t, db.collection('group_buys').doc(vendorCtx.groupBuyId), {
                                orderId: orderRef.id,
                                userId: orderData.userId,
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
        if (!claim.created) {
            console.log(`Order Replay: ${claim.orderId} | Module: ${orderData.originatingModule} | User: ${orderData.userId}`);
            return { success: true, id: claim.orderId };
        }
        const res = { id: claim.orderId };

        console.log(`Order Created: ${res.id} | Module: ${orderData.originatingModule} | User: ${orderData.userId}`);

        // ── Mirror into events/{eventId}/registrations subcollection ─────────
        // CRITICAL: The ticket issue API looks up registrations by userId (uid).
        // We MUST use userId as the doc ID so the ticket system can find it.
        if (orderData.eventId) {
            const registrationDoc = {
                uid: orderData.userId,
                orderId: res.id,
                eventId: orderData.eventId,
                displayName: orderData.buyer?.fullName || '',
                email: orderData.buyer?.email || '',
                whatsappE164: orderData.buyer?.phone || orderData.buyer?.whatsappNumber || '',
                status: 'pending',
                paymentStatus: 'pending',
                paymentMethod: orderData.paymentMethod || 'bank_transfer',
                paymentRef: orderData.proofOfPaymentUrl || '',
                notes: orderData.notes || '',
                formResponses: orderData.formResponses || {},
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            };
            await db
                .collection('events')
                .doc(orderData.eventId)
                .collection('registrations')
                .doc(orderData.userId)
                .set(registrationDoc, { merge: true });
            console.log(`Registration mirrored → events/${orderData.eventId}/registrations/${orderData.userId}`);

            // NOTE (audit item 4): a checkout NEVER creates a product.
            // The auto-create stub that used to run here priced a new
            // product from the client-claimed total, poisoning the
            // catalog for later buyers; it is removed, not replaced.
            // Event-ticket products are created by the events flow
            // (syncEventToProduct, EV-P07) and priced at verification
            // time from the event record (see the pricing block above).
        }

        // ── Chapter Application Linkage ─────────────────────────────────────
        if (orderData.chapterApplicationId) {
            try {
                const linkPayload = {
                    orderId: res.id,
                    status: 'pending_review',
                    updatedAt: FieldValue.serverTimestamp(),
                };
                await db.collection('chapter_applications').doc(orderData.chapterApplicationId).update(linkPayload);
                // Applications mirror completeness (apps-1): this update
                // previously never reached fs_chapter_applications (the
                // same payload as linkOrderToApplication, which does
                // mirror). Dual-write: the never-throwing seam mirror.
                // Write primacy: the throwing primary update replaces it
                // as the commit gate — its failure lands in the catch
                // below, which is this host flow's deliberate semantics
                // (an order never fails because linkage failed), so a
                // primary failure is logged loudly, not surfaced.
                const gated = await updateChapterApplicationPrimaryFirst(orderData.chapterApplicationId, linkPayload);
                if (!gated) {
                    await mirrorChapterApplicationUpdate(orderData.chapterApplicationId, linkPayload);
                }
                console.log(`[createOrder] Linked order ${res.id} to chapter application ${orderData.chapterApplicationId}`);
            } catch (e) {
                console.error(`[createOrder] Failed to link chapter application:`, e);
            }
        }

        await db.collection('audit_logs').add({
            action: 'ORDER_CREATED',
            actorUid: orderData.userId,
            targetUidOrResource: res.id,
            payload: {
                total: orderData.total,
                currency: orderData.currency,
                module: orderData.originatingModule,
                productId: orderData.productId
            },
            timestamp: FieldValue.serverTimestamp(),
            source: 'server-action'
        });

        return { success: true, id: res.id };
    } catch (error: any) {
        console.error('Error creating order:', error);
        return { success: false, error: error.message };
    }
}

/**
 * GE: display read for the checkout page's store-credit line. One
 * buyer-bounded query through GA's helper; expiry filtered in code.
 * Runs the shared selection against the display cap so the page shows
 * exactly what creation would apply; creation re-runs it authoritatively.
 */
export async function getMyStoreCreditSummary(
    userId: string,
    capPkr: number,
): Promise<{ availablePkr: number; appliedPkr: number; credits: Array<{ id: string; amountPkr: number; code: string; expiresAtIso: string | null }> }> {
    const empty = { availablePkr: 0, appliedPkr: 0, credits: [] };
    try {
        const db = await getDb();
        if (!db || !userId) return empty;
        const credits = await listAvailableCreditsForUser(db as any, userId);
        const selectable = creditsForSelection(
            credits.map((c) => ({ id: c.id, data: c as unknown as Record<string, any> })),
            Date.now(),
        );
        const byId = new Map(credits.map((c) => [c.id, c]));
        const selection = selectStoreCredits(selectable, typeof capPkr === 'number' ? capPkr : 0);
        return {
            availablePkr: selectable.reduce((sum, c) => sum + c.amountPkr, 0),
            appliedPkr: selection.appliedPkr,
            credits: selectable.map((c) => {
                const expiresMs = timestampToMs(byId.get(c.id)?.expiresAt);
                return {
                    id: c.id,
                    amountPkr: c.amountPkr,
                    code: byId.get(c.id)?.code ?? '',
                    expiresAtIso: expiresMs !== null ? new Date(expiresMs).toISOString() : null,
                };
            }),
        };
    } catch (error) {
        console.error('Error fetching store credit summary:', error);
        return empty;
    }
}

/**
 * GE (test A2): the confirmation screen's not-found answer, stored
 * only on the order. First write wins; every authorization failure
 * returns the same "Order not found." so existence never leaks.
 */
export async function submitNotFoundText(args: {
    orderId: string;
    userId: string;
    text: string;
}): Promise<{ success: boolean; error?: string }> {
    const notFound = { success: false, error: 'Order not found.' };
    try {
        const text = typeof args?.text === 'string' ? args.text.trim() : '';
        if (!text || text.length > 500) {
            return { success: false, error: 'Please write a short answer, up to 500 characters.' };
        }
        if (!args?.orderId || !args?.userId) return notFound;

        const supa = await getStoreOrderFromSupa(args.orderId);
        let orderData: Record<string, any> | undefined;
        let viaPrimary = false;
        let db: any = null;
        if (supa) {
            if (!supa.found) return notFound;
            orderData = supa.data;
            viaPrimary = true;
        } else {
            db = await getDb();
            if (!db) return notFound;
            const snap = await db.collection('orders').doc(args.orderId).get();
            if (!snap.exists) return notFound;
            orderData = snap.data();
        }
        const buyerUserId = orderData?.buyerUserId ?? orderData?.userId;
        if (!orderData?.vendorId || buyerUserId !== args.userId) return notFound;
        if (typeof orderData.notFoundText === 'string' && orderData.notFoundText) {
            return { success: false, error: 'Thanks, that was already recorded.' };
        }
        if (viaPrimary) {
            await updateOrderNotFoundViaPrimary(args.orderId, text);
        } else {
            await db.collection('orders').doc(args.orderId).update({
                notFoundText: text,
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
        return { success: true };
    } catch (error: any) {
        console.error('Error submitting not-found text:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Assassination Trigger: Atomically syncs an event to the Store Products collection.
 * This ensures that a Paid Event is ALWAYS represented as a Store Product.
 */
export async function syncEventToProduct(eventData: any, existingProductId?: string) {
    try {
        const db = await getDb();
        if (!db) throw new Error('Database connection failed');

        const productPayload: any = {
            name: eventData.title,
            description: eventData.description || "",
            price: parseFloat(eventData.amountInput) || 0,
            currency: eventData.currency || "PKR",
            category: "event_ticket",
            eventId: eventData.id || eventData.slug,
            isActive: !!eventData.isPaid,
            imageUrl: eventData.imageUrl || eventData.image || "",
            updatedAt: FieldValue.serverTimestamp(),
            stock: eventData.capacity ? parseInt(eventData.capacity) : 999,
        };

        // WRITE PRIMACY (S-W4, isSupaPrimary('store-actions')): the
        // single-row write goes through the adapter; the payload is
        // byte-identical apart from timestamp representation
        // (serverTimestamp sentinel -> ISO string, the adapter's
        // storage ruling). EV-P07 semantics (category 'event_ticket',
        // product-link fields) untouched.
        const supaSync = await syncEventProductViaPrimary({
            payload: {
                ...productPayload,
                updatedAt: new Date().toISOString(),
                ...(existingProductId && existingProductId !== 'none'
                    ? {}
                    : { createdAt: new Date().toISOString() }),
            },
            existingProductId,
        });
        if (supaSync) {
            return { success: true, id: supaSync.id };
        }

        if (existingProductId && existingProductId !== 'none') {
            await db.collection('products').doc(existingProductId).update(productPayload);
            return { success: true, id: existingProductId };
        } else {
            const newRef = await db.collection('products').add({
                ...productPayload,
                createdAt: FieldValue.serverTimestamp(),
            });
            return { success: true, id: newRef.id };
        }
    } catch (error: any) {
        console.error('Error syncing event to product:', error);
        return { success: false, error: error.message };
    }
}

export async function getPublicProducts(): Promise<{ success: boolean; data?: Product[]; error?: string }> {
    try {
        // Supabase read path (flag 'store-actions'): null falls through to
        // the Firestore read below byte-identically.
        const supaProducts = await listPublicProductsFromSupa();
        if (supaProducts) {
            return { success: true, data: supaProducts as unknown as Product[] };
        }
        const db = await getDb();
        if (!db) throw new Error('Database connection failed');

        // READ-BLEED FIX (census 11): the Firestore FALLBACK was an
        // unbounded full scan of active products, paid on every
        // public /events view if the store-actions seam darkens.
        // Bounded at 1000 like the other product loads; the Supabase
        // primary path above is untouched.
        const productsSnap = await db.collection('products')
            .where('isActive', '==', true)
            .limit(1000)
            .get();

        const products = productsSnap.docs.map(doc => {
            const data = doc.data();
            return {
                ...data,
                id: doc.id,
                createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt,
                updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt,
            } as Product;
        });

        return { success: true, data: products };
    } catch (error: any) {
        console.error('Error fetching public products:', error);
        return { success: false, error: error.message };
    }
}
