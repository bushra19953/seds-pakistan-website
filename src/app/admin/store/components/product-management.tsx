"use client";

import { useEffect, useState, useCallback } from "react";
import { useUser } from "@/firebase";
import { firestore } from "@/firebase";
import {
  collection, getDocs, doc, query, orderBy, limit, Timestamp, where } from 'firebase/firestore';
;
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Package, Search, Edit, CheckCircle, XCircle, Plus, Trash2, Save, Loader2, Link2, ExternalLink } from "lucide-react";
import { addDoc, updateDoc, deleteDoc } from '@/lib/client/firestore-wrapper';

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  stock: number;
  category: string;
  eventId?: string;
  formId?: string;
  isActive: boolean;
  imageUrl?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdBy: string;
}

interface Event {
  id: string;
  title: string;
}

interface Form {
  id: string;
  title: string;
}

const CATEGORIES = ["certificate", "merchandise", "workshop", "event_ticket", "digital_content", "other"];

export function ProductManagement() {
  const { user } = useUser();
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [forms, setForms] = useState<Form[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [formData, setFormData] = useState<Partial<Product>>({
    name: "", description: "", price: 0, currency: "PKR", stock: 999, category: "other", isActive: true
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Use API to load products - bypasses Firestore client permission issues
      if (user) {
        const idToken = await user.getIdToken(true);
        const res = await fetch('/api/store/products', {
          headers: { 'Authorization': `Bearer ${idToken}` }
        });

        if (res.ok) {
          const data = await res.json();
          if (data.products) {
            setProducts(data.products.sort((a: any, b: any) =>
              new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
            ));
          }
        } else {
          const errorData = await res.json().catch(() => ({}));
          console.error("Products API error:", errorData);
          // Don't throw - allow page to load without products
        }
      }

      // Load events for linking (wrapped in try-catch to handle permission issues)
      try {
        const eventsSnap = await getDocs(query(collection(firestore, "events"), where("status", "==", "published"), limit(100)));
        setEvents(eventsSnap.docs.map(d => ({ id: d.id, title: d.data().title || "Untitled" })));
      } catch (eventsError) {
        console.warn("Could not load events for linking:", eventsError);
        setEvents([]); // Continue without events
      }

      // Load forms for linking (wrapped in try-catch to handle permission issues)
      try {
        const formsSnap = await getDocs(collection(firestore, "forms"));
        setForms(formsSnap.docs.map(d => ({ id: d.id, title: d.data().title || "Untitled" })));
      } catch (formsError) {
        console.warn("Could not load forms for linking:", formsError);
        setForms([]); // Continue without forms
      }
    } catch (error) {
      console.error("Store Data Loading Error:", error);
      toast({ variant: "destructive", title: "Error loading data", description: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  }, [toast, user]);

  useEffect(() => { loadData(); }, [loadData]);

  const openCreateDialog = () => {
    setEditingProduct(null);
    setFormData({ name: "", description: "", price: 0, currency: "PKR", stock: 999, category: "other", isActive: true });
    setIsDialogOpen(true);
  };

  const openEditDialog = (product: Product) => {
    setEditingProduct(product);
    setFormData(product);
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    if (!user || !formData.name || !formData.description) {
      toast({ variant: "destructive", title: "Name and description are required" });
      return;
    }
    setSaving(true);
    try {
      const idToken = await user.getIdToken(true);

      if (editingProduct) {
        // Update existing product via API
        const res = await fetch('/api/store/products', {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ productId: editingProduct.id, updates: formData })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Update failed');
        }
        toast({ title: "Product updated" });
      } else {
        // Create new product via API
        const res = await fetch('/api/store/products', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Create failed');
        }
        toast({ title: "Product created" });
      }
      setIsDialogOpen(false);
      loadData();
    } catch (error) {
      console.error("Save error:", error);
      toast({ variant: "destructive", title: "Save failed", description: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (product: Product) => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken(true);
      const res = await fetch(`/api/store/products?productId=${product.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }
      toast({ title: "Product deleted" });
      loadData();
    } catch (error) {
      console.error("Delete error:", error);
      toast({ variant: "destructive", title: "Delete failed" });
    }
  };

  const handleToggleActive = async (product: Product) => {
    try {
      await updateDoc(doc(firestore, "products", product.id), { isActive: !product.isActive, updatedAt: Timestamp.now() });
      toast({ title: product.isActive ? "Product deactivated" : "Product activated" });
      loadData();
    } catch (error) {
      toast({ variant: "destructive", title: "Update failed" });
    }
  };

  const filteredProducts = products.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return <div className="flex justify-center p-8"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> Product Management</CardTitle>
              <CardDescription>Manage products, fees, and digital items</CardDescription>
            </div>
            <Button onClick={openCreateDialog}><Plus className="h-4 w-4 mr-2" /> Add Product</Button>
          </div>
          {/* Help text explaining where products are used */}
          <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-sm">
            <p className="font-medium text-blue-400 mb-1">📍 Where Products Appear:</p>
            <ul className="text-muted-foreground text-xs space-y-1 list-disc list-inside">
              <li><strong>Chapter Registration Fee</strong> → <code>/register-chapter</code> checkout flow</li>
              <li><strong>Certificate Purchase</strong> → <code>/verify/[code]</code> page (Settings tab controls)</li>
              <li><strong>Event Tickets</strong> → Link products to events for paid registration</li>
              <li className="text-yellow-400">⚠️ No public &quot;store&quot; page exists yet - products are only used in specific flows above.</li>
            </ul>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search products..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="max-w-sm" />
            <Badge variant="outline">{filteredProducts.length} products</Badge>
          </div>

          <div className="space-y-3">
            {filteredProducts.map((product) => (
              <Card key={product.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-lg">{product.name}</h3>
                      <Badge variant={product.isActive ? "default" : "secondary"} className={product.isActive ? "bg-green-500/10 text-green-500 border-green-500/20" : ""}>
                        {product.isActive ? "Active" : "Inactive"}
                      </Badge>
                      <Badge variant="outline" className="capitalize bg-primary/5 border-primary/20 text-primary">
                        {product.category.replace("_", " ")}
                      </Badge>
                      {product.category === 'event_ticket' && (
                        <Badge variant="secondary" className="bg-orange-500/10 text-orange-500 border-orange-500/20 flex items-center gap-1">
                          <Link2 className="h-3 w-3" /> Event Linked
                        </Badge>
                      )}
                      {product.id === 'chapter-fee' && (
                        <Badge variant="secondary" className="bg-indigo-500/10 text-indigo-400 border-indigo-500/20 flex items-center gap-1">
                          <Link2 className="h-3 w-3" /> System Fee
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-1">{product.description}</p>
                    <div className="flex gap-4 mt-2 text-sm">
                      <span><strong>Price:</strong> {product.currency} {product.price?.toLocaleString()}</span>
                      <span><strong>Stock:</strong> {product.stock}</span>
                      {product.formId && <span><strong>Form:</strong> {forms.find(f => f.id === product.formId)?.title || "Linked"}</span>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEditDialog(product)}><Edit className="h-4 w-4" /></Button>
                    <Button variant="outline" size="sm" onClick={() => handleToggleActive(product)}>
                      {product.isActive ? <XCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="text-red-600"><Trash2 className="h-4 w-4" /></Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete &quot;{product.name}&quot;?</AlertDialogTitle>
                          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(product)} className="bg-red-600">Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </Card>
            ))}
            {filteredProducts.length === 0 && <p className="text-center text-muted-foreground py-8">No products found.</p>}
          </div>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingProduct ? "Edit Product" : "Create Product"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name *</Label>
                <Input value={formData.name || ""} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div>
                <Label>Category</Label>
                <Select value={formData.category || "other"} onValueChange={(v) => setFormData({ ...formData, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c.replace("_", " ").toUpperCase()}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Description *</Label>
              <Textarea value={formData.description || ""} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>Price</Label>
                <Input type="number" value={formData.price || 0} onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={formData.currency || "PKR"} onValueChange={(v) => setFormData({ ...formData, currency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PKR">PKR</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Stock</Label>
                <Input type="number" value={formData.stock || 0} onChange={(e) => setFormData({ ...formData, stock: parseInt(e.target.value) || 0 })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Link to Event (Optional)</Label>
                <Select value={formData.eventId || "none"} onValueChange={(v) => setFormData({ ...formData, eventId: v === "none" ? undefined : v })}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {events.map(e => <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Custom Form (Optional)</Label>
                <Select value={formData.formId || "none"} onValueChange={(v) => setFormData({ ...formData, formId: v === "none" ? undefined : v })}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {forms.map(f => <SelectItem key={f.id} value={f.id}>{f.title}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Ask custom questions at checkout</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="isActive" checked={formData.isActive ?? true} onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })} />
              <Label htmlFor="isActive">Product is active</Label>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                {editingProduct ? "Save Changes" : "Create Product"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
