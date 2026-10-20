'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trophy, ExternalLink, Download, Linkedin, Share2, Loader2 } from 'lucide-react';
import { useUser } from '@/firebase';
import {
  buildLinkedInAddToProfileUrl,
  buildLinkedInShareUrl,
} from '@/lib/profile-hub/telemetry';

type VaultCertificate = ReturnType<
  typeof import('@/lib/profile-hub/telemetry').sanitizeCertificateForVault
>;

function fmtDate(iso: string | null): string {
  if (!iso) return 'Unknown';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown';
  }
}

function CertificateCard({ cert, uid }: { cert: VaultCertificate; uid: string }) {
  const { user } = useUser();
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issued = cert.status !== 'revoked';
  const base =
    typeof window !== 'undefined' ? window.location.origin : '';
  const absoluteVerifyUrl = cert.verificationUrl
    ? cert.verificationUrl.startsWith('http')
      ? cert.verificationUrl
      : `${base}${cert.verificationUrl}`
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!issued || !cert.code || !user) return;
    (async () => {
      try {
        setQrLoading(true);
        const token = await user.getIdToken(false);
        const res = await fetch(
          `/api/profile/${uid}/credential-qr?code=${encodeURIComponent(cert.code)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error('QR failed');
        const data = await res.json();
        if (!cancelled) setQrUrl(data.dataUrl || null);
      } catch {
        if (!cancelled) setQrUrl(null);
      } finally {
        if (!cancelled) setQrLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cert.code, issued, uid, user]);

  const handleDownloadPdf = async () => {
    if (!user) return;
    try {
      setDownloading(true);
      setError(null);
      const token = await user.getIdToken(true);
      const res = await fetch(
        `/api/profile/${uid}/credential-pdf?code=${encodeURIComponent(cert.code)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `seds-certificate-${cert.code}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download the PDF sheet. Try again.');
    } finally {
      setDownloading(false);
    }
  };

  const handleLinkedInShare = () => {
    if (!absoluteVerifyUrl) return;
    window.open(buildLinkedInShareUrl(absoluteVerifyUrl, cert.title), '_blank', 'noopener');
  };

  const handleLinkedInAdd = () => {
    if (!absoluteVerifyUrl) return;
    window.open(
      buildLinkedInAddToProfileUrl({
        title: cert.title,
        verificationUrl: absoluteVerifyUrl,
        issueDate: cert.issueDate,
      }),
      '_blank',
      'noopener',
    );
  };

  const handleCopy = async () => {
    if (!absoluteVerifyUrl) return;
    try {
      await navigator.clipboard.writeText(absoluteVerifyUrl);
    } catch {
      // Clipboard unavailable; the link is visible on the card.
    }
  };

  return (
    <Card className="border-border bg-gradient-to-br from-white/5 to-transparent">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base leading-tight flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-400 shrink-0" />
              {cert.title}
            </CardTitle>
            <CardDescription className="mt-1">
              {cert.certificateType ? `${cert.certificateType} · ` : ''}Issued {fmtDate(cert.issueDate)}
              {cert.issuingAuthority ? ` by ${cert.issuingAuthority}` : ''}
            </CardDescription>
          </div>
          <Badge
            variant={issued ? 'secondary' : 'destructive'}
            className="shrink-0"
          >
            {issued ? 'Issued' : 'Revoked'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-4">
          <div className="h-24 w-24 shrink-0 rounded-lg border border-border bg-white p-1 flex items-center justify-center">
            {qrLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            ) : qrUrl ? (
              <Image src={qrUrl} alt={`QR code for ${cert.code}`} width={88} height={88} unoptimized />
            ) : (
              <span className="text-[10px] text-slate-500 text-center px-1">
                {issued ? 'QR unavailable' : 'Revoked'}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase font-bold text-muted-foreground">Verification code</p>
            <p className="font-mono text-sm text-primary break-all">{cert.code || 'No code'}</p>
            {absoluteVerifyUrl && issued && (
              <Link
                href={cert.verificationUrl || '#'}
                className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline break-all"
              >
                Verify <ExternalLink className="h-3 w-3" />
              </Link>
            )}
            {cert.description && (
              <p className="mt-2 text-xs text-muted-foreground line-clamp-3">{cert.description}</p>
            )}
          </div>
        </div>

        {issued && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={handleDownloadPdf} disabled={downloading} className="gap-1.5">
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Download PDF
            </Button>
            <Button size="sm" variant="outline" onClick={handleLinkedInShare} className="gap-1.5">
              <Linkedin className="h-3.5 w-3.5" /> Share on LinkedIn
            </Button>
            <Button size="sm" variant="ghost" onClick={handleLinkedInAdd} className="gap-1.5">
              <Linkedin className="h-3.5 w-3.5" /> Add to LinkedIn profile
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCopy} className="gap-1.5">
              <Share2 className="h-3.5 w-3.5" /> Copy verify link
            </Button>
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** Credential vault: certificates with QR verification, PDF and LinkedIn actions. */
export function CredentialVault({
  certificates,
  uid,
}: {
  certificates: VaultCertificate[];
  uid: string;
}) {
  if (!certificates || certificates.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-border rounded-3xl bg-muted">
        <Trophy className="h-10 w-10 text-slate-600 mx-auto mb-3 opacity-40" />
        <h3 className="text-xl font-bold text-foreground mb-2">No credentials issued yet</h3>
        <p className="text-muted-foreground max-w-sm mx-auto text-sm">
          Certificates you earn appear here with a QR code anyone can verify.
        </p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {certificates.map((c) => (
        <CertificateCard key={c.id || c.code} cert={c} uid={uid} />
      ))}
    </div>
  );
}
