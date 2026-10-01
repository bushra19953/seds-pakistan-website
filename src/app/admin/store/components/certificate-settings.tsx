"use client";

import { useEffect, useState } from "react";
import { useUser } from "@/firebase";
import { firestore } from "@/firebase";
import { doc, getDoc } from 'firebase/firestore';
;
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { setDoc } from '@/lib/client/firestore-wrapper';


type CertificateProductSettings = {
  isEnabled: boolean;
  price: string;
  currency: string;
  productImageUrl: string;
  bundleDescription: string;
  paymentInstructions: string;
};

const DEFAULTS: CertificateProductSettings = {
  isEnabled: false,
  price: "14.99",
  currency: "USD",
  productImageUrl: "",
  bundleDescription:
    "Includes a high-quality printed certificate, a digital photo pack, and a sticker.",
  paymentInstructions:
    "Please pay via SadaPay to our account 'seds-pakistan'. Use your certificate code as the reference. Email a screenshot of your receipt to orders@sedspakistan.com to complete your order.",
};

export function CertificateProductSettings() {
  const { user } = useUser();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<CertificateProductSettings>(DEFAULTS);
  
  type PaymentMethod = {
    enabled: boolean;
    name: string;
    instructions: string;
    iconUrl?: string;
  };

  type PaymentMethodsSettings = {
    methods: Record<string, PaymentMethod>;
    order: string[];
    testMode: boolean;
  };

  const DEFAULT_METHODS_SETTINGS: PaymentMethodsSettings = {
    methods: {
      raast: {
        enabled: true,
        name: "Raast Transfer",
        instructions: "Scan the Raast QR or transfer to our IBAN. Include your Order ID in the transfer remarks.",
        iconUrl: "/assets/payments/raast.png",
      },
      easypaisa: {
        enabled: true,
        name: "Easypaisa QR",
        instructions: "Scan the Easypaisa QR or send to our wallet number. Add your Order ID in the note.",
        iconUrl: "/assets/payments/easypaisa.png",
      },
      sadapay: {
        enabled: true,
        name: "SadaPay Transfer",
        instructions: "Send via Raast to our SadaPay IBAN. Add your Order ID in the transfer remarks.",
        iconUrl: "/assets/payments/sadapay.png",
      },
    },
    order: ["raast", "easypaisa", "sadapay"],
    testMode: true,
  };

  const [methodSettings, setMethodSettings] = useState<PaymentMethodsSettings>(DEFAULT_METHODS_SETTINGS);
  const [loadingMethods, setLoadingMethods] = useState(true);
  const [savingMethods, setSavingMethods] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const ref = doc(firestore, "settings", "certificate_product");
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data() as Partial<CertificateProductSettings>;
          setSettings({ ...DEFAULTS, ...data });
        } else {
          setSettings(DEFAULTS);
        }
      } catch (e: any) {
        toast({
          variant: "destructive",
          title: "Failed to load settings",
          description: e?.message || "Please try again.",
        });
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [toast]);

  // Load payment methods configuration
  useEffect(() => {
    const loadMethods = async () => {
      try {
        setLoadingMethods(true);
        const ref = doc(firestore, "settings", "payment_methods");
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data() as Partial<PaymentMethodsSettings>;
          const merged: PaymentMethodsSettings = {
            ...DEFAULT_METHODS_SETTINGS,
            ...data,
            methods: { ...DEFAULT_METHODS_SETTINGS.methods, ...(data.methods || {}) },
            order: data.order || DEFAULT_METHODS_SETTINGS.order,
            testMode: data.testMode ?? DEFAULT_METHODS_SETTINGS.testMode,
          };
          setMethodSettings(merged);
        } else {
          setMethodSettings(DEFAULT_METHODS_SETTINGS);
        }
      } catch (e: any) {
        toast({ variant: "destructive", title: "Failed to load payment methods", description: e?.message || "Please try again." });
      } finally {
        setLoadingMethods(false);
      }
    };
    loadMethods();
  }, [toast]);

  const validateSettings = (settings: CertificateProductSettings): string[] => {
    const errors: string[] = [];
    
    if (!settings.price || isNaN(Number(settings.price)) || Number(settings.price) <= 0) {
      errors.push("Price must be a valid positive number");
    }
    
    if (!settings.currency || settings.currency.length !== 3) {
      errors.push("Currency must be a 3-letter code (e.g., USD, PKR)");
    }
    
    if (settings.productImageUrl && !settings.productImageUrl.startsWith('http')) {
      errors.push("Product image URL must be a valid HTTP/HTTPS URL");
    }
    
    if (!settings.bundleDescription || settings.bundleDescription.length < 10) {
      errors.push("Bundle description must be at least 10 characters long");
    }
    
    if (!settings.paymentInstructions || settings.paymentInstructions.length < 10) {
      errors.push("Payment instructions must be at least 10 characters long");
    }
    
    return errors;
  };

  const save = async () => {
    try {
      if (!user) throw new Error("Not authenticated");
      
      const validationErrors = validateSettings(settings);
      if (validationErrors.length > 0) {
        toast({
          variant: "destructive",
          title: "Validation Error",
          description: validationErrors.join(", "),
        });
        return;
      }
      
      setSaving(true);
      const ref = doc(firestore, "settings", "certificate_product");
      await setDoc(ref, settings, { merge: true });
      toast({ title: "Settings Saved", description: "Certificate product updated successfully." });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e?.message || "Please try again." });
    } finally {
      setSaving(false);
    }
  };

  const onField = (key: keyof CertificateProductSettings, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const onMethodField = (methodKey: string, key: keyof PaymentMethod, value: any) => {
    setMethodSettings((prev) => ({
      ...prev,
      methods: {
        ...prev.methods,
        [methodKey]: { ...prev.methods[methodKey], [key]: value },
      },
    }));
  };

  const moveMethod = (methodKey: string, direction: "up" | "down") => {
    setMethodSettings((prev) => {
      const order = [...prev.order];
      const idx = order.indexOf(methodKey);
      if (idx === -1) return prev;
      if (direction === "up" && idx > 0) {
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      } else if (direction === "down" && idx < order.length - 1) {
        [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
      }
      return { ...prev, order };
    });
  };

  const saveMethods = async () => {
    try {
      if (!user) throw new Error("Not authenticated");
      setSavingMethods(true);
      const ref = doc(firestore, "settings", "payment_methods");
      await setDoc(ref, methodSettings, { merge: true });
      toast({ title: "Payment methods saved", description: "Configuration updated successfully." });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e?.message || "Please try again." });
    } finally {
      setSavingMethods(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
        <p>Loading certificate settings...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle className="font-heading">Certificate Product</CardTitle>
          <CardDescription className="font-body">
            Configure availability, pricing, visuals, and purchase instructions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between py-2">
            <Label htmlFor="enabled">Enable Purchase Feature</Label>
            <Switch id="enabled" checked={settings.isEnabled} onCheckedChange={(v) => onField("isEnabled", v)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="price">Price *</Label>
              <Input 
                id="price" 
                value={settings.price} 
                onChange={(e) => onField("price", e.target.value)}
                placeholder="14.99"
                type="number"
                step="0.01"
                min="0"
              />
            </div>
            <div>
              <Label htmlFor="currency">Currency *</Label>
              <Input 
                id="currency" 
                value={settings.currency} 
                onChange={(e) => onField("currency", e.target.value.toUpperCase())}
                placeholder="USD"
                maxLength={3}
              />
            </div>
            <div className="md:col-span-1">
              <Label htmlFor="image">Product Image URL</Label>
              <Input 
                id="image" 
                value={settings.productImageUrl} 
                onChange={(e) => onField("productImageUrl", e.target.value)}
                placeholder="https://..."
                type="url"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="bundle">Bundle Description *</Label>
            <Textarea 
              id="bundle" 
              value={settings.bundleDescription} 
              onChange={(e) => onField("bundleDescription", e.target.value)}
              placeholder="Describe what customers receive..."
              rows={3}
            />
          </div>

          <div>
            <Label htmlFor="instructions">Payment Instructions *</Label>
            <Textarea 
              id="instructions" 
              value={settings.paymentInstructions} 
              onChange={(e) => onField("paymentInstructions", e.target.value)}
              placeholder="Provide clear payment instructions..."
              rows={4}
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving} className="min-w-32">
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Payment Methods Configuration */}
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle className="font-heading">Payment Methods</CardTitle>
          <CardDescription className="font-body">
            Configure manual payment methods with enable toggles and display order.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loadingMethods ? (
            <div className="text-center py-4">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary mx-auto mb-2"></div>
              <p>Loading payment methods...</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between py-2">
                <Label htmlFor="testMode">Test Mode</Label>
                <Switch 
                  id="testMode" 
                  checked={methodSettings.testMode} 
                  onCheckedChange={(v) => setMethodSettings((prev) => ({ ...prev, testMode: v }))} 
                />
              </div>

              <div className="space-y-4">
                {methodSettings.order.map((key) => {
                  const cfg = methodSettings.methods[key];
                  if (!cfg) return null;
                  return (
                    <div key={key} className="rounded-md border p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-semibold">{cfg.name}</h3>
                          <p className="text-xs text-muted-foreground">Key: {key}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="secondary" size="sm" onClick={() => moveMethod(key, "up")}>
                            Move Up
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => moveMethod(key, "down")}>
                            Move Down
                          </Button>
                          <div className="flex items-center gap-2">
                            <Label className="text-sm">Enabled</Label>
                            <Switch checked={!!cfg.enabled} onCheckedChange={(v) => onMethodField(key, "enabled", v)} />
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="md:col-span-1">
                          <Label>Method Name</Label>
                          <Input value={cfg.name} onChange={(e) => onMethodField(key, "name", e.target.value)} />
                        </div>
                        <div className="md:col-span-2">
                          <Label>Icon/Logo URL</Label>
                          <Input value={cfg.iconUrl || ""} onChange={(e) => onMethodField(key, "iconUrl", e.target.value)} placeholder="https://..." />
                        </div>
                        <div className="md:col-span-3">
                          <Label>Instructions</Label>
                          <Textarea rows={3} value={cfg.instructions} onChange={(e) => onMethodField(key, "instructions", e.target.value)} placeholder="Account details and steps" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-end">
                <Button onClick={saveMethods} disabled={savingMethods} className="min-w-40">
                  {savingMethods ? "Saving..." : "Save Payment Methods"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}