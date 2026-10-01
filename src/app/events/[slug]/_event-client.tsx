'use client';

import { Suspense, useMemo, useState, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { hasSufficientRole, type UserRole } from '@/lib/roles';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useDoc, useFirestore } from '@/firebase';
import { doc } from 'firebase/firestore';
import Link from 'next/link';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import Image from 'next/image';
import {
    Rocket, Target, Clock, Users, MapPin, Calendar,
    Award, Quote, ExternalLink, Sparkles, Shield,
    Tag, Globe, Zap, Star, ChevronRight
} from 'lucide-react';
import EventCTA from '@/components/events/event-cta';
import ShareButton from '@/components/events/share-button';
import RegistrationDeadlineCountdown from '@/components/events/registration-deadline-countdown';
import { getProduct } from '@/app/actions/store';

function formatDateSafe(date: any) {
    try {
        if (!date) return 'Date: TBD';
        if (date?.seconds) return format(new Date(date.seconds * 1000), 'MMMM d, yyyy • h:mm a');
        return format(new Date(date), 'MMMM d, yyyy • h:mm a');
    } catch {
        return 'Date: TBD';
    }
}

const DynamicImage = ({ src, alt, className }: { src?: string; alt: string; className?: string }) => {
    const [imageSrc, setImageSrc] = useState(src || '');
    const [hasError, setHasError] = useState(false);

    useEffect(() => {
        setImageSrc(src || '');
        setHasError(false);
    }, [src]);

    if (!imageSrc || hasError) {
        return (
            <div className={`bg-gradient-to-br from-primary/20 to-blue-500/20 flex items-center justify-center ${className}`}>
                <div className="text-center">
                    <Rocket className="w-16 h-16 text-primary/60 mx-auto mb-3" />
                    <p className="text-primary/60 text-base font-medium">Event Image</p>
                </div>
            </div>
        );
    }

    return (
        <div className={className || "relative w-full h-full min-h-[400px]"}>
            <Image
                src={imageSrc}
                alt={alt}
                fill
                priority
                className="object-cover"
                sizes="100vw"
                onError={() => setHasError(true)}
            />
        </div>
    );
};

const EventCountdown = ({ event }: { event: any }) => {
    const [timeLeft, setTimeLeft] = useState('');

    useEffect(() => {
        if (!event.startAt) return;
        const calculate = () => {
            const eventDate = event.startAt?.seconds
                ? new Date(event.startAt.seconds * 1000)
                : new Date(event.startAt);
            const diff = eventDate.getTime() - Date.now();
            if (diff > 0) {
                const d = Math.floor(diff / 86400000);
                const h = Math.floor((diff % 86400000) / 3600000);
                setTimeLeft(`${d}d ${h}h remaining`);
            } else {
                setTimeLeft('Event Started');
            }
        };
        calculate();
        const t = setInterval(calculate, 60000);
        return () => clearInterval(t);
    }, [event.startAt]);

    if (!timeLeft) return null;
    return (
        <div className="flex items-center gap-2 text-sm text-primary font-bold bg-primary/10 px-3 py-1.5 rounded-full border border-primary/20">
            <Clock className="w-4 h-4 animate-pulse" />
            <span>{timeLeft}</span>
        </div>
    );
};

// ── Persuasive copy blocks — only shown if admin filled them in ────────────────
const PersuasiveCopySection = ({ event }: { event: any }) => {
    const vp = event.valueProposition;
    const cs = event.catalystStatement;
    const lo = event.lifestyleOutcome;

    if (!vp && !cs && !lo) return null;

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {vp && (
                <div className="bg-card/50 backdrop-blur-sm rounded-2xl border border-white/8 p-6 flex flex-col gap-3">
                    <div className="flex items-center gap-2 text-primary">
                        <Zap className="w-5 h-5 shrink-0" />
                        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">What You Gain</span>
                    </div>
                    <p className="text-base text-foreground leading-relaxed">{vp}</p>
                </div>
            )}
            {cs && (
                <div className="bg-card/50 backdrop-blur-sm rounded-2xl border border-white/8 p-6 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <Star className="w-5 h-5 shrink-0 text-yellow-400" />
                        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Why Act Now</span>
                    </div>
                    <p className="text-base text-foreground leading-relaxed">{cs}</p>
                </div>
            )}
            {lo && (
                <div className="bg-card/50 backdrop-blur-sm rounded-2xl border border-white/8 p-6 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <ChevronRight className="w-5 h-5 shrink-0 text-green-400" />
                        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">After This Event</span>
                    </div>
                    <p className="text-base text-foreground leading-relaxed">{lo}</p>
                </div>
            )}
        </div>
    );
};

// ── Strategic Framing — only shown if admin filled relevant Firestore fields ───
// IMPORTANT: Only render from actual event data. Zero hardcoded fallback strings.
const StrategicFramingSection = ({ event }: { event: any }) => {
    const sf = event.strategicFraming;
    if (!sf) return null;

    const headline = sf.lifestyleTargetHeadline;
    const examples: string[] = sf.lifestyleTargetExamples || [];
    const incomeStatement = sf.incomeVehicleStatement;
    const emotional = sf.emotionalFraming || {};
    const mindset = sf.mindsetFraming || {};

    const hasContent = headline || examples.length > 0 || incomeStatement ||
        emotional.costOfInactionStatement || emotional.freedomMetricsStatement || emotional.socialImpactStatement ||
        mindset.characterAmplifierStatement || mindset.contributionCapacityStatement || mindset.actionOverCriticismStatement;

    if (!hasContent) return null;

    return (
        <div className="space-y-8">
            {headline && (
                <div className="bg-card/40 backdrop-blur-xl rounded-3xl border border-white/5 p-6 md:p-10 shadow-2xl">
                    <Badge variant="outline" className="mb-5 border-primary/30 text-primary bg-primary/10 px-4 py-1.5 text-xs font-bold tracking-widest uppercase">
                        <Target className="w-3.5 h-3.5 mr-2" />The Objective
                    </Badge>
                    <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">{headline}</h2>
                    {incomeStatement && (
                        <p className="text-base text-foreground/80 leading-relaxed">{incomeStatement}</p>
                    )}
                    {examples.length > 0 && (
                        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {examples.map((ex: string, i: number) => (
                                <div key={i} className="flex items-start gap-3 bg-white/3 rounded-xl p-3">
                                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                                    <span className="text-sm text-foreground/80 leading-relaxed">{ex}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {(emotional.costOfInactionStatement || emotional.freedomMetricsStatement || emotional.socialImpactStatement) && (
                <div className="bg-card/40 backdrop-blur-xl rounded-3xl border border-white/5 p-6 md:p-10 shadow-2xl">
                    <h3 className="text-xl font-bold text-foreground mb-6">Key Insights</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {emotional.costOfInactionStatement && (
                            <div className="bg-white/3 rounded-2xl p-5">
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">The Reality</p>
                                <p className="text-base text-foreground/90 leading-relaxed">{emotional.costOfInactionStatement}</p>
                            </div>
                        )}
                        {emotional.freedomMetricsStatement && (
                            <div className="bg-white/3 rounded-2xl p-5">
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">The Benchmark</p>
                                <p className="text-base text-foreground/90 leading-relaxed">{emotional.freedomMetricsStatement}</p>
                            </div>
                        )}
                        {emotional.socialImpactStatement && (
                            <div className="bg-white/3 rounded-2xl p-5">
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Why This Matters</p>
                                <p className="text-base text-foreground/90 leading-relaxed">{emotional.socialImpactStatement}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {(mindset.characterAmplifierStatement || mindset.contributionCapacityStatement || mindset.actionOverCriticismStatement) && (
                <div className="bg-card/40 backdrop-blur-xl rounded-3xl border border-white/5 p-6 md:p-10 shadow-2xl">
                    <h3 className="text-xl font-bold text-foreground mb-6">Execution Mindset</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {mindset.characterAmplifierStatement && (
                            <div className="bg-white/3 rounded-2xl p-5">
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">The Core Engine</p>
                                <p className="text-base text-foreground/90 leading-relaxed">{mindset.characterAmplifierStatement}</p>
                            </div>
                        )}
                        {mindset.contributionCapacityStatement && (
                            <div className="bg-white/3 rounded-2xl p-5">
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">The Mission</p>
                                <p className="text-base text-foreground/90 leading-relaxed">{mindset.contributionCapacityStatement}</p>
                            </div>
                        )}
                        {mindset.actionOverCriticismStatement && (
                            <div className="bg-white/3 rounded-2xl p-5">
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Required Mindset</p>
                                <p className="text-base text-foreground/90 leading-relaxed">{mindset.actionOverCriticismStatement}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── Main event client page ───────────────────────────────────────────────────
export function EventClientPage() {
    const { user, role } = useUser();
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const slug = (params as { slug?: string })?.slug;
    const firestore = useFirestore();

    const eventDocRef = useMemo(() => {
        if (!slug) return null;
        return doc(firestore, 'events', slug);
    }, [firestore, slug]);

    const { data: event, loading } = useDoc(eventDocRef);

    // Fetch linked Store product to get the REAL price (event.paymentDetails can be stale)
    const [storeProduct, setStoreProduct] = useState<{ price: number; currency: string } | null>(null);
    useEffect(() => {
        const pid = (event as any)?.productId || (event as any)?.linkedStoreProductId;
        if (!pid) return;
        getProduct(pid).then(res => {
            if (res.success && res.data) {
                setStoreProduct({ price: res.data.price, currency: res.data.currency || 'PKR' });
            }
        }).catch(() => {/* silently ignore */ });
    }, [(event as any)?.productId, (event as any)?.linkedStoreProductId]);

    const parsedDescription = useMemo(() => {
        if (!event?.description) return null;
        return { sanitized: DOMPurify.sanitize(event.description) };
    }, [event?.description]);

    const isAdmin = !!role && hasSufficientRole(role as UserRole, 'chair_events');
    const authorUid = (event as any)?.authorUid ?? (event as any)?.createdByUid ?? (event as any)?.createdBy;
    const canEdit = !!user && (authorUid === user.uid || isAdmin);

    // ── ENGINE 3: Auto-trigger checkout when returning from auth with ?action=checkout ──
    useEffect(() => {
        if (!user || !event || loading) return;
        if (searchParams.get('action') !== 'checkout') return;

        const storeProductId = (event as any).linkedStoreProductId || (event as any).productId;
        const eventId = (event as any).id || slug;

        const targetHref = storeProductId
            ? `/checkout?productId=${storeProductId}&eventId=${eventId}&type=product`
            : `/events/register?eventId=${eventId}`;

        router.replace(targetHref);
    }, [user, event, loading, searchParams, router, slug]);

    if (loading) {
        return (
            <div className="relative flex min-h-screen flex-col items-center justify-center">
                <StarryBackground />
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
                    <p className="text-lg text-muted-foreground">Loading event...</p>
                </div>
            </div>
        );
    }

    const isPublished = !!event && (event.status === 'published' || event.published === true);
    const isDeleted = !!event && event.deleted === true;

    if (!event || !isPublished || isDeleted) {
        return (
            <div className="relative flex min-h-screen flex-col">
                <StarryBackground />
                <main className="flex-1 container mx-auto py-8 px-4">
                    <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-2xl mx-auto">
                        <CardContent className="py-12 text-center">
                            <h2 className="text-2xl font-bold mb-4">Event Not Found</h2>
                            <p className="text-muted-foreground mb-6">This event does not exist or is not published.</p>
                            <Button asChild><Link href="/events">Back to Events</Link></Button>
                        </CardContent>
                    </Card>
                </main>
                <Footer />
            </div>
        );
    }

    // Build share URL for ShareButton
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '');
    const shareUrl = `${appUrl}/events/${(event as any).slug || (event as any).id || slug}`;
    const shareDescription = (event as any).description
        ? DOMPurify.sanitize((event as any).description).replace(/<[^>]+>/g, '').slice(0, 120)
        : '';

    const tags: string[] = (event as any).tags || [];
    const endAt = (event as any).endAt;
    const venue = (event as any).venue;
    const isOnline = (event as any).isOnline;

    return (
        <div className="relative flex min-h-screen flex-col bg-background selection:bg-primary/30">
            {/* ── HERO BANNER ── */}
            <div className="relative w-full h-[40vh] md:h-[50vh] flex items-end justify-start overflow-hidden border-b border-white/5">
                {((event as any).imageUrl || (event as any).bannerImage) ? (
                    <>
                        <DynamicImage
                            src={(event as any).imageUrl || (event as any).bannerImage}
                            alt={(event as any).title || 'Event'}
                            className="absolute inset-0 w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-transparent z-10" />
                    </>
                ) : (
                    <>
                        <StarryBackground />
                        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent z-10" />
                    </>
                )}

                <div className="relative z-20 container mx-auto px-4 pb-12 max-w-7xl">
                    <Badge variant="secondary" className="mb-4 bg-primary/20 text-primary hover:bg-primary/30 border-0 pointer-events-none text-sm font-semibold">
                        {(event as any).type || 'Event'}
                    </Badge>
                    <h1 className="text-4xl md:text-5xl lg:text-7xl font-extrabold tracking-tight text-white drop-shadow-md leading-tight">
                        {(event as any).title}
                    </h1>
                </div>
            </div>

            {isAdmin && (
                <div className="bg-yellow-400/10 border-b border-yellow-400/30 py-2 px-4 relative z-50">
                    <div className="container mx-auto max-w-7xl">
                        <p className="text-yellow-200 text-xs font-semibold uppercase tracking-wider text-center flex items-center justify-center gap-2">
                            <Shield className="w-3 h-3" /> Admin Preview View active
                        </p>
                    </div>
                </div>
            )}

            <main className="flex-1 w-full bg-background relative z-20">
                <div className="container mx-auto max-w-7xl px-4 py-12 md:py-16">
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

                        {/* ── LEFT COLUMN (CONTENT) ── */}
                        <div className="lg:col-span-8 space-y-10">

                            {/* Subtitle / Tagline */}
                            {(event as any).subtitle && (
                                <p className="text-xl md:text-2xl text-foreground/80 font-light leading-relaxed border-l-4 border-primary/50 pl-6 py-2">
                                    {(event as any).subtitle}
                                </p>
                            )}

                            {/* Tags */}
                            {tags.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {tags.map((tag: string, i: number) => (
                                        <Badge key={i} variant="outline" className="border-white/15 text-foreground/70 bg-white/5 text-sm px-3 py-1 gap-1.5">
                                            <Tag className="w-3 h-3" />{tag}
                                        </Badge>
                                    ))}
                                </div>
                            )}

                            {/* ── ABOUT THIS EVENT (Main Description) ── */}
                            <div className="bg-card/40 backdrop-blur-xl rounded-3xl border border-white/5 p-6 md:p-10 shadow-2xl">
                                <h2 className="text-2xl md:text-3xl font-bold mb-8 flex items-center gap-3 text-foreground">
                                    <Target className="w-7 h-7 text-primary shrink-0" />
                                    About This Event
                                </h2>
                                {parsedDescription ? (
                                    <div
                                        className="event-description"
                                        dangerouslySetInnerHTML={{ __html: parsedDescription.sanitized }}
                                    />
                                ) : (
                                    <p className="text-base text-foreground/70">No description provided.</p>
                                )}
                            </div>

                            {/* ── PERSUASIVE COPY BLOCKS (Value, Catalyst, Lifestyle) ── */}
                            <PersuasiveCopySection event={event} />

                            {/* ── STRATEGIC FRAMING (only data-driven, no hardcoded text) ── */}
                            <StrategicFramingSection event={event} />

                            {/* ── LOCATION MAP ── */}
                            {(event as any).mapUrl && (
                                <div className="bg-card/40 backdrop-blur-xl rounded-3xl border border-white/5 p-6 md:p-10 shadow-2xl">
                                    <h2 className="text-2xl md:text-3xl font-bold mb-8 flex items-center gap-3 text-foreground">
                                        <MapPin className="w-7 h-7 text-primary shrink-0" />
                                        Location
                                    </h2>
                                    <div className="w-full h-[350px] rounded-2xl overflow-hidden border border-white/10 bg-slate-950 relative">
                                        {(event as any).mapUrl.includes('<iframe') ? (
                                            <div className="w-full h-full [&>iframe]:w-full [&>iframe]:h-full [&>iframe]:border-0" dangerouslySetInnerHTML={{ __html: (event as any).mapUrl }} />
                                        ) : (event as any).mapUrl.includes('google.com/maps') ? (
                                            <iframe
                                                src={(event as any).mapUrl}
                                                width="100%"
                                                height="100%"
                                                style={{ border: 0 }}
                                                allowFullScreen
                                                loading="lazy"
                                                referrerPolicy="no-referrer-when-downgrade"
                                            />
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full text-center p-6 space-y-4">
                                                <MapPin className="w-14 h-14 text-muted-foreground" />
                                                <p className="text-base text-foreground/70">Location mapped via external link.</p>
                                                <Button asChild variant="outline" className="rounded-xl text-base">
                                                    <a href={(event as any).mapUrl} target="_blank" rel="noopener noreferrer">
                                                        View on Map <ExternalLink className="w-4 h-4 ml-2" />
                                                    </a>
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                    {venue && (
                                        <p className="mt-4 text-base text-foreground/70 flex items-center gap-2">
                                            <MapPin className="w-4 h-4 text-primary shrink-0" />
                                            {venue}
                                        </p>
                                    )}
                                </div>
                            )}

                        </div>

                        {/* ── RIGHT COLUMN (STICKY REGISTRATION CARD) ── */}
                        <div className="lg:col-span-4 lg:sticky lg:top-28 space-y-6">
                            <Card className="bg-card/80 backdrop-blur-2xl border-white/10 shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)] overflow-hidden rounded-3xl">
                                <CardContent className="p-0">
                                    {/* Price Header */}
                                    <div className="bg-gradient-to-br from-primary/10 to-transparent border-b border-white/5 p-8 relative overflow-hidden">
                                        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 blur-[50px] rounded-full -mr-10 -mt-10 pointer-events-none" />
                                        {((event as any).paymentDetails?.isPaid || (event as any).productId) ? (
                                            <div className="flex flex-col gap-2 relative z-10">
                                                <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Registration Tier</span>
                                                <span className="text-4xl font-extrabold text-foreground tracking-tight">
                                                    {storeProduct
                                                        ? `${storeProduct.currency} ${storeProduct.price.toLocaleString()}`
                                                        : `${(event as any).paymentDetails?.currency || 'PKR'} ${(event as any).paymentDetails?.amount || 0}`
                                                    }
                                                </span>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col gap-2 relative z-10">
                                                <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Access</span>
                                                <span className="text-4xl font-extrabold text-green-400 tracking-tight flex items-center gap-2">
                                                    Free <Sparkles className="w-6 h-6" />
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    <div className="p-8 space-y-6">
                                        <div className="flex flex-col gap-5">
                                            {/* Date & Time */}
                                            <div className="flex items-start gap-4">
                                                <div className="bg-primary/10 p-3 rounded-2xl shrink-0"><Calendar className="w-5 h-5 text-primary" /></div>
                                                <div className="min-w-0">
                                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                                                        {endAt ? 'Start Date' : 'Date & Time'}
                                                    </p>
                                                    <p className="text-sm text-foreground font-medium leading-relaxed">{formatDateSafe((event as any).startAt || (event as any).date)}</p>
                                                    {endAt && (
                                                        <>
                                                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 mt-3">End Date</p>
                                                            <p className="text-sm text-foreground font-medium leading-relaxed">{formatDateSafe(endAt)}</p>
                                                        </>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Location */}
                                            <div className="flex items-start gap-4">
                                                <div className="bg-primary/10 p-3 rounded-2xl shrink-0">
                                                    {isOnline ? <Globe className="w-5 h-5 text-primary" /> : <MapPin className="w-5 h-5 text-primary" />}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                                                        {isOnline ? 'Format' : 'Location'}
                                                    </p>
                                                    <p className="text-sm text-foreground font-medium leading-relaxed">
                                                        {isOnline ? 'Online Event' : ((event as any).location || 'TBA')}
                                                    </p>
                                                    {venue && !isOnline && (
                                                        <p className="text-xs text-muted-foreground mt-0.5">{venue}</p>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Capacity */}
                                            {(event as any).capacity && (
                                                <div className="flex items-start gap-4">
                                                    <div className="bg-primary/10 p-3 rounded-2xl shrink-0"><Users className="w-5 h-5 text-primary" /></div>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Capacity</p>
                                                        <div className="flex items-baseline gap-1 mt-0.5">
                                                            <span className="text-xl font-bold text-foreground">{((event as any).attendeeIds?.length || (event as any).registered_attendees_uids?.length || 0)}</span>
                                                            <span className="text-sm text-muted-foreground font-medium">/ {(event as any).capacity} spots filled</span>
                                                        </div>
                                                        <div className="w-full h-1.5 bg-muted mt-2 rounded-full overflow-hidden">
                                                            <div className="h-full bg-primary" style={{ width: `${Math.min(100, (((event as any).attendeeIds?.length || (event as any).registered_attendees_uids?.length || 0) / ((event as any).capacity || 1)) * 100)}%` }} />
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Registration Deadline Countdown */}
                                        {(event as any).registrationDeadline && (
                                            <div className="pt-2 border-t border-white/5">
                                                <RegistrationDeadlineCountdown deadline={(event as any).registrationDeadline} compact />
                                            </div>
                                        )}

                                        {/* Event Countdown */}
                                        <div>
                                            <EventCountdown event={event} />
                                        </div>

                                        {/* CTAs */}
                                        <div className="pt-4 border-t border-white/5 space-y-3">
                                            <EventCTA event={event as any} size="lg" className="w-full text-base font-bold shadow-xl h-14 rounded-xl" />
                                            <ShareButton url={shareUrl} title={(event as any).title || 'SEDS Event'} description={shareDescription} className="w-full h-12 rounded-xl" variant="outline" />
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            {isAdmin && (
                                <Button asChild variant="outline" className="w-full h-12 rounded-xl border-dashed border-white/20 text-muted-foreground hover:text-white bg-transparent">
                                    <Link href={`/admin/events/edit?id=${(event as any).id}`}>
                                        <Award className="w-4 h-4 mr-2" /> Edit Event Parameters
                                    </Link>
                                </Button>
                            )}
                        </div>

                    </div>
                </div>
            </main>
            <Footer />
        </div>
    );
}

// ─── Suspense wrapper ─────────────────────────────────────────────────────────
export default function EventClientPageWrapper() {
    return (
        <Suspense fallback={
            <div className="relative flex min-h-screen flex-col items-center justify-center">
                <StarryBackground />
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
                    <p className="text-lg text-muted-foreground">Loading event...</p>
                </div>
            </div>
        }>
            <EventClientPage />
        </Suspense>
    );
}
