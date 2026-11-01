"use client";

import { useEffect, useState, useCallback } from "react";
import { useUser } from "@/firebase";
import { firestore } from "@/firebase";
import Link from "next/link";
import {
  collection, getDoc, getDocs, doc, query, orderBy, limit, startAfter, Timestamp, where, onSnapshot, QueryDocumentSnapshot, DocumentData, serverTimestamp, arrayUnion } from 'firebase/firestore';
;
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { setDoc } from '@/lib/client/firestore-wrapper';
import { logAuditEntry } from "@/lib/audit-logging";
import { normalizeOrder } from "@/lib/finance/order-canonical";
import { SHOP_HAT_NOTE } from "@/lib/store/hat-note";

import {
  ShoppingCart,
  Search,
  Filter,
  ChevronRight,
  Eye,
  Edit,
  Trash2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Package,
  User,
  Mail,
  Phone,
  Ticket,
  ExternalLink,
  Building2,
  Award,
  Printer,
} from "lucide-react";

// Minimal user summary loaded from the picker API for name lookups.
// (No email: contact fields live in the gated users/{uid}/private/contact
// doc, not on the public user doc. Order-doc buyer emails are unaffected.)
interface StoreUserSummary {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

interface Order {
  id: string;
  userId?: string;
  items: Array<{
    productId?: string;
    productName?: string;
    title?: string;
    type?: string;
    quantity: number;
    price?: number;
    subtotal?: number;
  }>;
  total?: number;
  amount?: number;
  currency: string;
  status: string;
  paymentMethod?: string;
  paymentStatus?: 'pending' | 'completed' | 'failed' | 'refunded';
  shippingAddress?: {
    name: string;
    address: string;
    city: string;
    postalCode: string;
    country: string;
  };
  buyer?: {
    fullName?: string;
    email?: string;
    whatsappNumber?: string;
    address?: string;
    notes?: string;
  };
  buyerUserId?: string;
  certificateCode?: string;
  holderUserId?: string;
  vendorId?: string | null;
  courierName?: string | null;
  trackingNumber?: string | null;
  notFoundText?: string | null;
  groupBuyId?: string | null;
  escrowStatus?: string | null;
  payoutId?: string | null;
  relayedAt?: Timestamp | null;
  relayedBy?: string | null;
  returnClaimOpen?: boolean;
  fulfilmentNote?: string;
  notes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy?: string;
  updatedBy?: string;
  originatingModule?: string;
  eventId?: string;
  productId?: string;
  testMode?: boolean;
  receiptUrl?: string;
  deletedAt?: Timestamp | null;
  deletedBy?: string | null;
  deleteReason?: string | null;
}

interface UserInfo {
  id: string;
  displayName?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

interface Product {
  id: string;
  name: string;
  price: number;
  currency: string;
}

const ITEMS_PER_PAGE = 20;
const ORDER_STATUSES = [
  { value: 'pending', label: 'Pending', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'pending_verification', label: 'Pending Verification', color: 'bg-orange-100 text-orange-800' },
  { value: 'verified', label: 'Verified', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'processing', label: 'Processing', color: 'bg-blue-100 text-blue-800' },
  { value: 'shipped', label: 'Shipped', color: 'bg-purple-100 text-purple-800' },
  { value: 'delivered', label: 'Delivered', color: 'bg-green-100 text-green-800' },
  { value: 'cancelled', label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  { value: 'refunded', label: 'Refunded', color: 'bg-rose-100 text-rose-800' },
  { value: 'soft_deleted', label: 'Soft Deleted', color: 'bg-gray-200 text-gray-700' }
];

export function OrderManagement({ initialView }: { initialView?: string } = {}) {
  const { user } = useUser();
  const { toast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [users, setUsers] = useState<StoreUserSummary[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("all");
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<Order>>({});
  const [issuingIds, setIssuingIds] = useState<string[]>([]);
  const [approvingIds, setApprovingIds] = useState<string[]>([]);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [deleteReason, setDeleteReason] = useState("");
  // Certificates / Fulfilment view + actions, ported from the retired
  // standalone /admin/orders page (which now redirects here).
  const [certificatesOnly, setCertificatesOnly] = useState(initialView === "certificates");
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [markingPaidIds, setMarkingPaidIds] = useState<string[]>([]);
  const [fulfillingIds, setFulfillingIds] = useState<string[]>([]);
  // Vendor name resolution (bounded): only the distinct vendorIds on the
  // currently loaded orders page, one doc get each, cached in this map.
  // Never a vendors collection read.
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({});
  const [claimingIds, setClaimingIds] = useState<string[]>([]);
  const [relayingIds, setRelayingIds] = useState<string[]>([]);
  const [trackingDraft, setTrackingDraft] = useState<{ courierName: string; trackingNumber: string }>({ courierName: "", trackingNumber: "" });
  const [teamShareCode, setTeamShareCode] = useState<string | null>(null);

  useEffect(() => {
    const missing = [...new Set(orders.map(o => o.vendorId).filter((v): v is string => !!v))].filter(id => !(id in vendorNames));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const resolved: Record<string, string> = {};
      for (const vendorId of missing.slice(0, 20)) {
        try {
          const snap = await getDoc(doc(firestore, 'vendors', vendorId));
          if (snap.exists()) {
            const name = (snap.data() as any)?.businessName;
            if (typeof name === 'string' && name) resolved[vendorId] = name;
          }
        } catch {
          // Name stays unresolved; the row falls back to "Vendor order".
        }
      }
      if (!cancelled && Object.keys(resolved).length > 0) setVendorNames(prev => ({ ...prev, ...resolved }));
    })();
    return () => { cancelled = true; };
  }, [orders, vendorNames]);

  // Load users for relationship management.
  // READ-BLEED FIX (census 11): this used to preload the `users`
  // collection from the browser with limit(1000) on every Orders-tab
  // mount (~257 reads inside a ~322-read mount bundle) just to
  // resolve buyer names. Names now come from the picker API, the
  // same users seam other admin surfaces use (server-side bounded
  // and cached). The picker returns displayName only, so it fills
  // firstName: the name compositions below render it verbatim, which
  // matches the previous first+last rendering for named accounts.
  const loadUsers = useCallback(async () => {
    try {
      if (!user) {
        setUsers([]);
        return;
      }
      const token = await user.getIdToken();
      const res = await fetch('/api/users/picker?limit=1000', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
      const json = await res.json();
      const usersData: StoreUserSummary[] = (json.users || []).map((row: any) => ({
        id: String(row.uid),
        displayName: (row.displayName || '').toString(),
        firstName: (row.displayName || '').toString(),
        lastName: ''
      }));
      setUsers(usersData);
    } catch (error) {
      console.error("Error loading users:", error);
    }
  }, [user]);

  // Load products for relationship management
  const loadProducts = useCallback(async () => {
    try {
      const productsRef = collection(firestore, "products");
      const productsQuery = query(productsRef, where("isActive", "==", true), limit(1000));
      const productsSnap = await getDocs(productsQuery);
      const productsData = productsSnap.docs.map(doc => ({
        id: doc.id,
        name: doc.data().name,
        price: doc.data().price,
        currency: doc.data().currency
      }));
      setProducts(productsData);
    } catch (error) {
      console.error("Error loading products:", error);
    }
  }, []);

  // Load orders with pagination
  const loadOrders = useCallback(async (isFirstLoad = false) => {
    try {
      setLoading(true);
      const ordersRef = collection(firestore, "orders");

      let ordersQuery = query(
        ordersRef,
        orderBy("createdAt", "desc"),
        limit(ITEMS_PER_PAGE)
      );

      if (!isFirstLoad && lastDoc) {
        ordersQuery = query(
          ordersRef,
          orderBy("createdAt", "desc"),
          startAfter(lastDoc),
          limit(ITEMS_PER_PAGE)
        );
      }

      const ordersSnap = await getDocs(ordersQuery);
      // Soft-delete filter (Item 7, Q2): drop docs with deletedAt set.
      const ordersData = ordersSnap.docs.filter(doc => { const dd: any = doc.data(); return dd.deletedAt === undefined || dd.deletedAt === null; }).map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Order[];

      // Apply filters
      let filteredOrders = ordersData;

      if (searchTerm) {
        filteredOrders = filteredOrders.filter(order => {
          let userName = '';
          let userEmail = '';

          // Check buyer information first (certificate orders)
          if (order.buyer?.fullName) {
            userName = order.buyer.fullName;
          }
          if (order.buyer?.email) {
            userEmail = order.buyer.email;
          }

          // If no buyer info, check buyerUserId (certificate orders)
          if (!userName && order.buyerUserId) {
            const user = users.find(u => u.id === order.buyerUserId);
            if (user) {
              userName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
            }
          }

          // Fallback to userId (event orders)
          if (!userName && order.userId) {
            const user = users.find(u => u.id === order.userId);
            if (user) {
              userName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
            }
          }

          const orderId = order.id.toLowerCase();
          const searchLower = searchTerm.toLowerCase();

          return (
            orderId.includes(searchLower) ||
            userName.toLowerCase().includes(searchLower) ||
            userEmail.toLowerCase().includes(searchLower) ||
            order.status.toLowerCase().includes(searchLower)
          );
        });
      }

      if (statusFilter !== "all") {
        filteredOrders = filteredOrders.filter(order => order.status === statusFilter);
      }

      if (paymentStatusFilter !== "all") {
        filteredOrders = filteredOrders.filter(order => order.paymentStatus === paymentStatusFilter);
      }

      if (isFirstLoad) {
        setOrders(filteredOrders);
      } else {
        setOrders(prev => [...prev, ...filteredOrders]);
      }

      setHasMore(ordersSnap.docs.length === ITEMS_PER_PAGE);
      if (ordersSnap.docs.length > 0) {
        setLastDoc(ordersSnap.docs[ordersSnap.docs.length - 1]);
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error loading orders",
        description: "Failed to load orders. Please try again."
      });
    } finally {
      setLoading(false);
    }
  }, [lastDoc, searchTerm, statusFilter, paymentStatusFilter, users, toast]);

  useEffect(() => {
    loadUsers();
    loadProducts();
  }, [loadUsers, loadProducts]);

  // Pending maker-checker requests made by this admin, so the certificate
  // "Mark Paid" action can disable itself while a request is outstanding
  // (ported from the retired /admin/orders page).
  useEffect(() => {
    (async () => {
      if (!user) return;
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/admin/finance/approvals?scope=mine', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const ids = new Set<string>(
          (data.approvals ?? [])
            .filter((a: { status: string }) => a.status === 'pending')
            .map((a: { targetId: string }) => a.targetId),
        );
        setPendingApprovalIds(ids);
      } catch {
        /* pending state is best-effort */
      }
    })();
  }, [user]);

  // ── Real-time listener for first page (no pagination) ─────────────────────
  // This ensures that when admin verifies payment or issues ticket, the card
  // updates instantly without needing to manually refresh the page.
  useEffect(() => {
    const ordersRef = collection(firestore, "orders");
    const q = query(ordersRef, orderBy("createdAt", "desc"), limit(ITEMS_PER_PAGE));
    const unsub = onSnapshot(q, (snap) => {
      // Soft-delete filter (Item 7, Q2): drop docs with deletedAt set.
      const docs = snap.docs.filter(d => { const dd: any = d.data(); return dd.deletedAt === undefined || dd.deletedAt === null; }).map(d => ({ id: d.id, ...d.data() })) as Order[];
      // Merge: update existing orders in place, preserving any loaded-more pages
      setOrders(prev => {
        if (prev.length <= ITEMS_PER_PAGE) {
          // First page only — replace fully
          return docs;
        }
        // Update first-page items in place, keep the rest
        const tail = prev.slice(ITEMS_PER_PAGE);
        return [...docs, ...tail];
      });
      setLoading(false);
    }, (err) => {
      console.error('[OrderManagement] onSnapshot error:', err);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setCurrentPage(0);
    setLastDoc(null);
    loadOrders(true);
  }, [loadOrders]);

  const loadMore = () => {
    if (!loading && hasMore) {
      setCurrentPage(prev => prev + 1);
      loadOrders(false);
    }
  };

  const validateOrderUpdate = (order: Partial<Order>): string[] => {
    const errors: string[] = [];

    if (!order.status || !ORDER_STATUSES.find(s => s.value === order.status)) {
      errors.push("Please select a valid order status");
    }

    if (order.paymentStatus && !['pending', 'completed', 'failed', 'refunded'].includes(order.paymentStatus)) {
      errors.push("Please select a valid payment status");
    }

    if (order.notes && order.notes.length > 500) {
      errors.push("Notes must be less than 500 characters");
    }

    return errors;
  };

  const handleStatusUpdate = async (order: Order, newStatus: string) => {
    try {
      if (!user) return;

      const token = await user.getIdToken();
      const res = await fetch('/api/store/orders', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          orderId: order.id,
          // Non-money fields only (CH-13): paymentStatus is a money field
          // and is rejected by the orders API; payment state changes go
          // through the maker-checker approvals flow.
          updates: {
            status: newStatus
          }
        })
      });

      if (!res.ok) {
        throw new Error('Failed to update order status');
      }

      toast({
        title: "Status Updated",
        description: `Order ${order.id.slice(0, 8)}... status changed to ${newStatus}`
      });

      // Reload orders
      setCurrentPage(0);
      setLastDoc(null);
      loadOrders(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: "Failed to update order status. Please try again."
      });
    }
  };

  const handleOrderUpdate = async () => {
    try {
      if (!user || !selectedOrder) return;

      const validationErrors = validateOrderUpdate(editFormData);
      if (validationErrors.length > 0) {
        toast({
          variant: "destructive",
          title: "Validation Error",
          description: validationErrors.join(", "),
        });
        return;
      }

      setSaving(true);

      const payload: any = { ...editFormData };
      // Money fields never go through this form (CH-13): paymentStatus is
      // stripped, and a 'verified' status is a money state change that
      // belongs to the approvals flow, not a direct PATCH.
      delete payload.paymentStatus;
      if (payload.status === 'verified') {
        toast({
          variant: "destructive",
          title: "Use the approvals flow",
          description: "Verifying a payment requires a maker-checker request (Verify Payment action / Finance approvals queue)."
        });
        setSaving(false);
        return;
      }

      const token = await user.getIdToken();
      const res = await fetch('/api/store/orders', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          orderId: selectedOrder.id,
          updates: payload
        })
      });

      if (!res.ok) {
        throw new Error('Update failed via API');
      }

      toast({
        title: "Order Updated",
        description: `Order ${selectedOrder.id.slice(0, 8)}... has been updated successfully.`
      });

      // Close dialog and reload
      setIsEditDialogOpen(false);
      setSelectedOrder(null);
      setCurrentPage(0);
      setLastDoc(null);
      loadOrders(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Update Failed",
        description: "Failed to update order. Please try again."
      });
    } finally {
      setSaving(false);
    }
  };

  // Hard delete is retired (CH-13): removal is a soft-delete REQUEST
  // through the maker-checker approvals flow; a reason is mandatory and
  // the order stays fully visible until a checker approves.
  // DEFECT 4(c): the reason comes from the dialog's own Textarea (the
  // caller passes the `deleteReason` state it renders). The previous
  // version of this handler ignored that argument and re-asked via
  // window.prompt — a different input from the one the admin had just
  // filled — so a visibly-entered reason was rejected as missing
  // whenever the prompt came back empty.
  const handleDeleteOrder = async (orderId: string, reasonInput?: string) => {
    if (!user) return;
    const reason = reasonInput ?? deleteReason;
    if (!reason || !reason.trim()) {
      toast({ variant: 'destructive', title: 'Reason required', description: 'A soft-delete request needs a reason.' });
      return;
    }
    setDeletingIds(p => [...p, orderId]);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/finance/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          targetType: 'order_soft_delete',
          targetId: orderId,
          changePayload: {},
          // R-24 (coordinator): the company hat note stamps VENDOR order
          // actions only. A house order's reason stays exactly what the
          // admin typed: no company claim on society money actions.
          reason: orders.find((o) => o.id === orderId)?.vendorId
            ? `${SHOP_HAT_NOTE} ${reason.trim()}`
            : reason.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed');
      }
      toast({ title: 'Soft delete requested', description: `Order ${orderId.slice(0, 8)}... will be removed after checker approval.` });
      setDeleteReason("");
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Request failed', description: e.message });
    } finally {
      setDeletingIds(p => p.filter(id => id !== orderId));
    }
  };

  // ── Certificate fulfilment (ported from the retired /admin/orders page) ──
  const isCertificateOrder = (order: Order) =>
    Boolean(order.certificateCode) ||
    (order.items ?? []).some((item) => (item.type ?? '').includes('certificate'));

  const certificateAmountLabel = (order: Order) => {
    const canonical = normalizeOrder(order as unknown as Record<string, unknown>, order.id);
    if (canonical.totalPkr != null) return `PKR ${canonical.totalPkr.toLocaleString('en-PK')}`;
    if (canonical.declaredAmountPkr != null) return `PKR ${canonical.declaredAmountPkr.toLocaleString('en-PK')} (declared)`;
    return null;
  };

  // "Mark Paid" is a money state change: it creates a maker-checker request
  // (order_mark_paid, the type the standalone Orders page used); a checker
  // approves it in the Finance approvals queue before it takes effect.
  const requestMarkPaid = async (order: Order) => {
    if (!user) return;
    setMarkingPaidIds(p => [...p, order.id]);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/finance/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          targetType: 'order_mark_paid',
          targetId: order.id,
          changePayload: { fromStatus: order.status, toStatus: 'verified' },
          // R-24: hat note on vendor orders only; house orders keep the
          // pre-shop payload (no reason field), byte-identical.
          ...(order.vendorId ? { reason: SHOP_HAT_NOTE } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setPendingApprovalIds((prev) => new Set(prev).add(order.id));
      // Defect 2: alreadyPending means the route consumed the outstanding
      // equivalent request for this order — that is success, not a failure.
      toast(data.alreadyPending
        ? { title: 'Verification already requested', description: 'This order already has a pending verification request awaiting a checker.' }
        : { title: 'Verification requested', description: 'A checker must approve this payment before it takes effect.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Request failed', description: e.message });
    } finally {
      setMarkingPaidIds(p => p.filter(id => id !== order.id));
    }
  };

  // Non-money fulfilment writes go through the orders API, with the same
  // audit entry the standalone Orders page wrote.
  const patchFulfilment = async (order: Order, status: 'processing' | 'shipped', note?: string) => {
    if (!user) return;
    setFulfillingIds(p => [...p, order.id]);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/store/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ orderId: order.id, updates: { status, ...(note ? { fulfilmentNote: note } : {}) } }),
      });
      if (!res.ok) throw new Error('Update failed');
      await logAuditEntry(firestore, 'ORDER_STATUS_CHANGED', user.uid, `orders/${order.id}`, {
        fromStatus: order.status,
        toStatus: status,
        fulfilmentNote: note ?? null,
      }).catch(() => undefined);
      toast({ title: 'Order updated', description: `Status set to ${status}.` });
      setCurrentPage(0);
      setLastDoc(null);
      loadOrders(true);
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Update failed', description: 'Could not update order status.' });
    } finally {
      setFulfillingIds(p => p.filter(id => id !== order.id));
    }
  };

  // Relay sent (transition 4): records that the admin relayed the order
  // to the vendor on WhatsApp. The orders PATCH stamps relayedAt and
  // relayedBy server-side; no WhatsApp send happens in code.
  const handleRelaySent = async (order: Order) => {
    if (!user) return;
    setRelayingIds(p => [...p, order.id]);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/store/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ orderId: order.id, updates: { status: 'processing' } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');
      toast({ title: 'Relay marked sent' });
      setCurrentPage(0);
      setLastDoc(null);
      loadOrders(true);
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Update failed', description: e.message });
    } finally {
      setRelayingIds(p => p.filter(id => id !== order.id));
    }
  };

  // Return claim flag (M7 surface): GF's claim route moves the order's
  // ledger entry out of payout drafts. A 409 comes back verbatim when
  // the entry is already held.
  const handleClaimFlag = async (order: Order) => {
    if (!user) return;
    setClaimingIds(p => [...p, order.id]);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/store/orders/${order.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ claimOpen: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Claim failed');
      toast({ title: 'Return claim flagged. This order is out of payout drafts.' });
      setCurrentPage(0);
      setLastDoc(null);
      loadOrders(true);
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Claim failed', description: e.message });
    } finally {
      setClaimingIds(p => p.filter(id => id !== order.id));
    }
  };

  const handleSaveTracking = async (order: Order) => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/store/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          orderId: order.id,
          updates: { courierName: trackingDraft.courierName, trackingNumber: trackingDraft.trackingNumber },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Update failed');
      toast({ title: 'Tracking saved' });
      setCurrentPage(0);
      setLastDoc(null);
      loadOrders(true);
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Update failed', description: e.message });
    }
  };

  const viewOrderDetails = (order: Order) => {
    setSelectedOrder(order);
    setEditFormData({
      status: order.status,
      paymentStatus: order.paymentStatus,
      notes: order.notes
    });
    setTrackingDraft({ courierName: order.courierName ?? "", trackingNumber: order.trackingNumber ?? "" });
    setTeamShareCode(null);
    if (order.groupBuyId) {
      getDoc(doc(firestore, 'group_buys', order.groupBuyId))
        .then(snap => {
          if (snap.exists()) {
            const code = (snap.data() as any)?.shareCode;
            if (typeof code === 'string' && code) setTeamShareCode(code);
          }
        })
        .catch(() => undefined);
    }
    setIsDetailDialogOpen(true);
  };

  const editOrder = (order: Order) => {
    setSelectedOrder(order);
    setEditFormData({
      status: order.status,
      paymentStatus: order.paymentStatus,
      notes: order.notes
    });
    setIsEditDialogOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = ORDER_STATUSES.find(s => s.value === status);
    if (!statusConfig) return <Badge variant="secondary">{status}</Badge>;

    return (
      <Badge className={statusConfig.color}>
        {statusConfig.label}
      </Badge>
    );
  };

  const getUserName = (order: Order) => {
    // Check if order has buyer information (certificate orders)
    if (order.buyer?.fullName) {
      return order.buyer.fullName;
    }

    // Check if order has buyerUserId (certificate orders)
    if (order.buyerUserId) {
      const user = users.find(u => u.id === order.buyerUserId);
      if (user) {
        const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        return name || user.displayName || "Unknown User";
      }
    }

    // Fallback to userId (event orders)
    if (order.userId) {
      const user = users.find(u => u.id === order.userId);
      if (user) {
        const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        return name || user.displayName || "Unknown User";
      }
    }

    return "Unknown User";
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <Clock className="h-4 w-4" />;
      case 'processing':
        return <Package className="h-4 w-4" />;
      case 'shipped':
        return <Package className="h-4 w-4" />;
      case 'delivered':
        return <CheckCircle className="h-4 w-4" />;
      case 'cancelled':
        return <XCircle className="h-4 w-4" />;
      default:
        return <AlertTriangle className="h-4 w-4" />;
    }
  };

  const visibleOrders = certificatesOnly ? orders.filter(isCertificateOrder) : orders;

  return (
    <div className="space-y-6">
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" />
                Order Management
              </CardTitle>
              <CardDescription>
                Manage customer orders with pagination, user relationships, and enhanced tracking
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-sm">
                Total: {visibleOrders.length} orders{certificatesOnly ? " (certificates)" : ""}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-wrap gap-4 mb-6">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4" />
              <Input
                placeholder="Search orders (ID, user name, email)..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-80"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {ORDER_STATUSES.map(status => (
                  <SelectItem key={status.value} value={status.value}>
                    {status.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={paymentStatusFilter} onValueChange={setPaymentStatusFilter}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Payment Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Payment Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="refunded">Refunded</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant={certificatesOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setCertificatesOnly(v => !v)}
              aria-pressed={certificatesOnly}
            >
              <Award className="h-4 w-4 mr-2" />
              Certificates / Fulfilment
            </Button>
          </div>

          {/* Orders List */}
          {loading && orders.length === 0 ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p>Loading orders...</p>
            </div>
          ) : (
            <>
              {visibleOrders.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  {certificatesOnly ? "No certificate orders match this view." : "No orders yet."}
                </div>
              )}
              <div className="space-y-4">
                {visibleOrders.map((order) => (
                  <Card key={order.id} className="border">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-3">
                            <h3 className="font-semibold text-lg">
                              Order #{order.id.slice(0, 8)}...
                            </h3>
                            {getStatusBadge(order.status)}
                            {getStatusIcon(order.status)}
                            {order.paymentStatus && (
                              <Badge variant="outline" className="capitalize">
                                Payment: {order.paymentStatus}
                              </Badge>
                            )}
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                            <div>
                              <Label className="text-xs text-muted-foreground">Customer</Label>
                              <div className="flex items-center gap-2">
                                <User className="h-4 w-4" />
                                <span className="text-sm font-medium">
                                  {getUserName(order)}
                                </span>
                              </div>
                              {/* Show buyer email if available */}
                              {order.buyer?.email && (
                                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                                  <Mail className="h-3 w-3" />
                                  <span>{order.buyer.email}</span>
                                </div>
                              )}
                              {/* Show buyer whatsapp if available */}
                              {order.buyer?.whatsappNumber && (
                                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                                  <Phone className="h-3 w-3" />
                                  <span>{order.buyer.whatsappNumber}</span>
                                </div>
                              )}
                              {/* Show buyer address if available */}
                              {order.buyer?.address && (
                                <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]" title={order.buyer.address}>
                                  📍 {order.buyer.address}
                                </div>
                              )}
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Total Amount</Label>
                              <div className="text-sm font-medium">
                                {order.currency} {typeof order.amount === 'number' ? order.amount.toFixed(2) : (typeof order.total === 'number' ? order.total.toFixed(2) : '0.00')}
                              </div>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Items</Label>
                              <div className="text-sm font-medium">
                                {order.items?.length || 0} item(s)
                              </div>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Created</Label>
                              <div className="text-sm">
                                {order.createdAt.toDate().toLocaleDateString()}
                              </div>
                            </div>
                            {order.certificateCode && (
                              <div>
                                <Label className="text-xs text-muted-foreground">Certificate Code</Label>
                                <div className="text-sm font-medium font-mono">{order.certificateCode}</div>
                              </div>
                            )}
                            {order.receiptUrl && (
                              <div>
                                <Label className="text-xs text-muted-foreground">Receipt</Label>
                                <div className="text-sm">
                                  <a href={order.receiptUrl} target="_blank" rel="noreferrer" className="underline">View</a>
                                </div>
                              </div>
                            )}
                            {order.originatingModule && (
                              <div>
                                <Label className="text-xs text-muted-foreground">Module</Label>
                                <div className="text-sm font-medium">{order.originatingModule}</div>
                              </div>
                            )}
                            {order.testMode && (
                              <div>
                                <Label className="text-xs text-muted-foreground">Mode</Label>
                                <Badge variant="outline">Test</Badge>
                              </div>
                            )}
                          </div>

                          {/* Items Preview */}
                          {order.items && order.items.length > 0 && (
                            <div className="mb-4">
                              <Label className="text-xs text-muted-foreground mb-2 block">Items</Label>
                              <div className="space-y-1">
                                {order.items.slice(0, 3).map((item, index) => (
                                  <div key={index} className="text-sm text-muted-foreground">
                                    {item.quantity}x {item.productName}
                                    {item.price && ` - ${order.currency} ${typeof item.price === 'number' ? item.price.toFixed(2) : '0.00'} each`}
                                  </div>
                                ))}
                                {order.items.length > 3 && (
                                  <div className="text-xs text-muted-foreground">
                                    ... and {order.items.length - 3} more items
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {order.vendorId && (
                            <div className="text-sm text-muted-foreground mb-2">
                              Vendor: {vendorNames[order.vendorId] ?? 'Vendor order'}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => viewOrderDetails(order)}
                            >
                              <Eye className="h-4 w-4 mr-1" />
                              View
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => editOrder(order)}
                            >
                              <Edit className="h-4 w-4 mr-1" />
                              Edit
                            </Button>
                          </div>
                          {order.vendorId && order.status === 'verified' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              disabled={relayingIds.includes(order.id)}
                              onClick={() => handleRelaySent(order)}
                            >
                              Relay sent
                            </Button>
                          )}
                          {order.vendorId && ['verified', 'processing', 'shipped', 'delivered'].includes(order.status) && !order.returnClaimOpen && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              disabled={claimingIds.includes(order.id)}
                              onClick={() => handleClaimFlag(order)}
                            >
                              Flag return claim
                            </Button>
                          )}
                          {/* ── Hard Delete (for testing / clean-up) ── */}
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20"
                                disabled={deletingIds.includes(order.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-1" />
                                {deletingIds.includes(order.id) ? 'Deleting…' : 'Delete Order'}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Request Soft Delete?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Orders are never permanently wiped. This creates a soft-delete{' '}
                                  <strong>request</strong> for order{' '}
                                  <code className="font-mono text-xs">{order.id.slice(0, 12)}…</code> that a
                                  checker must approve; the order remains recoverable and auditable.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <div className="py-2">
                                <Label htmlFor={`delete-reason-${order.id}`}>Reason (required)</Label>
                                <Textarea
                                  id={`delete-reason-${order.id}`}
                                  value={deleteReason}
                                  onChange={(e) => setDeleteReason(e.target.value)}
                                  placeholder="Why is this order being deleted?"
                                  rows={2}
                                />
                              </div>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-red-600 hover:bg-red-700 text-foreground"
                                  onClick={() => handleDeleteOrder(order.id, deleteReason)}
                                >
                                  Request Soft Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>

                          {/* ── One-Stop Event Approval Panel ── */}
                          {order.eventId && (
                            <div className="mt-3 p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 space-y-2">
                              <p className="text-xs font-bold text-amber-400 uppercase tracking-wide">⚡ Event Order Actions</p>
                              {/* Verify Payment */}
                              {order.paymentStatus !== 'completed' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-full text-xs border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                                  disabled={approvingIds.includes(order.id) || pendingApprovalIds.has(order.id)}
                                  onClick={async () => {
                                    // Maker-checker (CH-09/CH-13): verification is a
                                    // REQUEST. A checker approves it in the finance
                                    // approvals queue; the apply step performs the
                                    // order update AND the event registration mirror
                                    // atomically. No direct client money writes remain.
                                    if (!user) return;
                                    setApprovingIds(p => [...p, order.id]);
                                    try {
                                      const token = await user.getIdToken();
                                      const res = await fetch('/api/admin/finance/approvals', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                        body: JSON.stringify({
                                          targetType: 'order_verify_payment',
                                          targetId: order.id,
                                          changePayload: { fromStatus: order.status, toStatus: 'verified' },
                                          // R-24: hat note on vendor orders only.
                                          ...(order.vendorId ? { reason: SHOP_HAT_NOTE } : {}),
                                        }),
                                      });
                                      const data = await res.json().catch(() => ({}));
                                      if (!res.ok) throw new Error(data.error || 'Request failed');
                                      // Defect 2: an already-pending equivalent request is
                                      // consumed by the approvals route (alreadyPending),
                                      // not a failure — the outstanding request is the one
                                      // a checker approves in the Finance approvals queue.
                                      if (data.alreadyPending) {
                                        setPendingApprovalIds((prev) => new Set(prev).add(order.id));
                                        toast({ title: 'Verification already requested', description: 'This order already has a pending verification request — a checker must approve it in the Finance approvals queue.' });
                                      } else {
                                        toast({ title: 'Verification requested', description: 'A checker must approve before the seat is confirmed.' });
                                      }
                                    } catch (e: any) {
                                      toast({ variant: 'destructive', title: 'Failed', description: e.message });
                                    } finally {
                                      setApprovingIds(p => p.filter(id => id !== order.id));
                                    }
                                  }}
                                >
                                  <CheckCircle className="h-3.5 w-3.5 mr-1" /> {pendingApprovalIds.has(order.id) ? 'Verification Pending' : 'Verify Payment & Confirm Seat'}
                                </Button>
                              )}
                              {/* Issue Ticket — only when verified */}
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                                disabled={order.paymentStatus !== 'completed' || issuingIds.includes(order.id)}
                                onClick={async () => {
                                  const uid = order.userId || order.buyerUserId;
                                  if (!user || !uid) return;
                                  setIssuingIds(p => [...p, order.id]);
                                  try {
                                    const token = await user.getIdToken();
                                    const res = await fetch('/api/v1/tickets/issue', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                      body: JSON.stringify({ eventId: order.eventId, uid }),
                                    });
                                    const data = await res.json();
                                    if (!res.ok) throw new Error(data?.error || 'Issue failed');
                                    const ticketUrl = `/events/ticket/${data.ticketId}${!data.existing ? '?new=1' : ''}`;
                                    window.open(ticketUrl, '_blank');
                                    toast({ title: `🎟️ Ticket ${data.existing ? 'already exists' : 'issued!'} — opened in new tab` });
                                  } catch (e: any) {
                                    toast({ variant: 'destructive', title: 'Ticket issue failed', description: e.message });
                                  } finally {
                                    setIssuingIds(p => p.filter(id => id !== order.id));
                                  }
                                }}
                              >
                                <Ticket className="h-3.5 w-3.5 mr-1" />
                                {issuingIds.includes(order.id) ? 'Issuing...' : 'Issue Ticket'}
                                {order.paymentStatus !== 'completed' && <span className="ml-1 opacity-50">(verify first)</span>}
                              </Button>
                              {/* Drive link proof */}
                              {(order as any).proofOfPaymentUrl && (
                                <a
                                  href={(order as any).proofOfPaymentUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300 underline"
                                >
                                  <ExternalLink className="h-3 w-3" /> View Payment Proof
                                </a>
                              )}
                            </div>
                          )}

                          {/* Chapter Registration Order Actions */}
                          {((order as any).chapterApplicationId || (order as any).originatingModule === 'chapter-registration') && (
                            <div className="mt-3 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5 space-y-2">
                              <p className="text-xs font-bold text-blue-400 uppercase tracking-wide">🏫 Chapter Registration</p>
                              <p className="text-xs text-muted-foreground">
                                Application ID: <code className="bg-muted px-1 rounded">{(order as any).chapterApplicationId || 'N/A'}</code>
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full text-xs border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                                onClick={() => window.open('/admin/chapter-applications', '_blank')}
                              >
                                <Building2 className="h-3.5 w-3.5 mr-1" /> Open Chapter Applications Dashboard
                              </Button>
                            </div>
                          )}

                          {/* ── Certificate Fulfilment Panel (ported from the retired /admin/orders page) ── */}
                          {isCertificateOrder(order) && (
                            <div className="mt-3 p-3 rounded-lg border border-primary/20 bg-primary/5 space-y-2">
                              <p className="text-xs font-bold text-primary uppercase tracking-wide">🎓 Certificate Fulfilment</p>
                              {certificateAmountLabel(order) && (
                                <p className="text-xs text-muted-foreground">Amount: {certificateAmountLabel(order)}</p>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full text-xs border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                                disabled={pendingApprovalIds.has(order.id) || markingPaidIds.includes(order.id) || order.paymentStatus === 'completed'}
                                onClick={() => requestMarkPaid(order)}
                              >
                                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                                {pendingApprovalIds.has(order.id) ? 'Verification Pending' : 'Mark Paid'}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full text-xs"
                                disabled={fulfillingIds.includes(order.id) || order.status === 'processing'}
                                onClick={() => patchFulfilment(order, 'processing', 'Certificate printed')}
                              >
                                <Printer className="h-3.5 w-3.5 mr-1" /> Mark Printed
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full text-xs"
                                disabled={fulfillingIds.includes(order.id) || order.status === 'shipped'}
                                onClick={() => patchFulfilment(order, 'shipped')}
                              >
                                <Package className="h-3.5 w-3.5 mr-1" /> Mark Shipped
                              </Button>
                              {order.status === 'shipped' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-full text-xs"
                                  onClick={() => handleStatusUpdate(order, 'delivered')}
                                >
                                  Mark Delivered
                                </Button>
                              )}
                            </div>
                          )}

                          {/* Generic Quick Status Updates for non-event, non-certificate orders */}
                          {!order.eventId && !isCertificateOrder(order) && (
                            <div className="flex flex-col gap-1 mt-2">
                              {order.status !== 'delivered' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => handleStatusUpdate(order, 'processing')}
                                  disabled={order.status === 'processing'}
                                >
                                  Mark Processing
                                </Button>
                              )}
                              {order.status === 'processing' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => handleStatusUpdate(order, 'shipped')}
                                >
                                  Mark Shipped
                                </Button>
                              )}
                              {order.status === 'shipped' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => handleStatusUpdate(order, 'delivered')}
                                >
                                  Mark Delivered
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Pagination */}
              {hasMore && (
                <div className="flex justify-center mt-6">
                  <Button onClick={loadMore} disabled={loading} variant="outline">
                    {loading ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 mr-2"></div>
                        Loading...
                      </>
                    ) : (
                      <>
                        <ChevronRight className="h-4 w-4 mr-2" />
                        Load More Orders
                      </>
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Order Details Dialog */}
      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Order Details #{selectedOrder?.id.slice(0, 8)}...
            </DialogTitle>
          </DialogHeader>
          {selectedOrder && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Order Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-sm text-muted-foreground">Order ID</Label>
                      <div className="font-mono text-sm">{selectedOrder.id}</div>
                    </div>
                    <div>
                      <Label className="text-sm text-muted-foreground">Status</Label>
                      <div>{getStatusBadge(selectedOrder.status)}</div>
                    </div>
                    <div>
                      <Label className="text-sm text-muted-foreground">Total Amount</Label>
                      <div className="font-semibold">
                        {selectedOrder.currency} {typeof selectedOrder.amount === 'number' ? selectedOrder.amount.toFixed(2) : (typeof selectedOrder.total === 'number' ? selectedOrder.total.toFixed(2) : '0.00')}
                      </div>
                    </div>
                    <div>
                      <Label className="text-sm text-muted-foreground">Created</Label>
                      <div>{selectedOrder.createdAt.toDate().toLocaleString()}</div>
                    </div>
                    {selectedOrder.updatedAt && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Last Updated</Label>
                        <div>{selectedOrder.updatedAt.toDate().toLocaleString()}</div>
                      </div>
                    )}
                    {selectedOrder.originatingModule && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Origin</Label>
                        <div>{selectedOrder.originatingModule}</div>
                      </div>
                    )}
                    {selectedOrder.eventId && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Event ID</Label>
                        <div className="font-mono text-xs">{selectedOrder.eventId}</div>
                      </div>
                    )}
                    {selectedOrder.productId && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Product ID</Label>
                        <div className="font-mono text-xs">{selectedOrder.productId}</div>
                      </div>
                    )}
                    {selectedOrder.certificateCode && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Certificate Code</Label>
                        <div className="font-mono text-xs">{selectedOrder.certificateCode}</div>
                      </div>
                    )}
                    {selectedOrder.fulfilmentNote && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Fulfilment Note</Label>
                        <div className="text-sm">{selectedOrder.fulfilmentNote}</div>
                      </div>
                    )}
                    {selectedOrder.vendorId && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Seller</Label>
                        <div className="text-sm">{vendorNames[selectedOrder.vendorId] ?? 'Vendor order'}</div>
                      </div>
                    )}
                    {selectedOrder.courierName && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Courier</Label>
                        <div className="text-sm">{selectedOrder.courierName}</div>
                      </div>
                    )}
                    {selectedOrder.trackingNumber && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Tracking number</Label>
                        <div className="text-sm font-mono">{selectedOrder.trackingNumber}</div>
                      </div>
                    )}
                    {selectedOrder.notFoundText && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Came looking for</Label>
                        <div className="text-sm">{selectedOrder.notFoundText}</div>
                      </div>
                    )}
                    {selectedOrder.groupBuyId && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Escrow</Label>
                        <div><Badge variant="outline">{selectedOrder.escrowStatus ?? 'none'}</Badge></div>
                      </div>
                    )}
                    {selectedOrder.groupBuyId && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Team</Label>
                        <div className="text-sm">
                          {teamShareCode ? (
                            <Link href={`/group-buy/${teamShareCode}`} target="_blank" className="text-primary hover:underline">
                              Open team page
                            </Link>
                          ) : (
                            <span className="font-mono text-xs">{selectedOrder.groupBuyId}</span>
                          )}
                        </div>
                      </div>
                    )}
                    {selectedOrder.payoutId && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Payout</Label>
                        <div className="text-sm">Paid out in {selectedOrder.payoutId.slice(0, 8)}</div>
                      </div>
                    )}
                    {selectedOrder.vendorId && (
                      <div className="space-y-2">
                        <Label className="text-sm text-muted-foreground">Courier and tracking (vendor relay fallback)</Label>
                        <Input
                          placeholder="Courier"
                          value={trackingDraft.courierName}
                          onChange={(e) => setTrackingDraft(d => ({ ...d, courierName: e.target.value }))}
                        />
                        <Input
                          placeholder="Tracking number"
                          value={trackingDraft.trackingNumber}
                          onChange={(e) => setTrackingDraft(d => ({ ...d, trackingNumber: e.target.value }))}
                        />
                        <Button size="sm" variant="outline" onClick={() => handleSaveTracking(selectedOrder)}>
                          Save tracking
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Customer Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-sm text-muted-foreground">Customer</Label>
                      <div className="font-semibold">{getUserName(selectedOrder)}</div>
                    </div>
                    {/* Buyer Email */}
                    {selectedOrder.buyer?.email && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Email</Label>
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4" />
                          <a href={`mailto:${selectedOrder.buyer.email}`} className="text-sm text-primary hover:underline">
                            {selectedOrder.buyer.email}
                          </a>
                        </div>
                      </div>
                    )}
                    {/* Buyer WhatsApp */}
                    {selectedOrder.buyer?.whatsappNumber && (
                      <div>
                        <Label className="text-sm text-muted-foreground">WhatsApp</Label>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4" />
                          <a href={`https://wa.me/${selectedOrder.buyer.whatsappNumber.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">
                            {selectedOrder.buyer.whatsappNumber}
                          </a>
                        </div>
                      </div>
                    )}
                    {/* Buyer Address (from buyer object) */}
                    {selectedOrder.buyer?.address && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Delivery Address</Label>
                        <div className="text-sm">{selectedOrder.buyer.address}</div>
                      </div>
                    )}
                    {/* Shipping Address (legacy) */}
                    {selectedOrder.shippingAddress && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Shipping Address</Label>
                        <div className="text-sm">
                          <div>{selectedOrder.shippingAddress.name}</div>
                          <div>{selectedOrder.shippingAddress.address}</div>
                          <div>
                            {selectedOrder.shippingAddress.city}, {selectedOrder.shippingAddress.postalCode}
                          </div>
                          <div>{selectedOrder.shippingAddress.country}</div>
                        </div>
                      </div>
                    )}
                    {selectedOrder.paymentMethod && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Payment Method</Label>
                        <div className="text-sm">{selectedOrder.paymentMethod}</div>
                      </div>
                    )}
                    {selectedOrder.paymentStatus && (
                      <div>
                        <Label className="text-sm text-muted-foreground">Payment Status</Label>
                        <Badge variant="outline" className="capitalize">
                          {selectedOrder.paymentStatus}
                        </Badge>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Order Items</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {selectedOrder.items?.map((item, index) => (
                      <div key={index} className="flex items-center justify-between p-3 border rounded">
                        <div>
                          {/* Use title OR productName - certificate orders use title */}
                          <div className="font-medium">{item.title || item.productName || 'Item'}</div>
                          {item.type && (
                            <div className="text-xs text-muted-foreground capitalize">Type: {item.type.replace(/_/g, ' ')}</div>
                          )}
                          <div className="text-sm text-muted-foreground">
                            Quantity: {item.quantity}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">
                            {selectedOrder.currency} {typeof item.subtotal === 'number' ? item.subtotal.toFixed(2) : (typeof item.price === 'number' ? item.price.toFixed(2) : (typeof selectedOrder.amount === 'number' ? selectedOrder.amount.toFixed(2) : '0.00'))}
                          </div>
                          {item.price && (
                            <div className="text-sm text-muted-foreground">
                              {selectedOrder.currency} {typeof item.price === 'number' ? item.price.toFixed(2) : '0.00'} each
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {/* If no items but we have amount, show that */}
                    {(!selectedOrder.items || selectedOrder.items.length === 0) && (
                      <div className="text-sm text-muted-foreground">
                        No specific items - Total: {selectedOrder.currency} {typeof selectedOrder.amount === 'number' ? selectedOrder.amount.toFixed(2) : (typeof selectedOrder.total === 'number' ? selectedOrder.total.toFixed(2) : '0.00')}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Buyer Notes (from buyer object) */}
              {selectedOrder.buyer?.notes && (
                <Card className="border-yellow-500/30 bg-yellow-500/5">
                  <CardHeader>
                    <CardTitle className="text-lg">📝 Buyer Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{selectedOrder.buyer.notes}</p>
                  </CardContent>
                </Card>
              )}

              {/* Order notes (internal/admin) */}
              {selectedOrder.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Admin Notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">{selectedOrder.notes}</p>
                  </CardContent>
                </Card>
              )}
              {selectedOrder.receiptUrl && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Receipt</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <a href={selectedOrder.receiptUrl} target="_blank" rel="noreferrer" className="underline text-sm">View Receipt</a>
                  </CardContent>
                </Card>
              )}

              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setIsDetailDialogOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Order Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Edit Order #{selectedOrder?.id.slice(0, 8)}...
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="status">Order Status</Label>
              <Select value={editFormData.status} onValueChange={(value) => setEditFormData(prev => ({ ...prev, status: value as any }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_STATUSES.map(status => (
                    <SelectItem key={status.value} value={status.value}>
                      {status.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="paymentStatus">Payment Status</Label>
              <Select value={editFormData.paymentStatus || 'nochange'} onValueChange={(value) => setEditFormData(prev => ({ ...prev, paymentStatus: value as any }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select payment status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nochange">No change</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="refunded">Refunded</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={editFormData.notes || ""}
                onChange={(e) => setEditFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Add order notes..."
                rows={3}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleOrderUpdate} disabled={saving}>
                {saving ? "Saving..." : "Update Order"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
