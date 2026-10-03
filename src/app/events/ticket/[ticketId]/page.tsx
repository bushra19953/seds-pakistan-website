'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { collection, getDocs, query, where, getDoc, doc, getFirestore } from 'firebase/firestore';
import { format } from 'date-fns';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Printer, ArrowLeft, QrCode, CheckCircle2, ShieldCheck, AlertTriangle } from 'lucide-react';
import TicketCongratsModal from '@/components/events/ticket-congrats-modal';

// ─── Ticket data shape matching Firestore ─────────────────────────────────────
interface TicketData {
    ticketId: string;
    dbId?: string;
    ticketNumber: number;
    uid: string;
    displayName: string;
    email: string;
    eventId: string;
    eventTitle: string;
    eventDate: any;
    eventVenue: string;
    issuedAt: any;
    status: 'valid' | 'revoked';
    qrCodeDataUrl: string;
    verificationUrl: string;
    uniqueTicketUrl?: string;
    paymentMethod: string;
    paymentRef: string;
}

function safeDate(ts: any): string {
    try {
        if (!ts) return 'TBD';
        const d = ts?.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
        return format(d, 'EEEE, MMMM d, yyyy • h:mm a');
    } catch {
        return 'TBD';
    }
}

function safeIssuedDate(ts: any): string {
    try {
        if (!ts) return '';
        const d = ts?.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
        return format(d, 'MMM d, yyyy');
    } catch {
        return '';
    }
}

export default function TicketPage() {
    const paramsPromise = useParams();
    const [ticketId, setTicketId] = useState<string>('');
    useEffect(() => {
        if (paramsPromise?.ticketId) setTicketId(paramsPromise.ticketId as string);
    }, [paramsPromise]);

    const searchParams = useSearchParams();
    const isNew = searchParams.get('new') === '1';
    const router = useRouter();

    const containerRef = useRef<HTMLDivElement>(null);
    const [renderScale, setRenderScale] = useState(1);

    // Responsive native scaling match out of 800px base
    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            const { width } = entries[0].contentRect;
            setRenderScale(width / 800);
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);
    const { user, isLoading: userLoading, role } = useUser();
    const [ticket, setTicket] = useState<TicketData | null>(null);
    const [event, setEvent] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showCongrats, setShowCongrats] = useState(isNew);

    const adminRoles = [
        'superadmin', 'president_national', 'president_chapter', 'vice_president',
        'general_secretary', 'projects_director', 'marketing_head', 'hr_director',
        'treasurer', 'advisor', 'chair_events', 'chair_projects', 'chair_marketing',
        'admin'
    ];
    const isAdmin = role && adminRoles.includes(role);

    useEffect(() => {
        if (!ticketId || userLoading) return;
        if (!user) {
            router.push(`/auth?redirect=${encodeURIComponent(`/events/ticket/${ticketId}`)}`);
            return;
        }

        const firestore = getFirestore();
        setLoading(true);

        const lookup = async () => {
            try {
                // Strategy 1: Direct doc lookup (old tickets use readable ID as doc ID)
                const directSnap = await getDoc(doc(firestore, 'eventTickets', ticketId));
                if (directSnap.exists()) {
                    const data = directSnap.data() as TicketData;
                    if (data.uid !== user.uid && !isAdmin) {
                        setError('You do not have permission to view this ticket');
                        setLoading(false);
                        return;
                    }
                    setTicket({ ...data, ticketId: data.ticketId || directSnap.id, dbId: directSnap.id });
                    if (data.eventId) {
                        const evSnap = await getDoc(doc(firestore, 'events', data.eventId));
                        if (evSnap.exists()) setEvent(evSnap.data());
                    }
                    setLoading(false);
                    return;
                }

                // Strategy 2: Query by ticketId FIELD (new tickets use eventId_uid as doc ID)
                const q = query(collection(firestore, 'eventTickets'), where('ticketId', '==', ticketId));
                const snap = await getDocs(q);
                if (snap.empty) {
                    setError('Ticket not found. The link may be incorrect.');
                    setLoading(false);
                    return;
                }

                const docSnap = snap.docs[0];
                const data = docSnap.data() as TicketData;

                if (data.uid !== user.uid && !isAdmin) {
                    setError('You do not have permission to view this ticket');
                    setLoading(false);
                    return;
                }

                setTicket({ ...data, ticketId: data.ticketId || docSnap.id, dbId: docSnap.id });

                if (data.eventId) {
                    const evSnap = await getDoc(doc(firestore, 'events', data.eventId));
                    if (evSnap.exists()) setEvent(evSnap.data());
                }
                setLoading(false);
            } catch (err: any) {
                console.error('[TicketPage] Fetch error:', err);
                setError(err.message?.includes('permission')
                    ? 'Missing or insufficient permissions to view this ticket.'
                    : err.message || 'Failed to load ticket');
                setLoading(false);
            }
        };

        lookup();
    }, [ticketId, userLoading, user, isAdmin, router]);

    if (userLoading || (loading && !error)) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-950">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
                    <p className="text-muted-foreground">Loading your ticket…</p>
                </div>
            </div>
        );
    }

    if (error || !ticket) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-950">
                <div className="text-center text-red-400">
                    <AlertTriangle className="w-12 h-12 mx-auto mb-4" />
                    <p className="text-xl font-bold">{error || 'Ticket not found'}</p>
                    <Link href="/profile" className="mt-6 block text-muted-foreground hover:text-foreground">← Back to Profile</Link>
                </div>
            </div>
        );
    }

    const hasCustomFront = !!(event?.ticketImageUrl || event?.ticketAssets?.frontUrl);
    const hasCustomBack = !!(event?.ticketBackImageUrl || event?.ticketAssets?.backUrl);
    const frontBg = event?.ticketImageUrl || event?.ticketAssets?.frontUrl || '';
    const backBg = event?.ticketBackImageUrl || event?.ticketAssets?.backUrl || '';

    return (
        <>
            {showCongrats && (
                <TicketCongratsModal
                    displayName={ticket.displayName.split(' ')[0]}
                    eventTitle={ticket.eventTitle}
                    ticketNumber={ticket.ticketNumber}
                    onClose={() => setShowCongrats(false)}
                />
            )}

            {/* Screen chrome — hidden during print */}
            <div className="print:hidden bg-slate-950">
                <div className="max-w-3xl mx-auto px-4 py-8">
                    <div className="flex items-center justify-between mb-6">
                        <Button variant="outline" size="sm" onClick={() => router.back()} className="border-slate-700 text-muted-foreground hover:text-foreground">
                            <ArrowLeft className="w-4 h-4 mr-2" /> Back
                        </Button>
                        <Button onClick={() => window.print()} className="bg-white text-black hover:bg-slate-200 shadow-xl">
                            <Printer className="w-4 h-4 mr-2" /> Print / Save PDF
                        </Button>
                    </div>

                    {ticket.status === 'revoked' && (
                        <div className="mb-6 p-4 bg-red-900/40 border border-red-500/50 rounded-xl flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
                            <span className="text-red-300 font-semibold">This ticket has been revoked and is no longer valid.</span>
                        </div>
                    )}

                    <p className="text-muted-foreground text-sm text-center mb-8">
                        Preview below. Click <strong className="text-foreground">Print / Save PDF</strong> to get your physical copy.
                    </p>
                </div>
            </div>

            {/* Premium commemorative ticket image (screen only) */}
            {ticket.uniqueTicketUrl && (
                <div className="print:hidden w-full max-w-[750px] mx-auto px-4 mb-8">
                    <div className="relative aspect-[1.618/1] w-full rounded-2xl overflow-hidden shadow-2xl border border-white/5 group bg-card">
                        <Image
                            src={ticket.uniqueTicketUrl}
                            alt="Unique SEDS Ticket"
                            fill
                            sizes="(max-width: 768px) 100vw, 750px"
                            className="object-contain"
                            priority
                        />
                        <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <a href={ticket.uniqueTicketUrl} download={`SEDS-Ticket-${ticket.ticketId}.png`} target="_blank" rel="noopener noreferrer">
                                <Button className="bg-primary text-black hover:bg-primary/90 font-bold">
                                    <Printer className="w-4 h-4 mr-2" /> Download High-Res
                                </Button>
                            </a>
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground font-medium text-center mt-3">✨ Premium Commemorative Ticket</p>
                    <div className="mt-8 mb-4 flex items-center gap-4">
                        <div className="flex-1 h-px bg-muted/50" />
                        <span className="text-[10px] uppercase tracking-widest text-slate-600 font-black">Standard Printable Ticket</span>
                        <div className="flex-1 h-px bg-muted/50" />
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════════════ */}
            {/*            UNIFIED PRINT TICKET — NO FRAGMENTATION              */}
            {/* ════════════════════════════════════════════════════════════════ */}
            <div className="print:block flex justify-center items-start pb-16 bg-slate-950 min-h-screen print:min-h-0 print:pb-0 print:m-0 print:bg-white">
                <div
                    ref={containerRef}
                    className="ticket-wrapper w-full max-w-[750px] mx-auto shadow-2xl print:shadow-none print:max-w-none"
                    style={{ fontFamily: "'Segoe UI', Arial, sans-serif", '--scale-factor': renderScale } as any}
                >
                    {/* ── FRONT ─────────────────────────────────────────────────── */}
                    <div
                        className="ticket-front relative overflow-hidden bg-card text-foreground"
                        style={{
                            borderRadius: '16px 16px 0 0',
                            backgroundColor: '#0f172a',
                            WebkitPrintColorAdjust: 'exact',
                            printColorAdjust: 'exact',
                            ...(!hasCustomFront ? { minHeight: 280 } : {})
                        }}
                    >
                        {hasCustomFront && (
                            <img src={frontBg} alt="Ticket Front Background" className="w-full h-auto block select-none pointer-events-none" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }} />
                        )}
                        {/* Dynamic overlays from alignment editor */}
                        {(event?.ticketConfig?.frontOverlays || event?.ticketConfig?.overlays) && (
                            <div className="absolute inset-0 pointer-events-none">
                                {Object.entries(event.ticketConfig.frontOverlays || event.ticketConfig.overlays || {}).map(([key, cfg]: [string, any]) => {
                                    if (!cfg || cfg.enabled === false) return null;
                                    let content = '';
                                    if (key === 'name') content = ticket.displayName;
                                    if (key === 'ticketNum') content = `#${ticket.ticketNumber.toString().padStart(3, '0')}`;
                                    if (key === 'email') content = ticket.email;
                                    if (key === 'eventTitle') content = ticket.eventTitle;
                                    if (key === 'eventDate') content = safeDate(ticket.eventDate);
                                    if (key === 'eventVenue') content = ticket.eventVenue || '';
                                    if (key === 'orgName') content = 'SEDS Pakistan';
                                    if (key === 'orgTagline') content = 'Students for Space Exploration';
                                    if (key === 'issuedDate') content = `Issued ${safeIssuedDate(ticket.issuedAt)}`;
                                    if (key === 'paymentRef') content = `Ref: ${ticket.paymentRef || 'N/A'}`;
                                    if (key === 'verificationUrl') content = `seds-pakistan.web.app/ticket/${ticket.ticketId || ticketId}`;
                                    if (key === 'disclaimer') content = "This ticket is non-transferable and valid for one-time entry only. For support, contact SEDS Pakistan.";

                                    if (key === 'logo') {
                                        return (
                                            <div key={key} className="absolute flex items-center justify-center bg-indigo-600 rounded-full"
                                                style={{ left: `${cfg.x}%`, top: `${cfg.y}%`, width: `${cfg.size / 8}cqw`, height: `${cfg.size / 8}cqw`, transform: 'translate(-50%, -50%)' }}>
                                                <span className="text-foreground font-black" style={{ fontSize: `${(cfg.size * 0.4) / 8}cqw` }}>S</span>
                                            </div>
                                        );
                                    }

                                    if (key === 'statusBadge') {
                                        const isValid = ticket.status === 'valid';
                                        return (
                                            <div key={key} className={`absolute px-3 py-1 rounded-full flex items-center gap-1.5 border ${isValid ? 'bg-green-500/10 border-green-500/50 text-green-400' : 'bg-red-500/10 border-red-500/50 text-red-400'}`}
                                                style={{ left: `${cfg.x}%`, top: `${cfg.y}%`, fontSize: `calc(${cfg.size}px * var(--scale-factor, 1))`, transform: 'translate(-50%, -50%)' }}>
                                                {isValid ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                                                <span className="font-bold">{isValid ? 'Valid' : 'Revoked'}</span>
                                            </div>
                                        );
                                    }

                                    if (key === 'qrCode') {
                                        return (
                                            <div key={key} className="absolute bg-white p-1 rounded-sm shadow-xl"
                                                style={{ left: `${cfg.x}%`, top: `${cfg.y}%`, width: `${(cfg.size || 80) * renderScale}px`, height: `${(cfg.size || 80) * renderScale}px`, transform: 'translate(-50%, -50%)' }}>
                                                <Image src={ticket.qrCodeDataUrl} alt="QR" width={(cfg.size || 80) * renderScale} height={(cfg.size || 80) * renderScale} className="w-full h-full" unoptimized />
                                            </div>
                                        );
                                    }

                                    return (
                                        <div key={key} className="absolute whitespace-nowrap font-bold text-center"
                                            style={{
                                                left: `${cfg.x}%`,
                                                top: `${cfg.y}%`,
                                                fontSize: `${cfg.size * renderScale}px`,
                                                color: cfg.color,
                                                fontFamily: cfg.fontFamily || 'inherit',
                                                fontWeight: cfg.fontWeight || 'bold',
                                                lineHeight: 1,
                                                transform: 'translate(-50%, -50%)',
                                                textShadow: '0 2px 4px rgba(0,0,0,0.5)'
                                            }}>
                                            {content}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Standard fallback (no custom template) */}
                        {!hasCustomFront && (
                            <>
                                <div className="absolute top-0 left-0 right-0 h-1.5" style={{ background: 'linear-gradient(90deg, #6366f1, #06b6d4, #6366f1)' }} />
                                <div className="relative z-10 p-6 md:p-8 flex flex-col md:flex-row gap-6">
                                    <div className="flex-1 space-y-3">
                                        <div className="flex items-center gap-3 mb-4">
                                            <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-black text-sm shrink-0">S</div>
                                            <div>
                                                <p className="font-bold text-sm">SEDS Pakistan</p>
                                                <p className="text-xs text-muted-foreground">Students for Space Exploration</p>
                                            </div>
                                        </div>
                                        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight leading-tight">{ticket.eventTitle}</h1>
                                        <div className="flex items-start gap-2 text-sm">
                                            <span className="text-muted-foreground shrink-0 mt-0.5">📅</span>
                                            <span className="text-foreground">{safeDate(ticket.eventDate)}</span>
                                        </div>
                                        <div className="flex items-start gap-2 text-sm">
                                            <span className="text-muted-foreground shrink-0 mt-0.5">📍</span>
                                            <span className="text-foreground">{ticket.eventVenue || 'To Be Announced'}</span>
                                        </div>
                                        <div className="mt-4 pt-4 border-t border-slate-700/50">
                                            <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Admitted</p>
                                            <p className="text-xl font-bold">{ticket.displayName}</p>
                                            {ticket.email && <p className="text-xs text-muted-foreground">{ticket.email}</p>}
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-center justify-center min-w-[120px] gap-3">
                                        <div className="w-full text-center rounded-xl py-3" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
                                            <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Ticket No.</p>
                                            <p className="text-3xl font-black text-indigo-400">#{ticket.ticketNumber.toString().padStart(3, '0')}</p>
                                        </div>
                                        {ticket.status === 'valid'
                                            ? <div className="flex items-center gap-1.5 text-green-400"><CheckCircle2 className="w-4 h-4" /><span className="text-sm font-semibold">Valid</span></div>
                                            : <div className="flex items-center gap-1.5 text-red-300"><AlertTriangle className="w-4 h-4" /><span className="text-sm font-semibold">Revoked</span></div>
                                        }
                                        <div className="text-center">
                                            <p className="text-xs text-muted-foreground">Issued</p>
                                            <p className="text-xs text-muted-foreground">{safeIssuedDate(ticket.issuedAt)}</p>
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* ── PERFORATED JOINT — no gap on print ─────────────────────── */}
                    <div className="ticket-perforation flex items-center px-3 bg-slate-950 print:bg-white"
                        style={{ height: 24, borderLeft: '2px solid #1e293b', borderRight: '2px solid #1e293b' }}>
                        <div className="w-5 h-5 rounded-full bg-slate-950 print:bg-white -ml-6 border border-slate-800 shrink-0" />
                        <div className="flex-1 border-t-2 border-dashed border-slate-700 mx-2" />
                        <div className="w-5 h-5 rounded-full bg-slate-950 print:bg-white -mr-6 border border-slate-800 shrink-0" />
                    </div>

                    {/* ── BACK ──────────────────────────────────────────────────── */}
                    <div
                        className="ticket-back relative overflow-hidden bg-muted text-foreground"
                        style={{
                            borderRadius: '0 0 16px 16px',
                            backgroundColor: '#0f172a',
                            WebkitPrintColorAdjust: 'exact',
                            printColorAdjust: 'exact',
                            ...(!hasCustomBack ? { minHeight: 200 } : {})
                        }}
                    >
                        {hasCustomBack && (
                            <img src={backBg} alt="Ticket Back Background" className="w-full h-auto block select-none pointer-events-none" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }} />
                        )}
                        {/* Back Overlays */}
                        {event?.ticketConfig?.backOverlays && (
                            <div className="absolute inset-0 pointer-events-none">
                                {Object.entries(event.ticketConfig.backOverlays).map(([key, cfg]: [string, any]) => {
                                    if (!cfg || cfg.enabled === false) return null;
                                    let content = '';
                                    if (key === 'name') content = ticket.displayName;
                                    if (key === 'ticketNum') content = `#${ticket.ticketNumber.toString().padStart(3, '0')}`;
                                    if (key === 'email') content = ticket.email;
                                    if (key === 'eventTitle') content = ticket.eventTitle;
                                    if (key === 'eventDate') content = safeDate(ticket.eventDate);
                                    if (key === 'eventVenue') content = ticket.eventVenue || '';
                                    if (key === 'orgName') content = 'SEDS Pakistan';
                                    if (key === 'orgTagline') content = 'Students for Space Exploration';
                                    if (key === 'issuedDate') content = `Issued ${safeIssuedDate(ticket.issuedAt)}`;
                                    if (key === 'paymentRef') content = `Ref: ${ticket.paymentRef || 'N/A'}`;
                                    if (key === 'verificationUrl') content = `seds-pakistan.web.app/ticket/${ticket.ticketId || ticketId}`;
                                    if (key === 'disclaimer') content = "This ticket is non-transferable and valid for one-time entry only. For support, contact SEDS Pakistan.";

                                    if (key === 'logo') {
                                        return (
                                            <div key={key} className="absolute flex items-center justify-center p-1"
                                                style={{ left: `${cfg.x}%`, top: `${cfg.y}%`, width: `${cfg.size * renderScale}px`, height: `${cfg.size * renderScale}px`, transform: 'translate(-50%, -50%)' }}>
                                                <img src="/assets/logo.png" alt="SEDS Logo" className="w-full h-full object-contain" />
                                            </div>
                                        );
                                    }

                                    if (key === 'statusBadge') {
                                        const isValid = ticket.status === 'valid';
                                        return (
                                            <div key={key} className={`absolute px-3 py-1 rounded-full flex items-center gap-1.5 border ${isValid ? 'bg-green-500/10 border-green-500/50 text-green-400' : 'bg-red-500/10 border-red-500/50 text-red-400'}`}
                                                style={{ left: `${cfg.x}%`, top: `${cfg.y}%`, fontSize: `${cfg.size * renderScale}px`, transform: 'translate(-50%, -50%)' }}>
                                                {isValid ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                                                <span className="font-bold whitespace-nowrap">{isValid ? 'Valid' : 'Revoked'}</span>
                                            </div>
                                        );
                                    }

                                    if (key === 'qrCode') {
                                        return (
                                            <div key={key} className="absolute bg-white p-1 rounded-sm shadow-xl"
                                                style={{ left: `${cfg.x}%`, top: `${cfg.y}%`, width: `${(cfg.size || 80) * renderScale}px`, height: `${(cfg.size || 80) * renderScale}px`, transform: 'translate(-50%, -50%)' }}>
                                                <Image src={ticket.qrCodeDataUrl} alt="QR" width={(cfg.size || 80) * renderScale} height={(cfg.size || 80) * renderScale} className="w-full h-full" unoptimized />
                                            </div>
                                        );
                                    }

                                    return (
                                        <div key={key} className="absolute whitespace-nowrap font-bold text-center"
                                            style={{
                                                left: `${cfg.x}%`,
                                                top: `${cfg.y}%`,
                                                fontSize: `${cfg.size * renderScale}px`,
                                                color: cfg.color,
                                                fontFamily: cfg.fontFamily || 'inherit',
                                                fontWeight: cfg.fontWeight || 'bold',
                                                lineHeight: 1,
                                                transform: 'translate(-50%, -50%)',
                                                textShadow: '0 2px 4px rgba(0,0,0,0.5)'
                                            }}>
                                            {content}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {!hasCustomBack ? (
                            <div className="p-6 md:p-8 flex flex-col md:flex-row items-center gap-8">
                                <div className="flex flex-col items-center gap-3 shrink-0">
                                    {ticket.qrCodeDataUrl ? (
                                        <div className="bg-white p-3 rounded-xl shadow-lg">
                                            <img src={ticket.qrCodeDataUrl} alt="Ticket QR Code" width={140} height={140} style={{ display: 'block' }} />
                                        </div>
                                    ) : (
                                        <div className="w-36 h-36 bg-slate-700 rounded-xl flex items-center justify-center">
                                            <QrCode className="w-12 h-12 text-muted-foreground" />
                                        </div>
                                    )}
                                    <p className="text-xs text-muted-foreground text-center max-w-[160px]">Scan at entry for verification</p>
                                </div>
                                <div className="flex-1 space-y-4">
                                    <div className="flex items-center gap-2">
                                        <ShieldCheck className="w-5 h-5 text-indigo-400" />
                                        <span className="font-semibold">Verification URL</span>
                                    </div>
                                    <p className="font-mono text-xs text-indigo-300 break-all">{ticket.verificationUrl}</p>
                                    <div className="border-t border-slate-700/50 pt-4 space-y-1">
                                        <p className="text-xs text-muted-foreground">
                                            <strong className="text-foreground">Ticket ID:</strong>{' '}
                                            <span className="font-mono">{ticket.ticketId}</span>
                                        </p>
                                        {ticket.paymentRef && (
                                            <p className="text-xs text-muted-foreground">
                                                <strong className="text-foreground">Ref:</strong>{' '}
                                                <span className="font-mono">{ticket.paymentRef}</span>
                                            </p>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                        This ticket is non-transferable and valid for one-time entry only.
                                        For support, contact SEDS Pakistan via the official website.
                                        © SEDS Pakistan {new Date().getFullYear()}
                                    </p>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>

            {/* ── Pixel-perfect print CSS ──────────────────────────────────────── */}
            <style>{`
        @media print {
          body * { visibility: hidden; }
          .ticket-wrapper, .ticket-wrapper * {
            visibility: visible;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .ticket-wrapper {
            position: fixed;
            left: 0; top: 0;
            width: 100%;
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          .ticket-front, .ticket-back, .ticket-perforation {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
            page-break-after: avoid !important;
          }
          .ticket-front  { background-color: #0f172a !important; color: white !important; border-radius: 16px 16px 0 0 !important; }
          .ticket-back   { background-color: #0f172a !important; color: white !important; border-radius: 0 0 16px 16px !important; }
          .ticket-perforation { background: white !important; height: 24px; }
          @page { margin: 8mm; size: A4 portrait; }
        }
      `}</style>
        </>
    );
}
