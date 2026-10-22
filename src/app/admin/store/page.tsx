"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Package, ShoppingCart, Settings, Shield } from "lucide-react";
import { CertificateProductSettings } from "./components/certificate-settings";
import { ProductManagement } from "./components/product-management";
import { OrderManagement } from "./components/order-management";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

const STORE_TABS = ["products", "orders", "settings"] as const;
type StoreTab = (typeof STORE_TABS)[number];

function StorePageInner() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const paramTab: StoreTab = (STORE_TABS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as StoreTab)
    : "products";
  const [activeTab, setActiveTab] = useState<StoreTab>(paramTab);
  // Deep links (e.g. the retired /admin/orders redirect) select the tab via
  // ?tab=orders; keep the tab in sync if the param changes while mounted.
  useEffect(() => {
    setActiveTab(paramTab);
  }, [paramTab]);
  const initialOrderView = searchParams.get("view") === "certificates" ? "certificates" : undefined;

  return (
    <div className="container px-4 md:px-6 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Shield className="h-8 w-8 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Store Central Command</h1>
        </div>
        <p className="text-muted-foreground">
          The single source of truth for ALL organization transactions: Events, Chapters, Certificates, and Donations.
        </p>
        <Alert className="mt-4 border-primary/20 bg-primary/5 shadow-sm">
          <AlertTriangle className="h-4 w-4 text-primary" />
          <AlertDescription className="text-primary font-medium">
            <strong>Security Notice:</strong> All price changes and transaction status updates are logged for financial auditing.
          </AlertDescription>
        </Alert>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as StoreTab)} className="space-y-6">
        <TabsList className="grid w-full grid-cols-3 h-14 p-1 bg-card/50 border border-white/5 rounded-xl">
          <TabsTrigger value="products" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <Package className="h-5 w-5" />
            <span className="font-bold">Inventory & Fees</span>
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <ShoppingCart className="h-5 w-5" />
            <span className="font-bold">Store Orders</span>
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <Settings className="h-5 w-5" />
            <span className="font-bold">Store Settings</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="space-y-6">
          <ProductManagement />
        </TabsContent>

        <TabsContent value="orders" className="space-y-6">
          <OrderManagement initialView={initialOrderView} />
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <CertificateProductSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AdminStorePage() {
  return (
    <AuthorizationGate permission="canManageStore">
      <Suspense fallback={null}>
        <StorePageInner />
      </Suspense>
    </AuthorizationGate>
  );
}
