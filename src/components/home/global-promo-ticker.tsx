"use client";

import { Megaphone, Rocket, ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';

// Assumed data contract for the ticker items injected by your parent component
export interface TickerItem {
    id: string;
    type: 'EVENT_PROMO' | 'GENERAL' | string;
    title: string;
    content?: string;
    summary?: string;
    link?: string;
}

export default function GlobalPromoTicker({ items = [] }: { items?: TickerItem[] }) {
    // If no items, we render nothing
    if (!items || items.length === 0) return null;

    // We duplicate the active items massively to ensure the marquee has enough intrinsic 
    // width to loop seamlessly (0% to -100%) without visual breakage on large displays.
    const duplicatedItems = [...items, ...items, ...items, ...items, ...items, ...items];

    return (
        <div className="w-full bg-card border-b border-primary/20 overflow-hidden relative flex items-center h-12 shadow-[0_4px_20px_-10px_rgba(255,255,255,0.05)]">
            {/* Left Gradient fade + Premium Sparkle Indicator */}
            <div className="absolute left-0 z-10 bg-gradient-to-r from-card via-card/90 to-transparent w-16 h-full flex items-center justify-start pl-4">
                <Sparkles className="w-5 h-5 text-amber-400 animate-pulse drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
            </div>

            {/* Right Gradient for smooth exit masking */}
            <div className="absolute right-0 z-10 bg-gradient-to-l from-card via-card/90 to-transparent w-24 h-full pointer-events-none" />

            {/* Infinite Marquee Container using globals.css ticker-animation */}
            <div className="flex w-max flex-nowrap whitespace-nowrap ticker-animation items-center">
                {duplicatedItems.map((item, idx) => (
                    <div key={`${item.id}-${idx}`} className="flex items-center mx-6 text-sm font-medium hover:text-foreground transition-colors duration-300">
                        {item.type === 'EVENT_PROMO' ? (
                            <Rocket className="w-4 h-4 text-blue-400 mr-2 drop-shadow-[0_0_5px_rgba(96,165,250,0.5)]" />
                        ) : (
                            <Megaphone className="w-4 h-4 text-primary mr-2" />
                        )}

                        <span className="text-foreground font-bold tracking-wide mr-2">{item.title}</span>
                        <span className="text-muted-foreground font-body">{item.content || item.summary}</span>

                        {item.link && (
                            <Link
                                href={item.link}
                                className="ml-4 text-blue-400 hover:text-blue-300 flex items-center text-[11px] font-accent uppercase tracking-widest bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20 transition-all hover:bg-blue-500/20 shadow-sm"
                            >
                                View <ChevronRight className="w-3 h-3 ml-0.5" />
                            </Link>
                        )}

                        <span className="ml-10 text-slate-700/50 select-none">|</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
