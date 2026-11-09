'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { collection, getDocs, query, where, getDoc, doc, getFirestore } from 'firebase/firestore';
import { formatEventInstantInPkt } from '@/lib/events/datetime';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Printer, ArrowLeft, QrCode, CheckCircle2, ShieldCheck, AlertTriangle, Calendar, MapPin, Download } from 'lucide-react';
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

// Ticket timestamps are stored instants; render them in Asia/Karachi like
// every other event surface (src/lib/events/datetime.ts), not viewer-local.
function safeDate(ts: any): string {
    return formatEventInstantInPkt(ts, 'weekdayLong') ?? 'TBD';
}

function safeIssuedDate(ts: any): string {
    return formatEventInstantInPkt(ts, 'date') ?? '';
}

// ─── Seeded star chart ────────────────────────────────────────────────────────
// The ticket's own sky: a sparse printed-chart field in the same family as
// the site starfield (src/components/layout/starfield.tsx) — same mulberry32
// generator, seeded per ticket so a given ticket always carries the same
// chart. Pure SVG, no client JS cost beyond render.
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function TicketStarChart({ seed, count = 52, faint = false, cover = 1 }: { seed: number; count?: number; faint?: boolean; cover?: number }) {
    const rnd = mulberry32(seed);
    const W = 750, H = 360;
    const stars = Array.from({ length: count }, () => {
        const band = rnd();
        return {
            x: Math.round(rnd() * W * 10) / 10,
            y: Math.round(rnd() * H * 10) / 10,
            r: band < 0.72 ? 0.7 + rnd() * 0.4 : band < 0.95 ? 1.1 + rnd() * 0.4 : 1.6 + rnd() * 0.3,
            o: (band < 0.72 ? 0.16 + rnd() * 0.18 : band < 0.95 ? 0.3 + rnd() * 0.2 : 0.45 + rnd() * 0.2) * (faint ? 0.55 : 1),
        };
    });
    // One short constellation chain through the brightest stars. Links are
    // distance-capped: an uncapped nearest-neighbour walk spans the whole
    // panel at ticket scale and reads as a crack, not a chart figure.
    const bright = [...stars].sort((a, b) => b.o - a.o).slice(0, 9);
    const chainPts: string[] = [];
    let current = bright[0];
    const pool = new Set(bright.slice(1));
    for (let link = 0; link < 3 && current; link++) {
        chainPts.push(`${current.x},${current.y}`);
        let best: typeof current | undefined; let bestD = Infinity;
        pool.forEach((s) => { const d = Math.hypot(s.x - current.x, s.y - current.y); if (d < bestD) { bestD = d; best = s; } });
        if (!best || bestD > 190) break;
        pool.delete(best); current = best;
    }
    if (chainPts.length < 3) chainPts.length = 0;
    // No plus-tick markers here: the chart is sliced at whatever width the
    // ticket renders (screen 750px, print full page), so a tick's landing
    // spot cannot be kept clear of the text it would strike through.
    // `cover` < 1 confines the chart to the top band of the panel (fading
    // out at its lower edge) so body-text zones sit on clean navy.
    return (
        <svg
            className="absolute left-0 top-0 w-full pointer-events-none"
            style={{
                height: `${cover * 100}%`,
                WebkitMaskImage: cover < 1 ? 'linear-gradient(to bottom, black 62%, transparent 98%)' : undefined,
                maskImage: cover < 1 ? 'linear-gradient(to bottom, black 62%, transparent 98%)' : undefined,
            }}
            viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            {chainPts.length > 1 && (
                <polyline points={chainPts.join(' ')} fill="none" stroke="hsl(var(--star-on-panel) / 0.16)" strokeWidth="1" />
            )}
            {stars.map((s, i) => (
                <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="hsl(var(--star-on-panel))" fillOpacity={s.o} />
            ))}
        </svg>
    );
}

// ─── Status seal ──────────────────────────────────────────────────────────────
// A stamped ring, not a pill: double-ring circle, slight rotation, semantic
// colour only (green valid / red revoked per DESIGN.md status rules).
function StatusSeal({ status }: { status: 'valid' | 'revoked' }) {
    const valid = status === 'valid';
    return (
        <div
            className={`rounded-full flex items-center justify-center ${valid ? 'text-green-400' : 'text-red-400'}`}
            style={{
                width: 88, height: 88, transform: 'rotate(-10deg)',
                border: '2px solid currentColor',
                boxShadow: 'inset 0 0 0 3px #0f172a, inset 0 0 0 4.5px currentColor',
            }}
            role="img"
            aria-label={valid ? 'Ticket valid' : 'Ticket revoked'}
        >
            <div className="flex flex-col items-center gap-1">
                {valid ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                <span className="font-accent text-[11px] font-semibold" style={{ letterSpacing: '0.22em' }}>
                    {valid ? 'VALID' : 'REVOKED'}
                </span>
            </div>
        </div>
    );
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
        'superadmin', 'founder_patron', 'president_national', 'president_chapter', 'vice_president',
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
                // SUPABASE MIGRATION (E3): this read intentionally stays on the
                // client Firestore SDK in this pass. The Supabase adapter
                // (src/lib/supa) is server-only — it authenticates with the
                // service_role key and must never ship in a client bundle —
                // and no existing server endpoint serves an authenticated
                // ticket read. The endpoint this page needs is specified in
                // supabase-migration/events-cluster/MANUAL_LIST.md (E3-CLIENT-1).
                // H-04 is also preserved here: Strategy 1 reads BY DOC ID,
                // Strategy 2 by the `ticketId` FIELD — do not unify.
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
            <div className="min-h-screen flex items-center justify-center bg-card">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
                    <p className="text-muted-foreground">Loading your ticket…</p>
                </div>
            </div>
        );
    }

    if (error || !ticket) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-card">
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
            <div className="print:hidden bg-card">
                <div className="max-w-3xl mx-auto px-4 py-8">
                    <div className="flex items-center justify-between gap-3 mb-6">
                        <Button variant="outline" size="sm" onClick={() => router.back()} className="border-border text-muted-foreground hover:text-foreground shrink-0">
                            <ArrowLeft className="w-4 h-4 mr-2" /> Back
                        </Button>
                        {/* Slim ticket header strip: id readout + status chip */}
                        <div className="hidden md:flex flex-col items-center text-center min-w-0">
                            <span className="font-accent text-[9px] uppercase text-muted-foreground" style={{ letterSpacing: '0.3em' }}>Ticket</span>
                            <span className="font-code text-sm text-foreground truncate">{ticket.ticketId}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <span className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-accent text-[10px] font-semibold ${ticket.status === 'valid' ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400' : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'}`} style={{ letterSpacing: '0.18em' }}>
                                {ticket.status === 'valid' ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                                {ticket.status === 'valid' ? 'VALID' : 'REVOKED'}
                            </span>
                            <Button variant="outline" size="sm" onClick={() => window.print()} className="border-border text-muted-foreground hover:text-foreground">
                                <Printer className="w-4 h-4 mr-2" /> Print / Save PDF
                            </Button>
                            {ticket.uniqueTicketUrl && (
                                <a href={ticket.uniqueTicketUrl} download={`SEDS-Ticket-${ticket.ticketId}.png`} target="_blank" rel="noopener noreferrer">
                                    <Button size="sm" className="bg-primary text-black hover:bg-primary/90 font-bold">
                                        <Download className="w-4 h-4 mr-2" /> Download PNG
                                    </Button>
                                </a>
                            )}
                        </div>
                    </div>

                    {ticket.status === 'revoked' && (
                        <div className="mb-6 p-4 bg-red-900/40 border border-red-500/50 rounded-xl flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
                            <span className="text-red-300 font-semibold">This ticket has been revoked and is no longer valid.</span>
                        </div>
                    )}

                    <p className="text-muted-foreground text-sm text-center mb-8 font-body">
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
                                    <Download className="w-4 h-4 mr-2" /> Download High-Res
                                </Button>
                            </a>
                        </div>
                    </div>
                    <p className="font-accent text-[10px] uppercase text-muted-foreground text-center mt-3" style={{ letterSpacing: '0.3em' }}>Premium Commemorative Ticket</p>
                    <div className="mt-8 mb-4 flex items-center gap-4">
                        <div className="flex-1 h-px bg-muted/50" />
                        <span className="font-accent text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.3em' }}>Standard Printable Ticket</span>
                        <div className="flex-1 h-px bg-muted/50" />
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════════════ */}
            {/*            UNIFIED PRINT TICKET — NO FRAGMENTATION              */}
            {/* ════════════════════════════════════════════════════════════════ */}
            <div className="print:block flex justify-center items-start pb-16 bg-card min-h-screen print:min-h-0 print:pb-0 print:m-0 print:bg-white">
                <div
                    ref={containerRef}
                    className="ticket-wrapper w-full max-w-[750px] mx-auto shadow-2xl print:shadow-none print:max-w-none"
                    style={{ fontFamily: "'Segoe UI', Arial, sans-serif", '--scale-factor': renderScale } as any}
                >
                    {/* ── FRONT ─────────────────────────────────────────────────── */}
                    <div
                        className="ticket-front relative overflow-hidden bg-card text-white"
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
                                                <span className="text-white font-black" style={{ fontSize: `${(cfg.size * 0.4) / 8}cqw` }}>S</span>
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

                        {/* Standard fallback (no custom template) — the premium
                            default artefact in the mission-control HUD language:
                            seeded star chart, coral rule, Bebas title, Courier
                            data, instrument rail with the number readout and a
                            stamped status seal. */}
                        {!hasCustomFront && (
                            <div className="relative font-body text-white">
                                <TicketStarChart seed={20260301 + (ticket.ticketNumber || 0)} cover={0.52} />
                                {ticket.status === 'revoked' && (
                                    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" aria-hidden="true">
                                        <span className="font-headline text-red-500/50 border-[3px] border-red-500/40 rounded-md px-8 py-1" style={{ fontSize: 64, letterSpacing: '0.18em', transform: 'rotate(-11deg)' }}>
                                            REVOKED
                                        </span>
                                    </div>
                                )}
                                <div className="relative z-10 p-6 md:p-9 flex flex-col gap-5">
                                    {/* Org header */}
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex items-center gap-3.5">
                                            <img src="/assets/logo-header.png" alt="SEDS Pakistan" className="h-10 w-auto shrink-0 select-none" />
                                            <div>
                                                <p className="font-accent text-[13px] font-semibold text-white" style={{ letterSpacing: '0.24em' }}>SEDS PAKISTAN</p>
                                                <p className="font-code text-[10.5px] text-white/50 mt-0.5">Students for the Exploration and Development of Space</p>
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0 hidden sm:block">
                                            <p className="font-accent text-[9px] text-white/55" style={{ letterSpacing: '0.3em' }}>OFFICIAL ENTRY PASS</p>
                                            <p className="font-code text-[10px] text-white/40 mt-1">{ticket.ticketId}</p>
                                        </div>
                                    </div>

                                    {/* The one coral rule */}
                                    <div className="h-[2px] bg-primary w-full" />

                                    {/* Title + meta */}
                                    <div>
                                        <h1 className="font-headline uppercase text-white" style={{ fontSize: 'clamp(34px, 6vw, 50px)', lineHeight: 0.98, letterSpacing: '0.02em' }}>
                                            {ticket.eventTitle}
                                        </h1>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 mt-5">
                                            <div className="flex items-center gap-3">
                                                <Calendar className="w-4 h-4 text-primary shrink-0" />
                                                <div>
                                                    <p className="font-accent text-[9px] text-white/50 mb-1" style={{ letterSpacing: '0.28em' }}>DATE</p>
                                                    <p className="font-code text-[15px] text-white leading-snug">{safeDate(ticket.eventDate)}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <MapPin className="w-4 h-4 text-primary shrink-0" />
                                                <div>
                                                    <p className="font-accent text-[9px] text-white/50 mb-1" style={{ letterSpacing: '0.28em' }}>VENUE</p>
                                                    <p className="font-code text-[15px] text-white leading-snug">{ticket.eventVenue || 'To Be Announced'}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Admitted + instrument rail */}
                                    <div className="flex flex-col md:flex-row gap-6 md:gap-0 pt-5" style={{ borderTop: '1px solid hsl(var(--star-on-panel) / 0.14)' }}>
                                        <div className="flex-1 min-w-0 md:pr-8">
                                            <p className="font-accent text-[9px] text-white/50 mb-1" style={{ letterSpacing: '0.3em' }}>ADMITTED</p>
                                            <p className="font-code font-bold text-white mt-2" style={{ fontSize: 21, lineHeight: 1.2 }}>{ticket.displayName}</p>
                                            {ticket.email && <p className="font-code text-[12.5px] text-white/55 mt-1 break-all">{ticket.email}</p>}
                                            <p className="font-code text-[11px] text-white/40 mt-4">
                                                Present this pass at entry. The QR code overleaf is scanned for verification.
                                            </p>
                                        </div>
                                        <div className="md:w-[176px] shrink-0 md:border-l md:pl-7 flex md:flex-col items-center md:items-center justify-between md:justify-start gap-4 md:gap-4 md:text-center" style={{ borderColor: 'hsl(var(--star-on-panel) / 0.14)' }}>
                                            <div className="text-center">
                                                <p className="font-accent text-[9px] text-white/50 mb-1" style={{ letterSpacing: '0.3em' }}>TICKET NO.</p>
                                                <p className="font-headline text-primary leading-none mt-1" style={{ fontSize: 56 }}>
                                                    #{ticket.ticketNumber.toString().padStart(3, '0')}
                                                </p>
                                            </div>
                                            <StatusSeal status={ticket.status} />
                                            <div className="text-center">
                                                <p className="font-accent text-[9px] text-white/50 mb-1" style={{ letterSpacing: '0.3em' }}>ISSUED</p>
                                                <p className="font-code text-[12px] text-white/75 mt-1">{safeIssuedDate(ticket.issuedAt)}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── PERFORATED JOINT — no gap on print ─────────────────────── */}
                    <div className="ticket-perforation flex items-center px-3 bg-card print:bg-white"
                        style={{ height: 24, borderLeft: '2px solid #1e293b', borderRight: '2px solid #1e293b' }}>
                        <div className="w-5 h-5 rounded-full bg-card print:bg-white -ml-6 border border-border shrink-0" />
                        <div className="flex-1 border-t-2 border-dashed border-border mx-2" />
                        <div className="w-5 h-5 rounded-full bg-card print:bg-white -mr-6 border border-border shrink-0" />
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
                            <div className="relative font-body text-white">
                                <TicketStarChart seed={20260308 + (ticket.ticketNumber || 0)} count={26} faint cover={0.6} />
                                <div className="relative z-10 p-6 md:p-9 flex flex-col items-center text-center gap-5">
                                    {/* Org strip */}
                                    <div className="w-full flex items-center justify-between gap-4">
                                        <div className="flex items-center gap-2.5">
                                            <img src="/assets/logo-header.png" alt="SEDS Pakistan" className="h-6 w-auto select-none" />
                                            <span className="font-accent text-[10px] font-semibold text-white" style={{ letterSpacing: '0.26em' }}>SEDS PAKISTAN</span>
                                        </div>
                                        <span className="font-accent text-[9px] text-white/50" style={{ letterSpacing: '0.3em' }}>VERIFY AT ENTRY</span>
                                    </div>

                                    {/* QR in its quiet-zone frame, coral corner ticks */}
                                    <div className="relative mt-1">
                                        <span className="absolute -top-[7px] -left-[7px] w-4 h-4 border-t-[3px] border-l-[3px] border-primary" aria-hidden="true" />
                                        <span className="absolute -top-[7px] -right-[7px] w-4 h-4 border-t-[3px] border-r-[3px] border-primary" aria-hidden="true" />
                                        <span className="absolute -bottom-[7px] -left-[7px] w-4 h-4 border-b-[3px] border-l-[3px] border-primary" aria-hidden="true" />
                                        <span className="absolute -bottom-[7px] -right-[7px] w-4 h-4 border-b-[3px] border-r-[3px] border-primary" aria-hidden="true" />
                                        <div className="bg-white p-[10px]" style={{ borderRadius: 10 }}>
                                            {ticket.qrCodeDataUrl ? (
                                                <img src={ticket.qrCodeDataUrl} alt="Ticket QR Code" width={150} height={150} style={{ display: 'block' }} />
                                            ) : (
                                                <div className="w-[150px] h-[150px] flex items-center justify-center">
                                                    <QrCode className="w-12 h-12 text-slate-400" />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <p className="font-accent text-[10px] text-white/60 -mt-1" style={{ letterSpacing: '0.3em' }}>SCAN AT ENTRY FOR VERIFICATION</p>

                                    {/* Verification URL */}
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="flex items-center gap-2">
                                            <ShieldCheck className="w-4 h-4 text-primary" />
                                            <span className="font-accent text-[10px] text-white/70" style={{ letterSpacing: '0.28em' }}>VERIFICATION URL</span>
                                        </div>
                                        <p className="font-code text-[11.5px] leading-relaxed text-white/90 break-all max-w-[540px]">{ticket.verificationUrl}</p>
                                    </div>

                                    {/* Record line */}
                                    <div className="w-full pt-4 flex flex-wrap items-start justify-center gap-x-10 gap-y-2" style={{ borderTop: '1px solid hsl(var(--star-on-panel) / 0.14)' }}>
                                        <p className="font-code text-[11px] text-white/60">
                                            <span className="font-accent text-[9px] text-white/45 block mb-0.5" style={{ letterSpacing: '0.28em' }}>TICKET ID</span>
                                            {ticket.ticketId}
                                        </p>
                                        {ticket.paymentRef && (
                                            <p className="font-code text-[11px] text-white/60">
                                                <span className="font-accent text-[9px] text-white/45 block mb-0.5" style={{ letterSpacing: '0.28em' }}>REF</span>
                                                {ticket.paymentRef}
                                            </p>
                                        )}
                                    </div>

                                    {/* Fine print + sign-off */}
                                    <p className="text-[10.5px] leading-relaxed text-white/45 max-w-[560px]">
                                        This ticket is non-transferable and valid for one-time entry only.
                                        For support, contact SEDS Pakistan via the official website.
                                    </p>
                                    <p className="font-code text-[10px] text-white/40 -mt-2">
                                        © SEDS Pakistan {new Date().getFullYear()} · Students for the Exploration and Development of Space
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
