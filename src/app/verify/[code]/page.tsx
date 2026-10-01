"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import { ShieldCheck, Share2, Download, Link as LinkIcon } from "lucide-react";
import { useUser } from "@/firebase";
import { firestore, useStorage } from "@/firebase";
import { doc, getDoc, collection, serverTimestamp } from 'firebase/firestore';
;
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { addDoc, updateDoc } from '@/lib/client/firestore-wrapper';

type VerifyResponse = {
  isValid: boolean;
  holder?: { name: string; profileUrl: string };
  holderUserId?: string;
  achievementTitle?: string;
  issuedDate?: string | null;
  expiresDate?: string | null;
  issuingAuthority?: string;
  certificateCode?: string;
  visualTemplateUrl?: string;
  error?: string;
};

export default function CertificateVerificationPage() {
  const params = useParams();
  const code = String(params?.code || "");

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<VerifyResponse | null>(null);
  const { user } = useUser();
  const [product, setProduct] = useState<any | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const storage = useStorage();

  // Client-side verification: call the backend API endpoint
  useEffect(() => {
    const run = async () => {
      if (!code) return;
      try {
        setLoading(true);
        const res = await fetch(`/api/v1/certificates/verify/${encodeURIComponent(code)}`);
        
        if (!res.ok) {
          setData({ isValid: false, error: 'Failed to verify certificate' });
          return;
        }

        const data: VerifyResponse = await res.json();
        setData(data);
      } catch (e: any) {
        setData({ isValid: false, error: e?.message || "Verification failed" });
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [code]);

  // Load product settings to check if purchase is enabled (Centralized Store)
  useEffect(() => {
    const loadProduct = async () => {
      try {
        const sRef = doc(firestore, "products", "certificate-print");
        const sSnap = await getDoc(sRef);
        if (sSnap.exists()) {
          const p = sSnap.data();
          setProduct({
            id: sSnap.id,
            isEnabled: p.isActive,
            price: p.price,
            currency: p.currency,
            bundleDescription: p.description,
            productImageUrl: p.imageUrl,
            ...p
          });
        }
      } catch {
        // Silent failure: purchase section won't render
      }
    };
    loadProduct();
  }, []);

  const pageUrl = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);

  const handleShare = (platform: "linkedin" | "twitter" | "copy") => {
    const text = data?.achievementTitle ? `Verified: ${data.achievementTitle}` : `Verified Certificate`;
    const url = encodeURIComponent(pageUrl);
    const msg = encodeURIComponent(text);
    if (platform === "linkedin") {
      window.open(`https://www.linkedin.com/shareArticle?mini=true&url=${url}&title=${msg}`, "_blank");
    } else if (platform === "twitter") {
      window.open(`https://twitter.com/intent/tweet?url=${url}&text=${msg}`, "_blank");
    } else {
      navigator.clipboard?.writeText(pageUrl).catch(() => { });
    }
  };

  const handleDownload = () => {
    // Simple, reliable option: use print dialog for PDF export
    window.print();
  };

  const issued = data?.issuedDate ? new Date(data.issuedDate) : null;
  const expires = data?.expiresDate ? new Date(data.expiresDate) : null;

  return (
    <div className="min-h-[60vh] w-full px-4 md:px-6 py-10 bg-gradient-to-b from-background to-background/60">
      <div className="max-w-3xl mx-auto">
        <Card className="bg-card/80 backdrop-blur-md border-primary/30 shadow-lg">
          <CardHeader className="space-y-2 text-center">
            <div className="mx-auto w-16 h-16 relative">
              <Image src="/assets/logo.png" alt="Organization Logo" fill sizes="(max-width: 768px) 100vw, 300px" className="object-contain" />
            </div>
            <CardTitle className="font-heading text-2xl md:text-3xl">Certificate Verification</CardTitle>
            <CardDescription className="font-body">Code: <span className="font-mono">{code}</span></CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-muted-foreground">Verifying…</p>
            ) : data?.isValid ? (
              <div className="space-y-6">
                <div className="flex items-center gap-2 text-green-600 dark:text-green-500">
                  <ShieldCheck className="w-5 h-5" />
                  <span className="font-semibold">Verified Certificate</span>
                </div>

                {/* Visual preview */}
                {data?.visualTemplateUrl ? (
                  <div className="rounded-md overflow-hidden border border-muted">
                    <Image src={data.visualTemplateUrl} alt="Certificate Preview" width={1200} height={675} className="w-full h-auto" />
                  </div>
                ) : null}

                {/* Holder and details */}
                <div className="space-y-2">
                  <p className="font-serif text-xl">
                    Holder: {data?.holder?.profileUrl ? (
                      <a href={data.holder.profileUrl} className="underline underline-offset-4 hover:text-primary">{data?.holder?.name || '—'}</a>
                    ) : (
                      <span className="font-semibold">{data?.holder?.name || '—'}</span>
                    )}
                  </p>
                  <p className="font-body">
                    Achievement: <span className="font-semibold">{data?.achievementTitle || '—'}</span>
                  </p>
                  <p className="font-body">
                    Issuing Authority: <span className="font-semibold">{data?.issuingAuthority || '—'}</span>
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <p className="font-body">Issued: <span className="font-semibold">{issued ? issued.toLocaleDateString() : '—'}</span></p>
                    <p className="font-body">Expires: <span className="font-semibold">{expires ? expires.toLocaleDateString() : '—'}</span></p>
                  </div>
                </div>

                {/* Conditional Purchase Section - Redirects to Unified Store */}
                {product?.isEnabled && user?.uid && data?.holderUserId && user.uid === data.holderUserId ? (
                  <div className="mt-8 border rounded-lg p-4 bg-muted/30 border-primary/20">
                    <h3 className="text-xl font-heading mb-2">Purchase Printed Certificate</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
                      <div className="md:col-span-1">
                        {product?.productImageUrl ? (
                          <div className="aspect-video relative rounded-md overflow-hidden border border-white/10">
                            <Image
                              src={product.productImageUrl}
                              alt="Certificate Product"
                              fill
                              sizes="(max-width: 768px) 100vw, 300px"
                              className="object-cover"
                            />
                          </div>
                        ) : null}
                      </div>
                      <div className="md:col-span-2 space-y-2">
                        <p className="font-body text-sm text-muted-foreground">{product?.bundleDescription}</p>
                        <p className="font-body font-semibold text-lg">{product?.price} {product?.currency}</p>
                        <div>
                          <Button
                            className="w-full bg-primary hover:bg-primary/90 text-white font-bold h-12 rounded-lg shadow-lg hover:scale-[1.02] transition-transform"
                            onClick={() => {
                              const checkoutUrl = `/checkout?productId=${product.id}&certCode=${code}&type=product&origin=certificate_verify`;
                              window.location.href = checkoutUrl;
                            }}
                          >
                            Proceed to Purchase
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <Button variant="default" onClick={() => handleShare("linkedin")}>
                    <Share2 className="w-4 h-4 mr-2" /> Share
                  </Button>
                  <Button variant="outline" onClick={() => handleShare("twitter")}>
                    <Share2 className="w-4 h-4 mr-2" /> Tweet
                  </Button>
                  <Button variant="ghost" onClick={() => handleShare("copy")}>
                    <LinkIcon className="w-4 h-4 mr-2" /> Copy Link
                  </Button>
                  <div className="flex-1" />
                  <Button variant="secondary" onClick={handleDownload}>
                    <Download className="w-4 h-4 mr-2" /> Download as PDF
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="font-body text-destructive">Certificate Invalid</p>
                <p className="text-sm text-muted-foreground">No certificate was found for the provided code. Please check and try again.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
