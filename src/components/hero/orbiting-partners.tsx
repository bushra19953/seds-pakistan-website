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
// "glowing bulbs" look; 3D pass same day: "doesn't look 3D", "not
// responsive"). The system is a star chart, not a light show: dark
// instrument discs on the deep-navy void, hairline tracks, one calm
// motion. Four rules make the spacing guarantee structural, not tuned:
//
// 1. SAME TRACK: every planet on a track shares one angular velocity
//    and the planets are phased evenly by index (phase_i = track phase
//    + i * 2PI / n), so relative angles never change. For a pair
//    straddling angle theta_c with half-gap h = PI / n, the centre
//    distance is 2 sin(h) * sqrt(rx^2 sin^2 + ry^2 cos^2), minimised at
//    the major-axis tips: chord_min = 2 * ry * sin(PI / n). The pair's
//    radii sum couples to the same angle (scale = 1 + A sin(theta)) —
//    at the tips both scales are ~1, and the dip just off the tips is
//    second-order small (bounded by ~0.1px at live geometry, confirmed
//    by the numeric sweep). So the diameter cap is stated directly
//    against the chord: d <= chord_min - CLEARANCE.
// 2. ACROSS TRACKS: concentric ellipses never approach closer than
//    min(rx step, ry step) = the ry step (TRACK_RY_STEP), for ANY pair
//    of phases (different periods drift through all combinations). At
//    that closest approach both planets can sit at the near tip at
//    full depth scale simultaneously, so diameters are clamped to
//    (gap - CLEARANCE) / DEPTH_MAX.
// 3. TRUE 3D DEPTH, FROM GEOMETRY: a planet's scale runs
//    1 + 0.18 * sin(angle): 0.82 on the far arc, 1.18 on the near arc.
//    Far-side planets pass BEHIND the sun (z 5 < sun z 10), near-side
//    planets pass IN FRONT (z 20), and a restrained brightness step
//    (0.78 / 0.9 / 1) dims the far arc. The disc stays fully opaque so
//    the occlusion reads honestly. No glow, no bloom, no blur: the
//    earlier build's white discs, glow shadows and sheen are what the
//    founder photographed and rejected. Chord and cross-track caps
//    above are computed against DEPTH_MAX (1.18), so the guarantee
//    holds at the new sizes (re-proven by sweep + DOM audit).
// 4. THE STAGE IS A PANEL IN BOTH THEMES: the orrery lives inside a
//    rounded deep-space panel (--space-panel, deep navy in light and
//    dark alike) like a viewport into space. Everything inside the
//    panel uses fixed instrument colours, never theme vars, so light
//    mode shows the identical instrument — no white wash, no inverted
//    stars.
// ---------------------------------------------------------------------------
const TRACK_RX_BASE = 180;
const TRACK_RX_STEP = 57;
const TRACK_RY_BASE = 38;
const TRACK_RY_STEP = 40;
const TRACK_PERIOD_BASE = 50; // seconds per revolution, innermost track
const TRACK_PERIOD_STEP = 18; // outer tracks slower, like real periods
const TRACK_PHASE_STEP = 2.399963; // golden angle: decorrelates the tracks
const DISC_MAX = 34;
const DEPTH_AMPLITUDE = 0.18;
const DEPTH_MAX = 1 + DEPTH_AMPLITUDE; // 1.18, near-side scale
const SPACING_CLEARANCE = 3; // px of guaranteed daylight between discs
const STAGE_HALF_HEIGHT = 164; // fits inside the panel (band 180 - inset 12 - margin 4)

const SURFACE = 'hsl(222 40% 14%)'; // DESIGN.md surface tone
// Deep-space panel tone. The sibling slice defines --space-panel (as
// HSL channels, like every other theme var); until it lands, the
// fallback is the same deep navy in both themes.
const SPACE_PANEL = 'hsl(var(--space-panel, 222 47% 8%))';
// Fixed interior ink for text that lives inside the panel.
const PANEL_INK = 'hsl(210 40% 88%)';
const PANEL_INK_DIM = 'hsl(210 40% 78%)';

interface TrackGeometry {
    rx: number;
    ry: number;
    period: number;
    phase: number;
    diameter: number;
}

function discDiameter(ry: number, count: number): number {
    if (count <= 1) return DISC_MAX;
    const chord = 2 * ry * Math.sin(Math.PI / count);
    // Rule 1: the cap IS the guarantee, so no size floor may override
    // it — a floor above the cap would silently reintroduce overlaps
    // on crowded tracks (the old DISC_MIN did exactly that at tablet
    // scales for the 21-planet ring).
    return Math.min(DISC_MAX, chord - SPACING_CLEARANCE);
}

// ---------------------------------------------------------------------------
// STARFIELD: the astronomy layer. Real star points and a few hairline
// constellation links, drawn as SVG geometry in a 1440x360 chart space
// (slice-cropped to the panel). Positions come from a seeded PRNG, so
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
// THE DEEP-SPACE PANEL: a rounded viewport into space that carries the
// star chart and frames the orrery in BOTH themes. One elevation
// treatment (the hairline border), no shadow. Planets and labels are
// siblings above it and are never clipped by it; their geometry keeps
// every disc inside the panel bounds.
// ---------------------------------------------------------------------------
function SpacePanel({ starClassName }: { starClassName?: string }) {
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-3 inset-y-2 overflow-hidden rounded-2xl border border-white/10 md:inset-x-6 md:inset-y-3"
            style={{ backgroundColor: SPACE_PANEL }}
        >
            <Starfield className={starClassName} />
        </div>
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
    const [useGrid, setUseGrid] = useState(true);
    const [viewportWidth, setViewportWidth] = useState(0);
    const shouldReduceMotion = useReducedMotion();

    // Ring scale: the orbit lives in its own stage band above the hero
    // copy, so the ellipses are sized to the stage and to the viewport
    // width — a satellite must never be clipped by the panel edge.
    // At 1280px and up the system runs at full size; below that it
    // scales down to 0.55 minimum. Wide screens additionally stretch
    // rx (never ry, which the stage height caps) so the system fills
    // a 1920 panel instead of sitting in its middle: the chord bound
    // is ry-driven and the cross-track bound is min(rx, ry) step, so
    // widening rx cannot break either guarantee.
    const orbitScale = viewportWidth === 0
        ? 1
        : Math.min(1, Math.max(0.55, viewportWidth / 1280));
    const rxBoost = viewportWidth >= 1280
        ? Math.min(1.4, viewportWidth / 1280)
        : 1;

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
            // Below lg the labeled chip grid composes the stage. The
            // honest chord cap for the crowded 21-planet ring falls
            // under ~21px at tablet scales — beads, not planets — so
            // 768–1023 gets the grid (full names, full-size discs) and
            // the orrery runs from 1024 up, where its tightest cap is
            // ~24.6px and every disc stays legible.
            setUseGrid(window.innerWidth < 1024);
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
        const fit = Math.min(1, STAGE_HALF_HEIGHT / (outer.ry + (outerDisc / 2) * DEPTH_MAX));
        return raw.map((t, k) => {
            const rx = t.rx * fit * rxBoost;
            const ry = t.ry * fit;
            let diameter = discDiameter(ry, t.count);
            // Cross-track clamp (rule 2): never wider than the
            // tightest radial gap to a neighbouring track allows at
            // full near-side depth scale.
            const gaps: number[] = [];
            if (k > 0) gaps.push(ry - raw[k - 1].ry * fit);
            if (k < raw.length - 1) gaps.push(raw[k + 1].ry * fit - ry);
            if (gaps.length > 0) {
                diameter = Math.min(diameter, (Math.min(...gaps) - SPACING_CLEARANCE) / DEPTH_MAX);
            }
            // No size floor: a floor above the caps would silently
            // break the guarantee on pathological data (30 partners
            // on the inner track caps at ~5px; an 8px floor overlapped
            // them in the sweep). The caps rule; the clamp below only
            // keeps the rendered size positive.
            return { rx, ry, period: t.period, phase: t.phase, diameter: Math.max(1, diameter) };
        });
    }, [activeRings, groupedPartners, orbitScale, rxBoost]);

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

    if (useGrid) {
        // Static labeled chip grid, inside the same deep-space panel
        // as the orrery: dark instrument discs with hairline borders,
        // never white bulbs. Every chip carries the partner's full
        // name underneath — nothing is truncated. On md the stage
        // band has a fixed height, so the grid fills and centres it.
        return (
            <div className={cn("relative w-full md:h-full", className)}>
                <SpacePanel starClassName="opacity-70" />
                <div className="relative flex h-full items-center justify-center px-4 py-6 md:py-0">
                    <div className="flex items-start justify-center gap-x-1 gap-y-3 flex-wrap max-w-md mx-auto">
                        {partners.slice(0, 8).map((partner) => (
                            <div key={partner.id} className="flex w-[4.25rem] flex-col items-center gap-1.5">
                                <div
                                    className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.14] p-1.5"
                                    style={{ backgroundColor: SURFACE }}
                                >
                                    {partner.rawSvg ? (
                                        <div
                                            className="h-full w-full"
                                            style={{ color: PANEL_INK }}
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
                                        <span className="font-accent text-[10px] font-semibold uppercase" style={{ color: PANEL_INK }}>
                                            {partner.name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('')}
                                        </span>
                                    )}
                                </div>
                                <span className="text-[9px] leading-tight text-center line-clamp-3" style={{ color: PANEL_INK_DIM }}>
                                    {partner.name}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className={cn("absolute inset-0 pointer-events-none flex items-center justify-center overflow-visible", className)}>

            {/* DEEP-SPACE PANEL + ASTRONOMY LAYER: the viewport the
                orrery is seen through, identical in both themes */}
            <SpacePanel />

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
    const discRef = useRef<HTMLDivElement>(null);
    const shouldReduceMotion = useReducedMotion();
    const settledRef = useRef(false);
    // Last-written values for the properties that only change at
    // depth-threshold crossings. Writing style.zIndex / filter on
    // every frame forces style recalc 60 times a second per orbiting
    // object, even when the string is unchanged.
    const lastPaintRef = useRef<{ zIndex: string; filter: string } | null>(null);

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

        // TRUE 3D DEPTH from the orbital phase (geometry note 3):
        // scale 0.82 far -> 1.18 near; the far arc passes behind the
        // sun, the near arc in front; a brightness step dims the far
        // arc. The disc stays opaque — occlusion stays honest.
        const scale = 1 + (DEPTH_AMPLITUDE * zVal);
        const zIndex = zVal > 0 ? '20' : '5';
        const filter = zVal < -0.35
            ? 'brightness(0.78)'
            : zVal < 0.25
                ? 'brightness(0.9)'
                : 'brightness(1)';

        if (ref.current) {
            ref.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
            const last = lastPaintRef.current;
            if (!last || last.zIndex !== zIndex || last.filter !== filter) {
                ref.current.style.zIndex = zIndex;
                if (discRef.current) discRef.current.style.filter = filter;
                lastPaintRef.current = { zIndex, filter };
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
                    ref={discRef}
                    tabIndex={0}
                    role="img"
                    aria-label={`${partner.type}: ${partner.name}`}
                    className="flex w-full h-full items-center justify-center overflow-hidden rounded-full border border-white/[0.14] outline-none transition-[border-color,transform] duration-300 group-hover:scale-[1.07] group-hover:border-white/30 focus-visible:border-primary/80"
                    style={{ backgroundColor: SURFACE }}
                >
                    <div className="relative flex h-[72%] w-[72%] items-center justify-center">
                        {partner.rawSvg ? (
                            <div
                                className="h-full w-full"
                                style={{ color: PANEL_INK }}
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
                            <span className="font-accent text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: PANEL_INK }}>
                                {initials}
                            </span>
                        )}
                    </div>
                </div>

                {/* Hover/focus readout: names the partner, HUD style.
                    Fixed panel colours — it lives inside the deep-space
                    panel in both themes. */}
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 border border-white/15 px-2 py-1 rounded-md whitespace-nowrap z-50 pointer-events-none font-accent text-[9px] uppercase tracking-[0.14em]" style={{ backgroundColor: SURFACE, color: PANEL_INK }}>
                    {partner.type}: {partner.name}
                </div>
            </div>
        </div>
    )
}
