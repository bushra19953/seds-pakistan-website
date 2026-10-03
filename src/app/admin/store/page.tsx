"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Package, ShoppingCart, Settings, Shield } from "lucide-react";
import { CertificateProductSettings } from "./components/certificate-settings";
import { ProductManagement } from "./components/product-management";
import { OrderManagement } from "./components/order-management";
import AuthorizationGate from "@/components/admin/AuthorizationGate";

export default function AdminStorePage() {
  return (
    <AuthorizationGate permission="canManageStore">
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

      <Tabs defaultValue="products" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3 h-14 p-1 bg-card/50 border border-white/5 rounded-xl">
          <TabsTrigger value="products" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <Package className="h-5 w-5" />
            <span className="font-bold">Inventory & Fees</span>
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-foreground">
            <ShoppingCart className="h-5 w-5" />
            <span className="font-bold">Transaction History</span>
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
          <OrderManagement />
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <CertificateProductSettings />
        </TabsContent>
      </Tabs>
      </div>
    </AuthorizationGate>
  );
}

