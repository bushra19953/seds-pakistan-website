"use client";

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { motion, useAnimationFrame, useMotionValue } from 'framer-motion';
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

export function OrbitingPartners({ partners, className }: OrbitingPartnersProps) {
    const [isMobile, setIsMobile] = useState(true);

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
        const handleResize = () => setIsMobile(window.innerWidth < 768);
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    if (isMobile) {
        // Show simplified static horizontal scroll on mobile
        return (
            <div className={cn("w-full py-4", className)}>
                <div className="flex items-center justify-center gap-3 flex-wrap px-4 max-w-md mx-auto">
                    {partners.slice(0, 8).map((partner) => (
                        <div
                            key={partner.id}
                            className="w-12 h-12 rounded-full bg-white/90 dark:bg-slate-800/90 shadow-md p-1.5 flex items-center justify-center border border-white/20"
                        >
                            {partner.logoUrl ? (
                                <Image
                                    src={partner.logoUrl}
                                    alt={partner.name}
                                    width={36}
                                    height={36}
                                    className="object-contain rounded-full"
                                    loading="lazy"
                                />
                            ) : (
                                <span className="text-[8px] text-muted-foreground font-bold">
                                    {partner.name.substring(0, 3)}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className={cn("absolute inset-0 pointer-events-none flex items-center justify-center overflow-visible", className)}>

            {/* NUCLEUS: SEDS Pakistan */}
            <div className="absolute z-10 w-24 h-24 flex items-center justify-center pointer-events-auto">
                <motion.div
                    className="relative w-full h-full rounded-full flex items-center justify-center"
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
                >
                    <div className="absolute inset-0 bg-green-500/20 blur-[50px] rounded-full animate-pulse" />
                    <div className="relative w-20 h-20 bg-black/90 rounded-full border border-green-500/30 shadow-[0_0_40px_rgba(0,255,100,0.15)] flex items-center justify-center p-3 z-10">
                        <Image
                            src="/assets/logo.png"
                            alt="SEDS Pakistan"
                            fill
                            sizes="96px"
                            className="object-contain p-2"
                            priority
                        />
                    </div>
                </motion.div>
            </div>

            {/* RENDER ORBITS & SATELLITES */}
            {/* Using shared SVG container for lines to ensure sync */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                {activeRings.map((category, index) => {
                    // Math for this ring
                    // Kept compact so satellites orbit the heading zone and
                    // do not sweep through the paragraph or CTA buttons below.
                    // 0: 210 (Technology)
                    // 1: 280
                    // 2: 350
                    // 3: 420
                    const rx = 210 + (index * 70);
                    const ry = 70 + (index * 20); // Aspect ratio scaling

                    return (
                        <ellipse
                            key={category}
                            cx="50%" cy="50%"
                            rx={rx} ry={ry}
                            fill="none" stroke="white" strokeWidth="1" strokeDasharray="4,6"
                            strokeOpacity={Math.max(0.05, 0.2 - (index * 0.03))} // Outer rings fainter
                        />
                    );
                })}
            </svg>

            {/* Render Satellites logic separately to use Refs */}
            {activeRings.map((category, index) => {
                const items = groupedPartners[category];
                const rx = 210 + (index * 70);
                const ry = 70 + (index * 20);

                // Speed: Outer rings slower
                // 0: 45s
                // 1: 55s
                // ...
                const duration = 45 + (index * 12);

                // Reverse alternate rings for dynamism
                const reverse = index % 2 !== 0;

                // Size: Outer rings larger
                const baseSize = index === 0 ? "w-10 h-10" : "w-12 h-12";

                return items.map((p, i) => (
                    <OrbitingObject
                        key={p.id}
                        partner={p}
                        rx={rx}
                        ry={ry}
                        duration={duration}
                        delay={-(i * (duration / items.length))}
                        baseSize={baseSize}
                        reverse={reverse}
                        orbitIndex={index}
                    />
                ));
            })}

        </div>
    );
}

function OrbitingObject({
    partner, rx, ry, duration, delay, baseSize, reverse, orbitIndex
}: {
    partner: Partner, rx: number, ry: number, duration: number, delay: number, baseSize: string, reverse?: boolean, orbitIndex: number
}) {
    const ref = useRef<HTMLDivElement>(null);

    useAnimationFrame((t) => {
        const durationMs = duration * 1000;
        const currentT = t + (delay * 1000);
        let angle = (currentT % durationMs) / durationMs * Math.PI * 2;
        if (reverse) angle = -angle;

        const x = rx * Math.cos(angle);
        const y = ry * Math.sin(angle);
        const zVal = Math.sin(angle);

        const scale = 0.9 + (zVal * 0.3);
        const zIndex = zVal > 0 ? 20 : 5;
        const opacity = zVal < -0.4 ? 0.6 : 1;
        const blur = zVal < -0.5 ? '2px' : '0px';

        if (ref.current) {
            ref.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
            ref.current.style.zIndex = zIndex.toString();
            ref.current.style.opacity = opacity.toString();
            ref.current.style.filter = `blur(${blur})`;
        }
    });

    return (
        <div
            ref={ref}
            className={cn("absolute flex items-center justify-center pointer-events-auto will-change-transform", baseSize)}
            style={{
                left: '50%',
                top: '50%',
                marginLeft: `calc(-1 * (${baseSize.includes('w-10') ? '1.25rem' : '1.5rem'}))`,
                marginTop: `calc(-1 * (${baseSize.includes('w-10') ? '1.25rem' : '1.5rem'}))`
            }}
        >
            {/* PLANET SPHERE */}
            <div className="group relative w-full h-full">
                <div className="w-full h-full rounded-full bg-slate-50 shadow-[inset_-2px_-2px_8px_rgba(0,0,0,0.1),0_0_15px_rgba(255,255,255,0.05)] overflow-hidden flex items-center justify-center relative transition-all duration-300 group-hover:scale-110 group-hover:shadow-[0_0_25px_rgba(255,255,255,0.3)] border-[0.5px] border-white/40">

                    <div className="w-[65%] h-[65%] relative z-10 flex items-center justify-center">
                        {partner.rawSvg ? (
                            <div 
                                className="w-full h-full text-slate-800"
                                dangerouslySetInnerHTML={{ __html: partner.rawSvg }}
                            />
                        ) : partner.logoUrl ? (
                            <Image
                                src={partner.logoUrl}
                                alt={partner.name}
                                fill
                                className="object-contain"
                                sizes="56px"
                                loading={orbitIndex === 0 ? "eager" : "lazy"}
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-[8px] text-muted-foreground font-bold uppercase">
                                {partner.name.substring(0, 3)}
                            </div>
                        )}
                    </div>

                    <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-transparent via-transparent to-white/40 z-20 pointer-events-none" />
                </div>

                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white text-black text-[9px] font-bold px-2 py-0.5 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
                    {partner.type}: {partner.name}
                </div>
            </div>
        </div>
    )
}
