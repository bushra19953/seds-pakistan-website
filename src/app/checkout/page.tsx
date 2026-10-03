'use client';

import Image from 'next/image';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useUser } from '@/firebase';
import { firestore } from '@/firebase';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { getProduct, createOrder } from '@/app/actions/store';
import { linkOrderToApplication } from '@/app/actions/chapter-applications';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { FormRenderer, Form } from '@/components/forms/form-renderer';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    Loader2, CheckCircle2, ArrowRight, CreditCard, AlertTriangle,
    FileText, Sparkles, Ticket,
    Clock, User, ChevronRight, PartyPopper, Copy,
    Check, ShieldCheck, Zap, Star
} from 'lucide-react';
import { Product } from '@/types/store';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import ReceiptUploader from '@/components/checkout/receipt-uploader';
import type { DriveUploadMeta } from '@/lib/uploads/client';

// ─── 🔊 Premium Web Audio reward sequence ────────────────────────────────────
function playVictorySound() {
    try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        // Epic winning arpeggio: C-E-G-C + high octave shimmer
        const melody = [
            { freq: 523.25, t: 0, vol: 0.22, dur: 0.5 },   // C5
            { freq: 659.25, t: 0.09, vol: 0.20, dur: 0.5 },   // E5
            { freq: 783.99, t: 0.18, vol: 0.20, dur: 0.5 },   // G5
            { freq: 1046.5, t: 0.28, vol: 0.18, dur: 0.8 },   // C6
            { freq: 1318.5, t: 0.42, vol: 0.12, dur: 0.6 },   // E6 (shimmer)
            { freq: 1567.9, t: 0.52, vol: 0.10, dur: 0.6 },   // G6 (shimmer peak)
        ];
        melody.forEach(({ freq, t, vol, dur }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, ctx.currentTime + t);
            gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + dur);
            osc.start(ctx.currentTime + t);
            osc.stop(ctx.currentTime + t + dur + 0.05);
        });
        // Low boom punch at start
        const boom = ctx.createOscillator();
        const boomGain = ctx.createGain();
        boom.connect(boomGain);
        boomGain.connect(ctx.destination);
        boom.type = 'sine';
        boom.frequency.setValueAtTime(120, ctx.currentTime);
        boom.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3);
        boomGain.gain.setValueAtTime(0.35, ctx.currentTime);
        boomGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        boom.start(ctx.currentTime);
        boom.stop(ctx.currentTime + 0.4);
    } catch { /* silently ignore if audio not available */ }
}

// ─── 🎉 Nuclear Confetti Cannon — 5-wave explosion ──────────────────────────
function fireNuclearConfetti() {
    const colors = ['#e8723a', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#ffffff'];
    const shoot = (opts: confetti.Options) => confetti({ colors, ...opts });

    // Wave 1: Center mega burst
    shoot({ particleCount: 180, spread: 90, origin: { x: 0.5, y: 0.6 }, startVelocity: 50, scalar: 1.2 });
    // Wave 2: Left side cannon
    setTimeout(() => shoot({ particleCount: 100, angle: 55, spread: 65, origin: { x: 0, y: 0.65 }, startVelocity: 65, scalar: 1.1 }), 130);
    // Wave 3: Right side cannon
    setTimeout(() => shoot({ particleCount: 100, angle: 125, spread: 65, origin: { x: 1, y: 0.65 }, startVelocity: 65, scalar: 1.1 }), 260);
    // Wave 4: Top center golden shower
    setTimeout(() => shoot({ particleCount: 120, spread: 120, origin: { x: 0.5, y: 0.15 }, gravity: 0.7, ticks: 250, colors: ['#f59e0b', '#fcd34d', '#ffffff', '#8b5cf6'] }), 450);
    // Wave 5: Final double side burst
    setTimeout(() => {
        shoot({ particleCount: 70, angle: 60, spread: 50, origin: { x: 0.1, y: 0.7 }, startVelocity: 55 });
        shoot({ particleCount: 70, angle: 120, spread: 50, origin: { x: 0.9, y: 0.7 }, startVelocity: 55 });
    }, 700);
    // Wave 6: Late rain
    setTimeout(() => shoot({ particleCount: 60, spread: 160, origin: { x: 0.5, y: 0 }, gravity: 0.6, ticks: 300 }), 1200);
}

// ─── Progress Stepper ────────────────────────────────────────────────────────
const STEPS = [
    { label: 'Review Order', icon: '📋' },
    { label: 'Submit Proof', icon: '📎' },
    { label: 'Confirmed!', icon: '🎉' },
];

function ProgressStepper({ current }: { current: 0 | 1 | 2 }) {
    return (
        <div className="flex items-center justify-center gap-0 mb-10" role="list" aria-label="Checkout progress">
            {STEPS.map((step, i) => {
                const done = i < current;
                const active = i === current;
                return (
                    <div key={step.label} className="flex items-center" role="listitem">
                        <div className="flex flex-col items-center gap-1.5">
                            <motion.div
                                animate={active ? { scale: [1, 1.12, 1], boxShadow: ['0 0 0 0 rgba(var(--primary-rgb),0)', '0 0 0 8px rgba(var(--primary-rgb),0.15)', '0 0 0 0 rgba(var(--primary-rgb),0)'] } : {}}
                                transition={{ duration: 1.8, repeat: active ? Infinity : 0, ease: 'easeInOut' }}
                                className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all duration-500
                                    ${done ? 'bg-green-500 border-green-500 text-foreground shadow-[0_0_16px_rgba(34,197,94,0.5)]' :
                                        active ? 'bg-primary border-primary text-foreground shadow-[0_0_20px_hsl(var(--primary)/0.65)]' :
                                            'bg-muted/20 border-border text-muted-foreground'}`}
                            >
                                {done ? <CheckCircle2 className="w-5 h-5" /> : <span className="text-base">{step.icon}</span>}
                            </motion.div>
                            <span className={`text-[10px] font-bold uppercase tracking-widest whitespace-nowrap
                                ${active ? 'text-primary' : done ? 'text-green-400' : 'text-muted-foreground'}`}>
                                {step.label}
                            </span>
                        </div>
                        {i < STEPS.length - 1 && (
                            <motion.div
                                initial={{ scaleX: 0 }}
                                animate={{ scaleX: i < current ? 1 : 0 }}
                                transition={{ duration: 0.6, ease: 'easeOut' }}
                                style={{ originX: 0 }}
                                className="h-0.5 w-14 md:w-20 mx-2 mb-5 bg-green-500 rounded-full"
                            />
                        )}
                        {i < STEPS.length - 1 && (
                            <div className={`h-0.5 w-14 md:w-20 mx-2 mb-5 rounded-full absolute ${i < current ? 'opacity-0' : 'bg-muted'}`} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ─── Animated Loading Skeleton for Checkout ───────────────────────────────────
function CheckoutSkeleton() {
    return (
        <div className="container max-w-5xl mx-auto py-8 md:py-12 px-4 animate-pulse">
            <div className="mb-8 text-center space-y-3">
                <div className="h-5 w-32 bg-muted rounded-full mx-auto" />
                <div className="h-12 w-72 bg-muted rounded-xl mx-auto" />
                <div className="h-4 w-56 bg-muted rounded-lg mx-auto" />
            </div>
            <div className="flex items-center justify-center gap-4 mb-10">
                {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-muted" />
                        {i < 2 && <div className="h-0.5 w-16 bg-muted rounded-full" />}
                    </div>
                ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-4">
                    <div className="h-40 rounded-2xl bg-muted" />
                    <div className="h-32 rounded-2xl bg-muted" />
                </div>
                <div className="md:col-span-2 space-y-4">
                    <div className="h-48 rounded-2xl bg-muted" />
                    <div className="h-64 rounded-2xl bg-muted" />
                </div>
            </div>
        </div>
    );
}

// ─── 🏆 MEGA SUCCESS / ORGASM SCREEN ─────────────────────────────────────────
function SuccessScreen({ productName, orderId, total, currency, isEvent, onGoToOrders, onGoHome }: {
    productName: string;
    orderId: string;
    total: number;
    currency: string;
    isEvent?: boolean;
    onGoToOrders: () => void;
    onGoHome: () => void;
}) {
    const [countdown, setCountdown] = useState(12);
    const [copied, setCopied] = useState(false);
    const [showTicketPreview, setShowTicketPreview] = useState(false);
    const hasPlayed = useRef(false);

    useEffect(() => {
        if (hasPlayed.current) return;
        hasPlayed.current = true;
        // Immediate first burst
        fireNuclearConfetti();
        playVictorySound();
        // Second wave at 2s
        setTimeout(fireNuclearConfetti, 2000);
    }, []);

    // Ticket preview popup after 1.2s
    useEffect(() => {
        if (isEvent) {
            const t = setTimeout(() => setShowTicketPreview(true), 1200);
            return () => clearTimeout(t);
        }
    }, [isEvent]);

    useEffect(() => {
        if (countdown <= 0) { onGoToOrders(); return; }
        const t = setTimeout(() => setCountdown(c => c - 1), 1000);
        return () => clearTimeout(t);
    }, [countdown, onGoToOrders]);

    const copyOrderId = () => {
        navigator.clipboard.writeText(orderId).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="min-h-screen flex flex-col items-center justify-center px-4 py-16 text-center relative overflow-hidden"
        >
            {/* Animated background radial glows */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <motion.div
                    animate={{ scale: [1, 1.15, 1], opacity: [0.15, 0.3, 0.15] }}
                    transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
                    className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-green-500/20 rounded-full blur-[140px]"
                />
                <motion.div
                    animate={{ scale: [1.1, 1, 1.1], opacity: [0.1, 0.2, 0.1] }}
                    transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
                    className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-primary/20 rounded-full blur-[90px]"
                />
                {/* Floating star particles */}
                {[...Array(8)].map((_, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, scale: 0, x: '50%', y: '50%' }}
                        animate={{
                            opacity: [0, 0.8, 0],
                            scale: [0, 1, 0],
                            x: `${30 + Math.random() * 40}%`,
                            y: `${20 + Math.random() * 60}%`,
                        }}
                        transition={{ duration: 2.5 + Math.random() * 2, delay: 0.5 + i * 0.3, repeat: Infinity, repeatDelay: Math.random() * 3 }}
                        className="absolute text-yellow-400 text-2xl pointer-events-none"
                        style={{ left: `${10 + (i * 11)}%`, top: `${15 + (i * 9) % 70}%` }}
                    >
                        ✦
                    </motion.div>
                ))}
            </div>

            {/* ── Animated pulsing success ring ── */}
            <div className="relative mb-8">
                {/* Outer pulse rings */}
                {[0, 1, 2].map(i => (
                    <motion.div
                        key={i}
                        className="absolute inset-0 rounded-full border-2 border-green-400/30"
                        animate={{ scale: [1, 1.6 + i * 0.4], opacity: [0.4, 0] }}
                        transition={{ duration: 2, repeat: Infinity, delay: i * 0.5, ease: 'easeOut' }}
                        style={{ margin: '-12px' }}
                    />
                ))}
                <motion.div
                    initial={{ scale: 0, rotate: -45 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 250, damping: 15, delay: 0.1 }}
                    className="relative w-28 h-28 rounded-full bg-gradient-to-br from-green-500/30 to-green-600/20 border-2 border-green-500/60 flex items-center justify-center shadow-[0_0_60px_rgba(34,197,94,0.5)]"
                >
                    <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: 0.4, type: 'spring', stiffness: 300, damping: 12 }}
                    >
                        <CheckCircle2 className="w-14 h-14 text-green-400 drop-shadow-[0_0_12px_rgba(34,197,94,0.8)]" />
                    </motion.div>
                </motion.div>
            </div>

            {/* ── Main celebration copy ── */}
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.6 }}
                className="relative z-10 max-w-lg w-full space-y-6"
            >
                <div>
                    <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.6 }}
                        className="flex items-center justify-center gap-2 text-green-400 text-sm font-bold uppercase tracking-widest mb-3"
                    >
                        <PartyPopper className="w-4 h-4" />
                        Payment Submitted Successfully!
                        <PartyPopper className="w-4 h-4" />
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.65, duration: 0.5 }}
                        className="text-4xl md:text-6xl font-extrabold text-foreground tracking-tight leading-none"
                    >
                        You&apos;re In! 🚀
                    </motion.h1>
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.75 }}
                        className="text-muted-foreground text-base md:text-lg mt-3 leading-relaxed"
                    >
                        Your payment proof has been received. Our team will verify and {isEvent ? 'issue your ticket' : 'process your order'} within <strong className="text-foreground">24 hours</strong>.
                    </motion.p>
                </div>

                {/* ── Order receipt card ── */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.85, duration: 0.5 }}
                    className="rounded-2xl bg-card/50 backdrop-blur-2xl border border-border overflow-hidden shadow-2xl"
                >
                    {/* Card header with gradient */}
                    <div className="px-5 py-3 bg-gradient-to-r from-green-500/15 to-primary/10 border-b border-border flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-green-400" />
                        <span className="text-xs font-bold text-green-300 uppercase tracking-widest">Order Confirmed</span>
                        <span className="ml-auto">
                            <Badge className="bg-green-500/20 text-green-300 border-green-500/30 text-[10px] uppercase">Pending Review</Badge>
                        </span>
                    </div>
                    <div className="p-5 space-y-3">
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground text-sm">Item</span>
                            <span className="font-bold text-foreground text-sm text-right max-w-[55%] leading-tight">{productName}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground text-sm">Amount</span>
                            <span className="font-black text-foreground text-lg tabular-nums">{currency} {total.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground text-sm">Order ID</span>
                            <button
                                onClick={copyOrderId}
                                className="group flex items-center gap-1.5 font-mono text-xs text-primary bg-primary/10 hover:bg-primary/20 px-2.5 py-1.5 rounded-lg border border-primary/20 transition-all"
                                title="Click to copy"
                            >
                                {orderId.slice(0, 12)}…
                                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 opacity-50 group-hover:opacity-100" />}
                            </button>
                        </div>
                        <div className="flex items-start gap-2 pt-1 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2.5">
                            <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span>Verification typically completes within <strong>24 hours</strong>. You&apos;ll receive a notification once {isEvent ? 'your ticket is issued' : 'your order is confirmed'}.</span>
                        </div>
                    </div>
                </motion.div>

                {/* ── Ticket preview popup for event orders ── */}
                <AnimatePresence>
                    {showTicketPreview && isEvent && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.85, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, y: -10 }}
                            transition={{ type: 'spring', stiffness: 200, damping: 18 }}
                            className="rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-950/60 to-indigo-950/60 backdrop-blur-2xl overflow-hidden shadow-[0_0_40px_rgba(139,92,246,0.2)]"
                        >
                            <div className="px-4 py-2.5 bg-violet-500/15 border-b border-violet-500/20 flex items-center gap-2">
                                <Ticket className="w-4 h-4 text-violet-400" />
                                <span className="text-xs font-bold text-violet-300 uppercase tracking-widest">Your Ticket Is Being Prepared</span>
                                <motion.div
                                    animate={{ opacity: [1, 0.3, 1] }}
                                    transition={{ duration: 1, repeat: Infinity }}
                                    className="ml-auto flex items-center gap-1.5 text-xs text-violet-400"
                                >
                                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                                    Processing
                                </motion.div>
                            </div>
                            <div className="p-4 flex items-center gap-4">
                                <div className="w-14 h-14 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
                                    <Ticket className="w-7 h-7 text-violet-400" />
                                </div>
                                <div className="flex-1 text-left">
                                    <p className="font-bold text-foreground text-sm leading-tight">{productName}</p>
                                    <p className="text-violet-300/70 text-xs mt-1">Your personalized e-ticket will appear in your profile once our team verifies your payment.</p>
                                    <div className="flex items-center gap-1.5 mt-2">
                                        {[...Array(5)].map((_, i) => (
                                            <motion.div
                                                key={i}
                                                className="h-1 flex-1 rounded-full bg-violet-500/40"
                                                animate={{ opacity: [0.3, 1, 0.3] }}
                                                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* ── Action buttons ── */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1.0 }}
                    className="flex flex-col sm:flex-row gap-3"
                >
                    <Button
                        onClick={onGoToOrders}
                        className="flex-1 bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-600/90 text-foreground font-bold h-12 shadow-[0_0_24px_hsl(var(--primary)/0.4)] hover:shadow-[0_0_32px_hsl(var(--primary)/0.6)] transition-all"
                    >
                        <Ticket className="mr-2 h-4 w-4" />
                        {isEvent ? 'View My Tickets' : 'View My Orders'}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={onGoHome}
                        className="flex-1 border-white/15 text-foreground/80 hover:bg-muted h-12 backdrop-blur-md"
                    >
                        Back to Home
                    </Button>
                </motion.div>

                {/* Auto-redirect countdown */}
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 1.1 }}
                    className="text-xs text-muted-foreground flex items-center justify-center gap-1.5"
                >
                    <Clock className="w-3.5 h-3.5" />
                    Auto-redirecting in{' '}
                    <motion.span
                        key={countdown}
                        initial={{ scale: 1.3, color: '#a78bfa' }}
                        animate={{ scale: 1, color: '#a78bfa' }}
                        transition={{ duration: 0.3 }}
                        className="font-black tabular-nums text-violet-400"
                    >
                        {countdown}s
                    </motion.span>
                </motion.p>
            </motion.div>
        </motion.div>
    );
}

// ─── Main Checkout Component ─────────────────────────────────────────────────
function CheckoutContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { user } = useUser();
    const { toast } = useToast();

    const productId = searchParams.get('productId');
    const type = searchParams.get('type');
    const amountParam = searchParams.get('amount');
    const eventIdParam = searchParams.get('eventId');
    const certificateCodeParam = searchParams.get('certificateCode');
    const chapterApplicationIdParam = searchParams.get('chapterApplicationId');

    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [product, setProduct] = useState<Product | null>(null);
    const [donationAmount, setDonationAmount] = useState<string>(amountParam || '1000');

    type PaymentMethod = { enabled: boolean; name: string; instructions: string; iconUrl?: string; };
    type PaymentMethodsSettings = { methods: Record<string, PaymentMethod>; order: string[]; testMode: boolean; };

    const [methodSettings, setMethodSettings] = useState<PaymentMethodsSettings | null>(null);
    const [loadingMethods, setLoadingMethods] = useState(true);
    const [selectedMethodKey, setSelectedMethodKey] = useState<string>('bank_transfer');

    const [formData, setFormData] = useState({ fullName: '', email: '', phone: '', notes: '' });
    const [receipt, setReceipt] = useState<DriveUploadMeta | null>(null);
    const [linkedForm, setLinkedForm] = useState<Form | null>(null);
    const [formResponses, setFormResponses] = useState<Record<string, any>>({});

    // Success state — includes isEvent flag for the ticket preview popup
    const [successData, setSuccessData] = useState<{
        orderId: string; productName: string; total: number; currency: string; isEvent: boolean;
    } | null>(null);

    // ── Profile auto-fill ───────────────────────────────────────────────────
    useEffect(() => {
        if (!user) return;
        setFormData(prev => ({
            ...prev,
            fullName: prev.fullName || user.displayName || '',
            email: prev.email || user.email || '',
        }));
        if (!firestore) return;
        getDoc(doc(firestore, 'users', user.uid)).then(snap => {
            if (!snap.exists()) return;
            const d = snap.data();
            setFormData(prev => ({
                ...prev,
                fullName: prev.fullName || d.displayName || d.name || user.displayName || '',
                email: prev.email || d.email || user.email || '',
                phone: prev.phone || d.whatsapp || d.whatsappNumber || d.phone || d.phoneNumber || d.contactNumber || '',
            }));
        }).catch(() => { });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.uid]);

    // ── Load payment methods ────────────────────────────────────────────────
    useEffect(() => {
        const load = async () => {
            try {
                setLoadingMethods(true);
                const ref = doc(firestore, 'settings', 'payment_methods');
                const snap = await getDoc(ref);
                if (snap.exists()) {
                    const data = snap.data() as PaymentMethodsSettings;
                    setMethodSettings(data);
                    // Auto-select first enabled method
                    const firstEnabledKey = (data.order || []).find(k => data.methods?.[k]?.enabled);
                    if (firstEnabledKey) setSelectedMethodKey(firstEnabledKey);
                }
            } catch (e) {
                console.error('Failed to load payment methods', e);
            } finally {
                setLoadingMethods(false);
            }
        };
        load();
    }, []);

    // ── Load product / event ────────────────────────────────────────────────
    useEffect(() => {
        const fetchProductData = async () => {
            if (type === 'donation') { setIsLoading(false); return; }

            const loadStoreProduct = async (pid: string): Promise<Product | null> => {
                const result = await getProduct(pid);
                if (result.success && result.data) return result.data;
                return null;
            };

            if (productId) {
                try {
                    let resolvedProduct = await loadStoreProduct(productId);

                    if (!resolvedProduct && eventIdParam) {
                        const eventRef = doc(firestore, 'events', eventIdParam);
                        const eventSnap = await getDoc(eventRef);
                        if (eventSnap.exists()) {
                            const eventData = eventSnap.data();
                            const linkedPid = eventData.productId || eventData.linkedStoreProductId;
                            if (linkedPid && linkedPid !== productId) {
                                resolvedProduct = await loadStoreProduct(linkedPid);
                            }
                            if (!resolvedProduct) {
                                resolvedProduct = {
                                    id: productId,
                                    name: `${eventData.title || 'Event'} — Ticket`,
                                    description: `Registration for ${eventData.title || 'this event'}`,
                                    price: parseFloat((eventData.paymentDetails?.amount ?? eventData.amountInput ?? 0).toString()),
                                    currency: eventData.paymentDetails?.currency || 'PKR',
                                    stock: 0,
                                    category: 'event-ticket',
                                    isActive: true,
                                    createdAt: Timestamp.now(),
                                    updatedAt: Timestamp.now(),
                                    createdBy: 'system',
                                };
                            }
                        } else {
                            toast({ variant: 'destructive', title: 'Event Not Found', description: 'The event you are trying to pay for does not exist.' });
                        }
                    }

                    if (resolvedProduct) {
                        setProduct(resolvedProduct);
                        const formId = (resolvedProduct as any).formId;
                        if (formId) {
                            try {
                                const formRef = doc(firestore, 'forms', formId);
                                const formSnap = await getDoc(formRef);
                                if (formSnap.exists()) setLinkedForm({ id: formSnap.id, ...formSnap.data() } as Form);
                            } catch (err) { console.error('Error fetching linked form:', err); }
                        }
                    } else if (!eventIdParam) {
                        toast({ variant: 'destructive', title: 'Product Not Found', description: 'The item you are trying to pay for does not exist.' });
                    }
                } catch (error) {
                    console.error('Error fetching product:', error);
                    toast({ variant: 'destructive', title: 'Error', description: 'Failed to load product details.' });
                }
            }
            setIsLoading(false);
        };
        fetchProductData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [productId, type, eventIdParam]);

    const calculateTotal = () => {
        if (type === 'donation') return parseFloat(donationAmount) || 0;
        return product ? product.price : 0;
    };

    // Validate form fields before submit
    const validateForm = (): string | null => {
        if (!receipt) return 'Please upload your payment receipt screenshot.';
        if (!formData.fullName.trim()) return 'Please enter your full name.';
        if (!formData.email.trim() || !formData.email.includes('@')) return 'Please enter a valid email address.';
        if (!formData.phone.trim()) return 'Please enter your phone number.';
        if (linkedForm && Array.isArray(linkedForm.fields)) {
            const missing = linkedForm.fields.filter(f => f.required && !formResponses[f.id]);
            if (missing.length > 0) return `Please fill out: ${missing.map(f => f.label).join(', ')}`;
        }
        return null;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const validationError = validateForm();
        if (validationError) {
            toast({ variant: 'destructive', title: 'Required Fields Missing', description: validationError });
            return;
        }

        if (!user) {
            toast({ title: 'Login Required', description: 'Please log in to complete your purchase.', variant: 'destructive' });
            router.push(`/login?redirect=${encodeURIComponent(window.location.href)}`);
            return;
        }

        setIsSubmitting(true);

        try {
            const total = calculateTotal();
            const receiptMeta = receipt;
            if (!receiptMeta) throw new Error('Please upload your payment receipt screenshot.');
            const orderInput: any = {
                userId: user.uid,
                items: product ? [{ productId: product.id, productName: product.name, quantity: 1, price: product.price, subtotal: product.price }] : [],
                total,
                currency: product?.currency || 'PKR',
                status: 'pending',
                paymentMethod: selectedMethodKey || 'bank_transfer',
                paymentStatus: 'pending',
                proofOfPaymentUrl: receiptMeta.downloadUrl,
                proofOfPaymentDriveFileId: receiptMeta.driveFileId,
                buyer: { fullName: formData.fullName, email: formData.email, phone: formData.phone },
                notes: formData.notes,
                formResponses,
                originatingModule: type === 'donation' ? 'donation' : (eventIdParam ? 'Events' : (certificateCodeParam ? 'Certificates' : (chapterApplicationIdParam ? 'chapter-registration' : 'store'))),
                productId: productId || undefined,
                eventId: eventIdParam || undefined,
                certificateCode: certificateCodeParam || undefined,
                chapterApplicationId: chapterApplicationIdParam || undefined,
                createdBy: user.uid,
            };

            const result = await createOrder(orderInput);

            if (result.success) {
                // Link order to chapter application if applicable
                if (chapterApplicationIdParam && (result as any).id) {
                    linkOrderToApplication(chapterApplicationIdParam, (result as any).id).catch(err =>
                        console.error('Failed to link order to chapter application:', err)
                    );
                }
                const productName = type === 'donation' ? 'Donation' : (product?.name || 'Order');
                setSuccessData({
                    orderId: (result as any).id || 'N/A',
                    productName,
                    total,
                    currency: product?.currency || 'PKR',
                    isEvent: !!eventIdParam,
                });
            } else {
                throw new Error(result.error || 'Failed to create order');
            }
        } catch (error: any) {
            console.error('Checkout Error:', error);
            toast({
                variant: 'destructive',
                title: 'Submission Failed',
                description: error?.message || 'Could not submit your payment. Please try again or contact support.',
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    // ── Success screen ─────────────────────────────────────────────────────
    if (successData) {
        return (
            <SuccessScreen
                {...successData}
                onGoToOrders={() => router.push('/user/profile?tab=tickets')}
                onGoHome={() => router.push('/')}
            />
        );
    }

    // ── Loading skeleton ────────────────────────────────────────────────────
    if (isLoading) return <CheckoutSkeleton />;

    if (!product && type !== 'donation') {
        return (
            <div className="container mx-auto py-20 text-center space-y-4">
                <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto" />
                <h1 className="text-2xl font-bold">Item Unavailable</h1>
                <p className="text-muted-foreground">This item doesn&apos;t exist or has been removed.</p>
                <Button onClick={() => router.back()} variant="outline">Go Back</Button>
            </div>
        );
    }

    const isReadyToSubmit = !!receipt && formData.fullName.trim() && formData.email.trim() && formData.phone.trim();

    return (
        <div className="container max-w-5xl mx-auto py-8 md:py-12 px-4 selection:bg-primary/30">

            {/* Not logged in warning */}
            <AnimatePresence>
                {!user && (
                    <motion.div
                        initial={{ opacity: 0, y: -12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -12 }}
                        className="mb-6"
                    >
                        <Alert className="border-amber-500/40 bg-amber-500/10">
                            <User className="h-4 w-4 text-amber-400" />
                            <AlertTitle className="text-amber-300">Login Required</AlertTitle>
                            <AlertDescription className="text-amber-200/80 flex items-center justify-between gap-4 flex-wrap">
                                <span>You must be logged in to complete your purchase.</span>
                                <Button size="sm" onClick={() => router.push(`/login?redirect=${encodeURIComponent(window.location.href)}`)}
                                    className="bg-amber-500 hover:bg-amber-600 text-black font-bold shrink-0">
                                    Login Now <ChevronRight className="ml-1 h-3 w-3" />
                                </Button>
                            </AlertDescription>
                        </Alert>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Header */}
            <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} className="mb-8 text-center">
                <Badge variant="outline" className="mb-4 bg-primary/10 text-primary border-primary/20 backdrop-blur-md px-3 py-1">
                    <Sparkles className="w-3 h-3 mr-1.5" /> Secure Checkout
                </Badge>
                <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-foreground mb-2">
                    Finalize Your Order
                </h1>
                <p className="text-muted-foreground max-w-xl mx-auto text-sm md:text-base">
                    Payments are manually verified by our finance team. Submit your receipt link below to lock in your spot.
                </p>
            </motion.div>

            {/* Progress stepper — dynamic */}
            <ProgressStepper current={isLoading ? 0 : 1} />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

                {/* ── LEFT: Order Summary ──────────────────────────────── */}
                <div className="md:col-span-1 space-y-5">
                    <motion.div initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
                        <Card className="bg-card/40 backdrop-blur-xl border-border shadow-2xl rounded-2xl overflow-hidden">
                            <CardHeader className="bg-muted/30 border-b border-white/5 pb-4">
                                <CardTitle className="text-base font-bold flex items-center gap-2">
                                    <FileText className="w-4 h-4 text-primary" /> Order Details
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-5">
                                {type === 'donation' ? (
                                    <div className="space-y-4">
                                        <div className="flex justify-between items-center text-sm font-medium">
                                            <span className="text-muted-foreground">Type</span>
                                            <span>Donation</span>
                                        </div>
                                        <div>
                                            <Label className="text-muted-foreground mb-1 block text-xs uppercase tracking-wider">Amount (PKR)</Label>
                                            <Input type="number" value={donationAmount} onChange={e => setDonationAmount(e.target.value)}
                                                className="text-right text-lg font-bold h-11 bg-background/50" min="100" />
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Item</span>
                                            <span className="text-base font-bold text-foreground leading-tight">{product?.name}</span>
                                        </div>
                                        <div className="flex justify-between items-center mt-4 pt-4 border-t border-border">
                                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Total Due</span>
                                            <span className="text-2xl font-extrabold text-foreground tracking-tight">
                                                {product?.currency} {parseFloat((product?.price || 0).toString()).toLocaleString()}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </motion.div>

                    {/* Process steps */}
                    <motion.div initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.18 }}>
                        <Card className="bg-primary/5 backdrop-blur-xl border-primary/20 shadow-xl rounded-2xl">
                            <CardHeader className="pb-3">
                                <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-primary" /> How It Works
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-3">
                                    {[
                                        { icon: '💸', label: 'Transfer Funds', sub: 'Send to the official account below.' },
                                        { icon: '📎', label: 'Submit Drive Link', sub: 'Upload receipt & paste the link.' },
                                        { icon: '🎉', label: 'Get Confirmed!', sub: 'Ticket/order appears in your profile.', highlight: true },
                                    ].map(item => (
                                        <div key={item.label} className={`flex gap-3 pl-3 border-l-2 ${item.highlight ? 'border-primary' : 'border-border'}`}>
                                            <span className="text-base shrink-0">{item.icon}</span>
                                            <div className="flex flex-col">
                                                <span className={`text-xs font-bold ${item.highlight ? 'text-primary' : 'text-foreground'}`}>{item.label}</span>
                                                <span className="text-xs text-muted-foreground">{item.sub}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    </motion.div>
                </div>

                {/* ── RIGHT: Payment + Proof ───────────────────────────── */}
                <div className="md:col-span-2 space-y-5">

                    {/* Payment Methods */}
                    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
                        <Card className="bg-card/40 backdrop-blur-xl border-border shadow-2xl rounded-2xl overflow-hidden">
                            <CardHeader className="bg-muted/30 border-b border-white/5">
                                <CardTitle className="flex items-center gap-2 text-base font-bold">
                                    <CreditCard className="w-4 h-4 text-primary" /> Payment Instructions
                                </CardTitle>
                                <CardDescription>Complete your transfer using one of the methods below, then paste your receipt link.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4 pt-5 text-sm">
                                {loadingMethods ? (
                                    <div className="space-y-3">
                                        {[1, 2].map(i => (
                                            <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
                                        ))}
                                    </div>
                                ) : methodSettings && Array.isArray(methodSettings.order) && methodSettings.order.length > 0 ? (() => {
                                    const enabledMethods = methodSettings.order
                                        .map(k => ({ key: k, ...methodSettings.methods?.[k] }))
                                        .filter(m => m.enabled);
                                    if (enabledMethods.length === 0) return (
                                        <Alert variant="destructive" className="rounded-xl">
                                            <AlertTriangle className="h-4 w-4" />
                                            <AlertTitle>No Payment Methods</AlertTitle>
                                            <AlertDescription>No payment methods are currently configured.</AlertDescription>
                                        </Alert>
                                    );
                                    const selectedMethod = enabledMethods.find(m => m.key === selectedMethodKey) || enabledMethods[0];
                                    return (
                                        <div className="space-y-3">
                                            {/* Method selector tabs — only shown when >1 method */}
                                            {enabledMethods.length > 1 && (
                                                <div className="space-y-2">
                                                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                                                        Select Payment Method
                                                    </p>
                                                    <div className="flex flex-wrap gap-2">
                                                        {enabledMethods.map(m => (
                                                            <button
                                                                key={m.key}
                                                                type="button"
                                                                onClick={() => setSelectedMethodKey(m.key)}
                                                                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border transition-all duration-200
                                                                    ${selectedMethodKey === m.key
                                                                        ? 'bg-primary/20 border-primary/50 text-primary shadow-[0_0_12px_hsl(var(--primary)/0.2)]'
                                                                        : 'bg-muted border-border text-muted-foreground hover:bg-muted'}`}
                                                            >
                                                                {m.iconUrl ? (
                                                                    <Image src={m.iconUrl} alt={m.name} width={16} height={16} className="w-4 h-4 object-contain rounded-sm" onError={e => (e.currentTarget.style.display = 'none')} />
                                                                ) : <CreditCard className="w-3.5 h-3.5" />}
                                                                {m.name}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            {/* Instructions for selected method */}
                                            {selectedMethod && (
                                                <div className="p-4 bg-background/50 rounded-xl space-y-2 border border-primary/20 shadow-sm">
                                                    <p className="font-bold text-foreground flex items-center gap-2 text-sm">
                                                        {selectedMethod.iconUrl ? (
                                                            <Image src={selectedMethod.iconUrl} alt={selectedMethod.name} width={20} height={20} className="w-5 h-5 object-contain rounded-sm" onError={e => (e.currentTarget.style.display = 'none')} />
                                                        ) : <CreditCard className="w-4 h-4 text-primary" />}
                                                        {selectedMethod.name}
                                                    </p>
                                                    <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed bg-card/60 p-3 rounded-lg border border-white/5 select-all font-mono">
                                                        {selectedMethod.instructions}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })() : (
                                    <Alert variant="destructive" className="rounded-xl">
                                        <AlertTriangle className="h-4 w-4" />
                                        <AlertTitle>No Payment Methods</AlertTitle>
                                        <AlertDescription>Please contact support — no payment methods are currently configured.</AlertDescription>
                                    </Alert>
                                )}
                            </CardContent>
                        </Card>
                    </motion.div>

                    {/* Confirm & Submit */}
                    <motion.div initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }}>
                        <Card className="bg-card/40 backdrop-blur-xl border-border shadow-2xl rounded-2xl overflow-hidden">
                            <CardHeader className="bg-muted/30 border-b border-white/5">
                                <CardTitle className="text-base font-bold flex items-center gap-2">
                                    <CheckCircle2 className="w-4 h-4 text-primary" /> Confirm & Submit Proof
                                </CardTitle>
                            </CardHeader>
                            <form onSubmit={handleSubmit}>
                                <CardContent className="space-y-5 pt-5">

                                    {/* Auto-filled user fields */}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="fullName" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Full Name</Label>
                                            <Input id="fullName" value={formData.fullName}
                                                onChange={e => setFormData({ ...formData, fullName: e.target.value })}
                                                required className="h-11 bg-background/50"
                                                placeholder="Your full name" />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email Address</Label>
                                            <Input id="email" type="email" value={formData.email}
                                                onChange={e => setFormData({ ...formData, email: e.target.value })}
                                                required className="h-11 bg-background/50"
                                                placeholder="you@example.com" />
                                        </div>
                                        <div className="space-y-1.5 sm:col-span-2 sm:max-w-xs">
                                            <Label htmlFor="phone" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone / WhatsApp</Label>
                                            <Input id="phone" type="tel" value={formData.phone}
                                                onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                                required placeholder="+92 300 1234567" className="h-11 bg-background/50" />
                                            <p className="text-[11px] text-muted-foreground">Used for ticket delivery and order updates.</p>
                                        </div>
                                    </div>

                                    {/* Receipt upload — goes to the SEDS Payment Receipts Drive folder */}
                                    <ReceiptUploader onUploaded={setReceipt} disabled={isSubmitting} />

                                    {/* Custom form fields */}
                                    {linkedForm && Array.isArray(linkedForm.fields) && linkedForm.fields.length > 0 && (
                                        <div className="pt-3 border-t border-border">
                                            <div className="flex items-center gap-2 mb-4">
                                                <FileText className="h-4 w-4 text-primary" />
                                                <h3 className="text-sm font-semibold">Additional Information</h3>
                                            </div>
                                            <FormRenderer
                                                form={linkedForm}
                                                responses={formResponses}
                                                onChange={(id, val) => setFormResponses(prev => ({ ...prev, [id]: val }))}
                                            />
                                        </div>
                                    )}

                                    {/* Notes */}
                                    <div className="space-y-1.5">
                                        <Label htmlFor="notes" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Additional Notes (Optional)</Label>
                                        <Textarea id="notes" value={formData.notes}
                                            onChange={e => setFormData({ ...formData, notes: e.target.value })}
                                            placeholder="Any special instructions or info for our team…" className="bg-background/50 resize-none" rows={2} />
                                    </div>

                                </CardContent>
                                <CardFooter className="flex justify-between items-center pt-4 border-t bg-muted/20 gap-4 flex-wrap">
                                    <p className="text-xs text-muted-foreground hidden sm:flex items-center gap-1.5">
                                        <ShieldCheck className="w-3.5 h-3.5 text-green-400" />
                                        Your data is securely stored and never shared.
                                    </p>
                                    <motion.div
                                        animate={isReadyToSubmit && !isSubmitting ? {
                                            boxShadow: ['0 0 0 0 hsl(var(--primary)/0)', '0 0 20px 4px hsl(var(--primary)/0.4)', '0 0 0 0 hsl(var(--primary)/0)']
                                        } : {}}
                                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                                        className="rounded-lg w-full sm:w-auto"
                                    >
                                        <Button
                                            type="submit"
                                            size="lg"
                                            disabled={isSubmitting || !receipt}
                                            className={`w-full sm:w-auto min-w-[200px] font-bold h-12 transition-all duration-300
                                                ${isReadyToSubmit && !isSubmitting
                                                    ? 'bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-600/90 shadow-[0_0_24px_hsl(var(--primary)/0.35)]'
                                                    : 'opacity-60 cursor-not-allowed'}`}
                                        >
                                            {isSubmitting ? (
                                                <span className="flex items-center gap-2">
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    Submitting…
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2">
                                                    <Star className="h-4 w-4" />
                                                    Complete Payment
                                                    <ArrowRight className="h-4 w-4" />
                                                </span>
                                            )}
                                        </Button>
                                    </motion.div>
                                </CardFooter>
                            </form>
                        </Card>
                    </motion.div>
                </div>
            </div>
        </div>
    );
}

export default function CheckoutPage() {
    return (
        <Suspense fallback={<CheckoutSkeleton />}>
            <CheckoutContent />
        </Suspense>
    );
}
