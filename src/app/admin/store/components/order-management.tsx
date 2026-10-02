"use client";

import { useEffect, useState, useCallback } from "react";
import { useUser } from "@/firebase";
import { firestore } from "@/firebase";
import {
  collection, getDocs, doc, query, orderBy, limit, startAfter, Timestamp, where, onSnapshot, QueryDocumentSnapshot, DocumentData, serverTimestamp, arrayUnion } from 'firebase/firestore';
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
import { updateDoc, setDoc } from '@/lib/client/firestore-wrapper';

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
} from "lucide-react";

// Minimal user summary loaded from the users collection for name/email lookups.
interface StoreUserSummary {
  id: string;
  displayName?: string;
  email?: string;
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
  { value: 'processing', label: 'Processing', color: 'bg-blue-100 text-blue-800' },
  { value: 'shipped', label: 'Shipped', color: 'bg-purple-100 text-purple-800' },
  { value: 'delivered', label: 'Delivered', color: 'bg-green-100 text-green-800' },
  { value: 'cancelled', label: 'Cancelled', color: 'bg-red-100 text-red-800' }
];

export function OrderManagement() {
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

  // Load users for relationship management
  const loadUsers = useCallback(async () => {
    try {
      const usersRef = collection(firestore, "users");
      const usersQuery = query(usersRef, limit(1000));
      const usersSnap = await getDocs(usersQuery);
      const usersData = usersSnap.docs.map(doc => ({
        id: doc.id,
        displayName: doc.data().displayName,
        email: doc.data().email,
        firstName: doc.data().firstName,
        lastName: doc.data().lastName
      }));
      setUsers(usersData);
    } catch (error) {
      console.error("Error loading users:", error);
    }
  }, []);

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
      const ordersData = ordersSnap.docs.map(doc => ({
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
              userEmail = user.email || '';
            }
          }

          // Fallback to userId (event orders)
          if (!userName && order.userId) {
            const user = users.find(u => u.id === order.userId);
            if (user) {
              userName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
              userEmail = user.email || '';
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

  // ── Real-time listener for first page (no pagination) ─────────────────────
  // This ensures that when admin verifies payment or issues ticket, the card
  // updates instantly without needing to manually refresh the page.
  useEffect(() => {
    const ordersRef = collection(firestore, "orders");
    const q = query(ordersRef, orderBy("createdAt", "desc"), limit(ITEMS_PER_PAGE));
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as Order[];
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
          updates: {
            status: newStatus,
            paymentStatus: newStatus === 'shipped' || newStatus === 'delivered' ? 'completed' : order.paymentStatus
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
      if (payload.paymentStatus === 'nochange') {
        delete payload.paymentStatus;
      }

      // 1. Support direct 'verified' transition for event tickets and certificates
      if (payload.paymentStatus === 'completed' && payload.status === 'pending_verification') {
        payload.status = 'verified'; // auto-verify if they manually marked payment complete while pending
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

  const handleDeleteOrder = async (orderId: string) => {
    if (!user) return;
    setDeletingIds(p => [...p, orderId]);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/store/orders?orderId=${encodeURIComponent(orderId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      toast({ title: '🗑️ Order deleted', description: `Order ${orderId.slice(0, 8)}... permanently wiped.` });
      // Remove from local state immediately (real-time listener will also reflect this)
      setOrders(prev => prev.filter(o => o.id !== orderId));
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Delete failed', description: e.message });
    } finally {
      setDeletingIds(p => p.filter(id => id !== orderId));
    }
  };

  const viewOrderDetails = (order: Order) => {
    setSelectedOrder(order);
    setEditFormData({
      status: order.status,
      paymentStatus: order.paymentStatus,
      notes: order.notes
    });
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
        return name || user.displayName || user.email || "Unknown User";
      }
    }

    // Fallback to userId (event orders)
    if (order.userId) {
      const user = users.find(u => u.id === order.userId);
      if (user) {
        const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        return name || user.displayName || user.email || "Unknown User";
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
                Total: {orders.length} orders
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
          </div>

          {/* Orders List */}
          {loading && orders.length === 0 ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
              <p>Loading orders...</p>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {orders.map((order) => (
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
                                <AlertDialogTitle>Permanently Delete Order?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will <strong>permanently wipe</strong> order{' '}
                                  <code className="font-mono text-xs">{order.id.slice(0, 12)}…</code> from Firestore.
                                  This action <strong>cannot be undone</strong>.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-red-600 hover:bg-red-700 text-white"
                                  onClick={() => handleDeleteOrder(order.id)}
                                >
                                  Yes, Delete Permanently
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
                                  disabled={approvingIds.includes(order.id)}
                                  onClick={async () => {
                                    setApprovingIds(p => [...p, order.id]);
                                    try {
                                      // ── Step 1: Mark the store order as completed ──
                                      await updateDoc(doc(firestore, 'orders', order.id), {
                                        paymentStatus: 'completed',
                                        status: 'delivered',
                                        updatedAt: serverTimestamp(),
                                      });
                                      // ── Step 2: Update the event registration ──
                                      // CRITICAL FIX: Registration docs are keyed by userId (uid),
                                      // NOT by orderId. The ticket issue API looks up registrations/{uid}.
                                      const regUid = order.userId || order.buyerUserId;
                                      if (order.eventId && regUid) {
                                        const regRef = doc(firestore, 'events', order.eventId, 'registrations', regUid);
                                        // setDoc+merge works even if the doc doesn't exist yet
                                        await setDoc(regRef, {
                                          paymentStatus: 'verified',
                                          status: 'confirmed',
                                          uid: regUid,
                                          orderId: order.id,
                                          eventId: order.eventId,
                                          displayName: order.buyer?.fullName || (order.buyer as any)?.name || '',
                                          email: order.buyer?.email || '',
                                          whatsappE164: (order.buyer as any)?.phone || (order.buyer as any)?.whatsappNumber || '',
                                          paymentMethod: order.paymentMethod || 'bank_transfer',
                                          updatedAt: serverTimestamp(),
                                        }, { merge: true });
                                      }
                                      toast({ title: '✅ Payment verified & seat confirmed!' });
                                      setCurrentPage(0); setLastDoc(null); loadOrders(true);
                                    } catch (e: any) {
                                      toast({ variant: 'destructive', title: 'Failed', description: e.message });
                                    } finally {
                                      setApprovingIds(p => p.filter(id => id !== order.id));
                                    }
                                  }}
                                >
                                  <CheckCircle className="h-3.5 w-3.5 mr-1" /> Verify Payment & Confirm Seat
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

                          {/* Generic Quick Status Updates for non-event orders */}
                          {!order.eventId && (
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
