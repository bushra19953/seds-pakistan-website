'use client';

import { useState, useEffect } from 'react';
import { firestore } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import createDOMPurify from 'dompurify';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
    Copy,
    CheckCircle2,
    Heart,
    Building2,
    Smartphone,
    CreditCard,
    DollarSign,
    ArrowRight,
} from 'lucide-react';
import Link from 'next/link';

interface PageContent {
    title: string;
    content: string;
    meta_description: string;
    // Optional structured payment fields (parsed from CMS HTML or added in future)
    bankName?: string;
    accountTitle?: string;
    iban?: string;
    jazzcashNumber?: string;
    easypaisaNumber?: string;
    raastId?: string;
}

const DONATION_PRESETS = [500, 1000, 2500, 5000, 10000, 25000];

// ─── Copy button with transient check animation ──────────────────────────────
function CopyButton({ value, label }: { value: string; label: string }) {
    const { toast } = useToast();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            toast({ title: `${label} Copied!`, description: value });
            setTimeout(() => setCopied(false), 2500);
        } catch {
            toast({ variant: 'destructive', title: 'Copy failed', description: 'Please copy manually.' });
        }
    };

    return (
        <button
            onClick={handleCopy}
            className={`ml-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors
        ${copied
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-primary/10 text-primary hover:bg-primary/20'
                }`}
            title={`Copy ${label}`}
        >
            {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
        </button>
    );
}

// ─── Payment Method Card ─────────────────────────────────────────────────────
function PaymentMethodCard({
    icon: Icon,
    title,
    badge,
    fields,
}: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    badge?: string;
    fields: { label: string; value: string }[];
}) {
    return (
        <Card className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/40 transition-colors">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-3 text-base">
                    <Icon className="h-5 w-5 text-primary" />
                    {title}
                    {badge && <Badge variant="secondary" className="text-xs">{badge}</Badge>}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {fields.map(({ label, value }) => (
                    <div key={label} className="flex items-center justify-between gap-2">
                        <div>
                            <p className="text-xs text-muted-foreground">{label}</p>
                            <p className="font-mono text-sm font-medium">{value}</p>
                        </div>
                        <CopyButton value={value} label={label} />
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

// ─── Page ────────────────────────────────────────────────────────────────────
const DonatePage = () => {
    const [pageContent, setPageContent] = useState<PageContent>({
        title: 'Donate to SEDS Pakistan',
        content: '',
        meta_description: 'Support our mission to democratize space education in Pakistan.',
    });
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string>('');

    const safeDefaultContent = `
    <div class="max-w-3xl mx-auto text-lg space-y-4">
      <p>
        SEDS Pakistan is a student-run non-profit dedicated to empowering the next generation of space leaders.
        Your contribution helps fund workshops, rover projects, and international competition entries for Pakistani students.
      </p>
      <p class="text-muted-foreground text-base">
        Please use the payment methods listed below and send your transaction confirmation to
        <a href="mailto:finance@sedspakistan.org" class="text-primary hover:underline"> finance@sedspakistan.org</a>.
      </p>
    </div>
  `;

    useEffect(() => {
        const fetchPageContent = async () => {
            try {
                const docRef = doc(firestore, 'pages', 'donate');
                const docSnap = await getDoc(docRef);

                if (docSnap.exists()) {
                    const data = docSnap.data() as PageContent;
                    setPageContent(data.content ? data : { ...data, content: safeDefaultContent });
                } else {
                    setPageContent(prev => ({ ...prev, content: safeDefaultContent }));
                }
            } catch (err) {
                console.error('Error loading page content:', err);
                setError('Failed to load content.');
            } finally {
                setIsLoading(false);
            }
        };

        fetchPageContent();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (isLoading) {
        return (
            <div className="container mx-auto py-20 flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
        );
    }

    if (error) return <div className="container mx-auto py-20 text-red-500">{error}</div>;

    // ── Detect if admin has set structured payment fields ──────────────────
    const hasBankDetails = pageContent.bankName || pageContent.accountTitle || pageContent.iban;
    const hasJazzCash = !!pageContent.jazzcashNumber;
    const hasEasyPaisa = !!pageContent.easypaisaNumber;
    const hasRaast = !!pageContent.raastId;
    const hasAnyStructuredPayment = hasBankDetails || hasJazzCash || hasEasyPaisa || hasRaast;

    return (
        <div className="container mx-auto py-12 px-4 min-h-screen max-w-4xl">
            {pageContent.meta_description && (
                <meta name="description" content={pageContent.meta_description} />
            )}

            {/* ── Hero ── */}
            <div className="text-center mb-10">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
                    <Heart className="h-8 w-8 text-primary" />
                </div>
                <h1 className="text-4xl md:text-5xl font-bold text-glow mb-3">
                    {pageContent.title || 'Donate to SEDS Pakistan'}
                </h1>
            </div>

            {/* CMS HTML Content */}
            {pageContent.content && (
                <div
                    dangerouslySetInnerHTML={{
                        __html: (() => {
                            if (typeof window === 'undefined') return '';
                            const purifier = createDOMPurify();
                            return purifier.sanitize(String(pageContent.content));
                        })(),
                    }}
                    className="prose prose-lg dark:prose-invert max-w-none text-center mb-8"
                />
            )}

            {/* NEW: Centralized Donation Action */}
            <div className="max-w-xl mx-auto mb-16 space-y-8">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {DONATION_PRESETS.map(amt => (
                        <Button key={amt} variant="outline" asChild className="h-12 text-lg font-bold hover:border-primary hover:text-primary transition-all">
                            <Link href={`/checkout?type=donation&amount=${amt}`}>
                                PKR {amt.toLocaleString()}
                            </Link>
                        </Button>
                    ))}
                </div>

                <div className="relative">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/10"></span></div>
                    <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">Or Enter Custom Amount</span></div>
                </div>

                <Button size="lg" className="w-full h-14 text-xl font-heading shadow-[0_0_20px_rgba(var(--primary),0.3)] hover:scale-[1.02] transition-transform" asChild>
                    <Link href="/checkout?type=donation">
                        Contribute Now <ArrowRight className="ml-2 h-5 w-5" />
                    </Link>
                </Button>
            </div>

            {/* ── Structured Payment Methods (if admin has set structured fields) ── */}
            {hasAnyStructuredPayment && (
                <div className="space-y-6">
                    <h2 className="text-2xl font-bold text-center">Payment Methods</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {hasBankDetails && (
                            <PaymentMethodCard
                                icon={Building2}
                                title="Bank Transfer"
                                badge="Recommended"
                                fields={[
                                    ...(pageContent.bankName ? [{ label: 'Bank', value: pageContent.bankName }] : []),
                                    ...(pageContent.accountTitle ? [{ label: 'Account Title', value: pageContent.accountTitle }] : []),
                                    ...(pageContent.iban ? [{ label: 'IBAN', value: pageContent.iban }] : []),
                                ]}
                            />
                        )}
                        {hasJazzCash && (
                            <PaymentMethodCard
                                icon={Smartphone}
                                title="JazzCash"
                                fields={[{ label: 'Mobile Number', value: pageContent.jazzcashNumber! }]}
                            />
                        )}
                        {hasEasyPaisa && (
                            <PaymentMethodCard
                                icon={CreditCard}
                                title="EasyPaisa"
                                fields={[{ label: 'Mobile Number', value: pageContent.easypaisaNumber! }]}
                            />
                        )}
                        {hasRaast && (
                            <PaymentMethodCard
                                icon={CreditCard}
                                title="Raast"
                                fields={[{ label: 'Raast ID', value: pageContent.raastId! }]}
                            />
                        )}
                    </div>

                    <Card className="bg-primary/5 border-primary/20 mt-6">
                        <CardContent className="pt-5 pb-5 text-sm text-muted-foreground">
                            <p className="font-medium text-foreground mb-1">After making your transfer:</p>
                            <p>
                                Please email your transaction receipt to{' '}
                                <a href="mailto:finance@sedspakistan.org" className="text-primary hover:underline">
                                    finance@sedspakistan.org
                                </a>{' '}
                                with your name and contact information. We&apos;ll confirm your donation within 24–48 hours.
                            </p>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* ── Fallback if no structured payment fields: raw CMS HTML may include bank details ── */}
            {!hasAnyStructuredPayment && !pageContent.content && (
                <div className="text-center py-8">
                    <p className="text-muted-foreground">
                        Donation details are being updated. Please contact us at{' '}
                        <a href="mailto:finance@sedspakistan.org" className="text-primary hover:underline">
                            finance@sedspakistan.org
                        </a>
                    </p>
                </div>
            )}
        </div>
    );
};

export default DonatePage;
