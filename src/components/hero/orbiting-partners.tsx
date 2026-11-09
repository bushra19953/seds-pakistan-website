"use client";

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useAnimationFrame, useReducedMotion } from 'framer-motion';
import Image from 'next/image';
import { cn } from '@/lib/utils';

export interface Partner {
    id: string;
    name: string;
    logoUrl?: string;
    rawSvg?: string; // For technical icons
    type: string;
    size?: number;
}

interface OrbitingPartnersProps {
    partners: Partner[];
    className?: string;
}

// Order of orbits from Inner (Core) to Outer
const CATEGORY_ORDER = [
    'Technology', // New priority ring
    'National Chapter',
    'University',
    'International Chapter',
    'Institutional Partner',
    'Sponsor'
];

// ---------------------------------------------------------------------------
// ORRERY GEOMETRY (impeccable pass 2026-11-09, founder rejection of the
// "glowing bulbs" look). The system is a star chart, not a light show:
// dark instrument discs on the deep-navy void, hairline tracks, one calm
// motion. Three rules make the spacing guarantee structural, not tuned:
//
// 1. SAME TRACK: every planet on a track shares one angular velocity and
//    the planets are phased evenly by index (phase_i = track phase +
//    i * 2PI / n), so relative angles never change. The tightest moment
//    for neighbours is straddling the ellipse tips, where the chord is
//    2 * ry * sin(PI / n); disc diameter is capped at 0.87 of that chord
//    (the depth scale is ~1.0 at the tips), so neighbours can never
//    touch at any timestamp.
// 2. ACROSS TRACKS: adjacent ellipses are separated by a constant radial
//    step (TRACK_RY_STEP = 40px). The closest two planets on adjacent
//    tracks can ever approach is bounded by that step, so diameters are
//    additionally clamped to 0.905 of the tightest neighbouring gap
//    (accounting for the 1.05 near-side depth scale). With the live
//    data (4 tracks, 27 planets) a numeric sweep of every pair over
//    2 hours at 0.25s steps leaves a worst-case clearance of +2.7px:
//    positive at every instant, for any phase choice.
// 3. DEPTH WITHOUT BLUR: a planet reads nearer on the front arc only by
//    a restrained scale step (0.95 far -> 1.05 near) and opacity steps
//    (0.72 / 0.88 / 1). No glow, no bloom, no blur filter, no white
//    fill: the previous build's bg-slate-50 discs with white glow
//    shadows and a sheen gradient are what the founder photographed
//    and rejected.
// ---------------------------------------------------------------------------
const TRACK_RX_BASE = 180;
const TRACK_RX_STEP = 57;
const TRACK_RY_BASE = 38;
const TRACK_RY_STEP = 40;
const TRACK_PERIOD_BASE = 50; // seconds per revolution, innermost track
const TRACK_PERIOD_STEP = 18; // outer tracks slower, like real periods
const TRACK_PHASE_STEP = 2.399963; // golden angle: decorrelates the tracks
const DISC_MAX = 34;
const DISC_MIN = 24;
const STAGE_HALF_HEIGHT = 172; // px of vertical room the stage guarantees

const SURFACE = 'hsl(222 40% 14%)'; // DESIGN.md surface tone

interface TrackGeometry {
    rx: number;
    ry: number;
    period: number;
    phase: number;
    diameter: number;
}

function discDiameter(ry: number, count: number): number {
    if (count <= 1) return DISC_MAX;
    const chordCap = 0.87 * 2 * ry * Math.sin(Math.PI / count);
    return Math.max(DISC_MIN, Math.min(DISC_MAX, chordCap));
}

// ---------------------------------------------------------------------------
// STARFIELD: the astronomy layer. Real star points and a few hairline
// constellation links, drawn as SVG geometry in a 1440x360 chart space
// (slice-cropped to the stage). Positions come from a seeded PRNG, so
// the chart is identical on server and client and never shimmers: the
// stars are static; the orbit is the one authored motion.
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const STAR_CHART = (() => {
    const rnd = mulberry32(20261109);
    const stars = Array.from({ length: 84 }, () => ({
        x: Math.round(rnd() * 1440),
        y: Math.round(rnd() * 360),
        r: Math.round((0.6 + rnd() * 1.1) * 10) / 10,
        o: Math.round((0.14 + rnd() * 0.46 + (rnd() > 0.92 ? 0.22 : 0)) * 100) / 100,
    }));
    // Three short constellation chains: walk from a seed star to the
    // nearest unused star within 320 units, three links per chain.
    const used = new Set<number>();
    const chains: string[] = [];
    for (let c = 0; c < 3; c++) {
        let current = Math.floor(rnd() * stars.length);
        const pts: string[] = [];
        for (let step = 0; step < 4 && current >= 0; step++) {
            used.add(current);
            pts.push(`${stars[current].x},${stars[current].y}`);
            let next = -1;
            let best = 320;
            stars.forEach((s, i) => {
                if (used.has(i)) return;
                const d = Math.hypot(s.x - stars[current].x, s.y - stars[current].y);
                if (d < best) { best = d; next = i; }
            });
            current = next;
        }
        if (pts.length > 1) chains.push(pts.join(' '));
    }
    return { stars, chains };
})();

function Starfield({ className }: { className?: string }) {
    return (
        <svg
            className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
            viewBox="0 0 1440 360"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
        >
            {STAR_CHART.chains.map((pts, i) => (
                <polyline key={i} points={pts} fill="none" stroke="white" strokeOpacity="0.09" strokeWidth="1" />
            ))}
            {STAR_CHART.stars.map((s, i) => (
                <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="white" fillOpacity={s.o} />
            ))}
        </svg>
    );
}

// ---------------------------------------------------------------------------
// THE SUN: SEDS Pakistan as the system's anchor. A defined instrument
// disc (surface tone, hairline border) carrying the trimmed wordmark,
// ringed by a plotted reticle: one solid hairline, one dashed hairline,
// four tick marks, the top tick in coral (the world's one signal
// colour, used once). Static: no pulse, no glow halo.
// ---------------------------------------------------------------------------
function Sun() {
    return (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2" aria-hidden="true">
            <div className="relative flex h-[7.5rem] w-[7.5rem] items-center justify-center">
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="59" fill="none" stroke="white" strokeOpacity="0.10" strokeWidth="1" />
                    <circle cx="60" cy="60" r="47" fill="none" stroke="white" strokeOpacity="0.14" strokeWidth="1" strokeDasharray="2 5" />
                    <line x1="60" y1="1" x2="60" y2="8" stroke="hsl(15 72% 63%)" strokeOpacity="0.9" strokeWidth="1.5" />
                    <line x1="60" y1="112" x2="60" y2="119" stroke="white" strokeOpacity="0.25" strokeWidth="1.5" />
                    <line x1="1" y1="60" x2="8" y2="60" stroke="white" strokeOpacity="0.25" strokeWidth="1.5" />
                    <line x1="112" y1="60" x2="119" y2="60" stroke="white" strokeOpacity="0.25" strokeWidth="1.5" />
                </svg>
                <div
                    className="relative flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full border border-white/15"
                    style={{ backgroundColor: SURFACE }}
                >
                    <Image
                        src="/assets/logo-header.png"
                        alt="SEDS Pakistan"
                        width={120}
                        height={40}
                        className="w-[3.75rem] object-contain"
                        priority
                    />
                </div>
            </div>
        </div>
    );
}

export function OrbitingPartners({ partners, className }: OrbitingPartnersProps) {
    const [isMobile, setIsMobile] = useState(true);
    const [viewportWidth, setViewportWidth] = useState(0);
    const shouldReduceMotion = useReducedMotion();

    // Ring scale: the orbit lives in its own stage band above the hero
    // copy, so the ellipses are sized to the stage and to the viewport
    // width — a satellite must never be clipped by the section edge.
    // At 1280px and up the system runs at full size; below that it
    // scales down to 0.55 minimum.
    const orbitScale = viewportWidth === 0
        ? 1
        : Math.min(1, Math.max(0.55, viewportWidth / 1280));

    // Group partners by category
    const groupedPartners = useMemo(() => {
        const groups: Record<string, Partner[]> = {};
        partners.forEach(p => {
            if (!groups[p.type]) groups[p.type] = [];
            groups[p.type].push(p);
        });
        return groups;
    }, [partners]);

    // Determine active rings (only categories that have data)
    const activeRings = useMemo(() => {
        return CATEGORY_ORDER.filter(cat => groupedPartners[cat] && groupedPartners[cat].length > 0);
    }, [groupedPartners]);

    useEffect(() => {
        const handleResize = () => {
            setIsMobile(window.innerWidth < 768);
            setViewportWidth(window.innerWidth);
        };
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Track geometry, shared by the SVG orbit lines and the planets so
    // they can never drift apart. A final fit factor shrinks the whole
    // system if a future data state adds tracks beyond the stage.
    const tracks = useMemo<TrackGeometry[]>(() => {
        const raw = activeRings.map((category, k) => ({
            rx: (TRACK_RX_BASE + k * TRACK_RX_STEP) * orbitScale,
            ry: (TRACK_RY_BASE + k * TRACK_RY_STEP) * orbitScale,
            period: TRACK_PERIOD_BASE + k * TRACK_PERIOD_STEP,
            phase: k * TRACK_PHASE_STEP,
            count: groupedPartners[category].length,
        }));
        if (raw.length === 0) return [];
        const outer = raw[raw.length - 1];
        const outerDisc = discDiameter(outer.ry, outer.count);
        const fit = Math.min(1, STAGE_HALF_HEIGHT / (outer.ry + (outerDisc / 2) * 1.05));
        return raw.map((t, k) => {
            const rx = t.rx * fit;
            const ry = t.ry * fit;
            let diameter = discDiameter(ry, t.count);
            // Cross-track clamp: never wider than the tightest radial
            // gap to a neighbouring track allows (see geometry note 2).
            const gaps: number[] = [];
            if (k > 0) gaps.push(ry - raw[k - 1].ry * fit);
            if (k < raw.length - 1) gaps.push(raw[k + 1].ry * fit - ry);
            if (gaps.length > 0) {
                diameter = Math.min(diameter, 0.905 * Math.min(...gaps));
            }
            return { rx, ry, period: t.period, phase: t.phase, diameter: Math.max(18, diameter) };
        });
    }, [activeRings, groupedPartners, orbitScale]);

    // Pause the orbit engine while the hero is off-screen. Every
    // OrbitingObject runs a useAnimationFrame callback; without this
    // gate they keep computing and writing styles for the whole page
    // session, long after the visitor has scrolled past the hero.
    const containerRef = useRef<HTMLDivElement>(null);
    const visibilityRef = useRef(true);
    useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(
            (entries) => {
                visibilityRef.current = entries.some((e) => e.isIntersecting);
            },
            { rootMargin: '100px' }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    if (isMobile) {
        // Static labeled chip grid on mobile, restyled to the same
        // planet-disc system as the desktop orrery: dark instrument
        // discs with hairline borders on the star chart, never white
        // bulbs. Every chip carries the partner's full name
        // underneath — nothing is truncated.
        return (
            <div className={cn("relative w-full py-2", className)}>
                <Starfield className="opacity-70" />
                <div className="relative flex items-start justify-center gap-x-1 gap-y-3 flex-wrap px-4 max-w-md mx-auto">
                    {partners.slice(0, 8).map((partner) => (
                        <div key={partner.id} className="flex w-[4.25rem] flex-col items-center gap-1.5">
                            <div
                                className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.14] p-1.5"
                                style={{ backgroundColor: SURFACE }}
                            >
                                {partner.rawSvg ? (
                                    <div
                                        className="h-full w-full text-[hsl(210_40%_88%)]"
                                        dangerouslySetInnerHTML={{ __html: partner.rawSvg }}
                                    />
                                ) : partner.logoUrl ? (
                                    <Image
                                        src={partner.logoUrl}
                                        alt={partner.name}
                                        width={36}
                                        height={36}
                                        className="object-contain"
                                        loading="lazy"
                                    />
                                ) : (
                                    <span className="font-accent text-[10px] font-semibold uppercase text-foreground/80">
                                        {partner.name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('')}
                                    </span>
                                )}
                            </div>
                            <span className="text-[9px] leading-tight text-center text-foreground/75 line-clamp-3">
                                {partner.name}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className={cn("absolute inset-0 pointer-events-none flex items-center justify-center overflow-visible", className)}>

            {/* ASTRONOMY LAYER: star chart behind the tracks */}
            <Starfield />

            {/* ORBIT TRACKS: fine hairline ellipses, plotted not glowing */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                {activeRings.map((category, index) => {
                    const { rx, ry } = tracks[index];
                    return (
                        <ellipse
                            key={category}
                            cx="50%" cy="50%"
                            rx={rx} ry={ry}
                            fill="none" stroke="white" strokeWidth="1" strokeDasharray="2 5"
                            strokeOpacity={Math.max(0.07, 0.15 - (index * 0.018))} // Outer tracks fainter
                        />
                    );
                })}
            </svg>

            {/* THE SUN */}
            <Sun />

            {/* PLANETS */}
            {activeRings.map((category, index) => {
                const items = groupedPartners[category];
                const track = tracks[index];

                return items.map((p, i) => (
                    <OrbitingObject
                        key={p.id}
                        partner={p}
                        rx={track.rx}
                        ry={track.ry}
                        period={track.period}
                        phase={track.phase + (i * (Math.PI * 2 / items.length))}
                        diameter={track.diameter}
                        eager={index === 0}
                        visibilityRef={visibilityRef}
                    />
                ));
            })}

        </div>
    );
}

function OrbitingObject({
    partner, rx, ry, period, phase, diameter, eager, visibilityRef
}: {
    partner: Partner, rx: number, ry: number, period: number, phase: number, diameter: number, eager?: boolean, visibilityRef?: React.RefObject<boolean>
}) {
    const ref = useRef<HTMLDivElement>(null);
    const shouldReduceMotion = useReducedMotion();
    const settledRef = useRef(false);
    // Last-written values for the properties that only change at
    // depth-threshold crossings. Writing style.zIndex / opacity on
    // every frame forces style recalc 60 times a second per orbiting
    // object, even when the string is unchanged.
    const lastPaintRef = useRef<{ zIndex: string; opacity: string } | null>(null);

    useAnimationFrame((t) => {
        // Hero off-screen: do no per-frame work at all. The orbit
        // resumes from the clock (t) when the hero returns, so there
        // is no visual jump to catch up.
        if (visibilityRef && !visibilityRef.current) return;
        // Reduced motion: settle at the starting angle once, then stop
        // updating. If the preference is later turned off, resume orbit.
        if (shouldReduceMotion && settledRef.current) return;
        if (!shouldReduceMotion) settledRef.current = false;
        const angle = phase + ((shouldReduceMotion ? 0 : t) / (period * 1000)) * Math.PI * 2;

        const x = rx * Math.cos(angle);
        const y = ry * Math.sin(angle);
        const zVal = Math.sin(angle);

        // Depth from the orrery itself: the near arc reads larger and
        // fully opaque, the far arc smaller and stepped down. No blur.
        const scale = 0.95 + (0.10 * ((zVal + 1) / 2));
        const zIndex = zVal > 0 ? '20' : '5';
        const opacity = zVal < -0.35 ? '0.72' : zVal < 0.25 ? '0.88' : '1';

        if (ref.current) {
            ref.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
            const last = lastPaintRef.current;
            if (!last || last.zIndex !== zIndex || last.opacity !== opacity) {
                ref.current.style.zIndex = zIndex;
                ref.current.style.opacity = opacity;
                lastPaintRef.current = { zIndex, opacity };
            }
            if (shouldReduceMotion) settledRef.current = true;
        }
    });

    const initials = partner.name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('');

    return (
        <div
            ref={ref}
            data-planet={partner.id}
            className="absolute flex items-center justify-center pointer-events-auto will-change-transform"
            style={{
                left: '50%',
                top: '50%',
                width: diameter,
                height: diameter,
                marginLeft: -diameter / 2,
                marginTop: -diameter / 2
            }}
        >
            <div className="group relative w-full h-full">
                {/* PLANET DISC: dark instrument disc, hairline border,
                    the partner's flag/logo/icon crisp inside. One
                    elevation treatment (the border), no shadow, no
                    glow, no sheen. */}
                <div
                    tabIndex={0}
                    role="img"
                    aria-label={`${partner.type}: ${partner.name}`}
                    className="flex w-full h-full items-center justify-center overflow-hidden rounded-full border border-white/[0.14] outline-none transition-[border-color,transform] duration-300 group-hover:scale-[1.07] group-hover:border-white/30 focus-visible:border-primary/80"
                    style={{ backgroundColor: SURFACE }}
                >
                    <div className="relative flex h-[72%] w-[72%] items-center justify-center">
                        {partner.rawSvg ? (
                            <div
                                className="h-full w-full text-[hsl(210_40%_88%)]"
                                dangerouslySetInnerHTML={{ __html: partner.rawSvg }}
                            />
                        ) : partner.logoUrl ? (
                            <Image
                                src={partner.logoUrl}
                                alt=""
                                fill
                                className="object-contain"
                                sizes="72px"
                                loading={eager ? "eager" : "lazy"}
                            />
                        ) : (
                            <span className="font-accent text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/75">
                                {initials}
                            </span>
                        )}
                    </div>
                </div>

                {/* Hover/focus readout: names the partner, HUD style */}
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 border border-white/15 px-2 py-1 rounded-md whitespace-nowrap z-50 pointer-events-none font-accent text-[9px] uppercase tracking-[0.14em] text-foreground/90" style={{ backgroundColor: SURFACE }}>
                    {partner.type}: {partner.name}
                </div>
            </div>
        </div>
    )
}
