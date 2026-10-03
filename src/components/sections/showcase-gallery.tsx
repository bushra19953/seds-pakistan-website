"use client";

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { MediaEmbed } from '@/components/ui/media-embed';
import { useProjects } from '@/hooks/use-projects';
import { Rocket, Users, Calendar, GraduationCap, Sparkles, ArrowRight, Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';

// Dynamically import the 3D scene to avoid SSR hydration issues and reduce initial bundle size
const PortalCanvas = dynamic(() => import('../portfolio/portal-canvas').then(mod => mod.PortalCanvas), {
    ssr: false,
    loading: () => <div className="w-full h-full flex items-center justify-center text-muted-foreground/20 font-mono text-sm">INITIALIZING CORE...</div>
});

// Fallback with 100% FREE Unsplash images
const FALLBACK_ITEMS = [
    { id: 'f1', title: 'CubeSat Development', tag: 'projects', image: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=600&h=400&fit=crop', description: 'Building next-gen satellite technology' },
    { id: 'f2', title: 'School Outreach', tag: 'outreach', image: 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=600&h=400&fit=crop', description: 'Inspiring the next generation' },
    { id: 'f3', title: 'Rover Challenge', tag: 'events', image: 'https://images.unsplash.com/photo-1581092160562-40aa08e78837?w=600&h=400&fit=crop', description: 'National robotics competition' },
    { id: 'f4', title: 'Mission Design Workshop', tag: 'workshops', image: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=600&h=400&fit=crop', description: 'Hands-on spacecraft planning' },
];

type ShowcaseItem = { id: string; title: string; tag: string; image: string; description: string; slug?: string };

const TAGS = [
    { id: 'all', label: 'All', icon: Sparkles },
    { id: 'projects', label: 'Projects', icon: Rocket },
    { id: 'events', label: 'Events', icon: Calendar },
];

export default function ShowcaseGallery() {
    // Unified state for filtering
    const [activeCategory, setActiveCategory] = useState('all');
    const { projects, loading } = useProjects(8, true);

    const categories = [
        { id: 'all', label: 'All', icon: Sparkles },
        { id: 'projects', label: 'Projects', icon: Rocket },
        { id: 'events', label: 'Events', icon: Calendar },
    ];

    const items: ShowcaseItem[] = useMemo(() => {
        if (!projects || projects.length === 0) return FALLBACK_ITEMS;
        return projects.map(p => ({
            id: p.id,
            title: p.title,
            tag: (p as any).category?.toLowerCase() || 'projects',
            image: p.image_url || FALLBACK_ITEMS[0].image,
            description: p.summary || '',
            slug: p.slug
        }));
    }, [projects]);

    const filteredItems = useMemo(() => {
        return activeCategory === 'all' ? items : items.filter(item => item.tag === activeCategory);
    }, [activeCategory, items]);

    return (
        <section className="py-4 md:py-8 relative z-20 bg-transparent" id="showcase">
            <div className="relative z-10 container mx-auto px-0 md:px-6">
                <div className="flex flex-col items-center justify-center text-center mb-16 space-y-6">
                    <div className="space-y-2">
                        <div className="flex items-center justify-center gap-3 text-[10px] font-black uppercase tracking-[0.4em] text-primary/60 mb-2">
                            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                            Live Operational Telemetry
                            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                        </div>
                        <h2 className="text-5xl md:text-6xl lg:text-7xl font-accent font-black uppercase tracking-tighter text-white drop-shadow-[0_0_30px_rgba(59,130,246,0.3)]">
                            Our Impact in Action
                        </h2>
                    </div>
                    <p className="max-w-2xl text-muted-foreground font-mono text-xs md:text-sm tracking-[0.3em] uppercase leading-loose border-y border-white/5 py-4">
                        From national projects to community outreach — <span className="text-white">monitoring the growth</span> of SEDS Pakistan in real-time.
                    </p>
                </div>

                {/* ELITE PORTFOLIO SYSTEM UPGRADE: R3F Portal System */}
                {/* Visual Tweak: Removed black bg, added fade mask at edges */}
                <div className="w-full -mx-4 md:mx-0 border-y border-white/5 bg-transparent overflow-hidden relative group">
                    <div className="absolute left-0 top-0 bottom-0 w-12 md:w-32 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
                    <div className="absolute right-0 top-0 bottom-0 w-12 md:w-32 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

                    <PortalCanvas projects={filteredItems} />
                </div>

                {/* Category Filters (HUD Switchers) */}
                <div className="flex flex-wrap justify-center gap-4 mt-12">
                    {categories.map((cat) => (
                        <button
                            key={cat.id}
                            onClick={() => setActiveCategory(cat.id)}
                            className={`group px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-500 border backdrop-blur-2xl relative overflow-hidden ${activeCategory === cat.id
                                ? "bg-primary text-black border-primary shadow-[0_0_30px_rgba(59,130,246,0.3)]"
                                : "bg-slate-900/40 text-muted-foreground border-white/5 hover:border-primary/50 hover:text-white"
                                }`}
                        >
                            <span className="relative z-10 flex items-center gap-2">
                                {cat.icon && <cat.icon className={`w-3.5 h-3.5 ${activeCategory === cat.id ? 'text-black' : 'text-primary/60 group-hover:text-primary'}`} />}
                                {cat.label}
                            </span>
                            {activeCategory === cat.id && (
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full animate-scan-fast pointer-events-none" />
                            )}
                        </button>
                    ))}
                </div>

                <div className="flex justify-center mt-16">
                    <Button asChild size="lg" className="h-14 px-10 rounded-2xl bg-slate-950/60 text-white border-2 border-primary/30 font-accent font-black tracking-[0.2em] uppercase hover:bg-primary hover:text-black hover:border-primary transition-all duration-500 group shadow-2xl relative overflow-hidden backdrop-blur-3xl">
                        <Link href="/projects" className="relative z-10 flex items-center gap-3">
                            Explore Full Command Center
                            <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                        </Link>
                    </Button>
                </div>
            </div>
        </section>
    );
}
