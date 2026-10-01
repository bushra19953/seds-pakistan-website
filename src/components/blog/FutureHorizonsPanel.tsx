import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import type { HorizonEvent } from '@/lib/blog-data-utils';
import { RocketIcon } from 'lucide-react';

interface FutureHorizonsPanelProps {
    horizons: HorizonEvent[];
    title?: string;
}

export function FutureHorizonsPanel({ horizons, title }: FutureHorizonsPanelProps) {
    if (!horizons || horizons.length === 0) return null;

    return (
        <div className="my-12">
            <div className="flex items-center gap-3 mb-8">
                <RocketIcon className="w-6 h-6 text-blue-500" />
                <h3 className="text-2xl font-bold font-mono tracking-widest text-slate-100 uppercase bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">
                    FUTURE HORIZONS {title && `// ${title}`}
                </h3>
            </div>

            <div className="relative border-l-2 border-slate-700/50 ml-4 space-y-8 pb-4">
                {horizons.map((event, index) => (
                    <div key={event.id || index} className="relative pl-8 group">
                        {/* Timeline Node */}
                        <div className="absolute -left-[9px] top-1 h-4 w-4 rounded-full border-2 border-slate-900 bg-slate-700 group-hover:bg-blue-500 group-hover:border-blue-300 transition-colors shadow-[0_0_10px_rgba(59,130,246,0)] group-hover:shadow-[0_0_15px_rgba(59,130,246,0.5)] duration-500" />

                        {/* Event Year Label */}
                        <div className="mb-2 inline-block px-3 py-1 rounded-sm bg-blue-500/10 border border-blue-500/20 text-blue-400 font-mono text-sm tracking-widest font-bold group-hover:bg-blue-500/20 transition-colors duration-300">
                            {event.year}
                        </div>

                        <Card className="bg-slate-900/40 border-slate-800/60 backdrop-blur-sm group-hover:bg-slate-800/40 group-hover:border-slate-700/60 transition-all duration-300">
                            <CardContent className="p-5">
                                <h4 className="text-lg font-bold text-slate-200 mb-2 group-hover:text-white transition-colors">
                                    {event.title}
                                </h4>
                                <p className="text-slate-400 leading-relaxed text-sm">
                                    {event.description}
                                </p>
                            </CardContent>
                        </Card>
                    </div>
                ))}

                {/* Ending Fade-out Node */}
                <div className="absolute -left-[9px] -bottom-2 h-4 w-4 rounded-full border-2 border-slate-900 bg-slate-800/50 animate-pulse" />
            </div>
        </div>
    );
}
