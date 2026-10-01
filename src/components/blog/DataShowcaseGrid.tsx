import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import type { TechSpec } from '@/lib/blog-data-utils';
import Image from 'next/image';

interface DataShowcaseGridProps {
    technicalSpecs: TechSpec[];
    engineeringSeal?: string;
    heroImage?: string;
    projectTitle?: string;
}

export function DataShowcaseGrid({
    technicalSpecs,
    engineeringSeal,
    heroImage,
    projectTitle
}: DataShowcaseGridProps) {
    if (!technicalSpecs || technicalSpecs.length === 0) return null;

    return (
        <div className="my-10">
            <h3 className="text-2xl font-bold font-mono text-slate-100 mb-6 border-b border-slate-700/50 pb-2">
                TECHNICAL SPECIFICATIONS
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left Col: Specs Grid */}
                <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {technicalSpecs.map((spec, idx) => (
                        <Card
                            key={spec.id || idx}
                            className="bg-slate-900/30 border border-slate-800 backdrop-blur-md overflow-hidden group hover:border-blue-500/30 hover:bg-slate-900/50 transition-all duration-500"
                        >
                            <CardContent className="p-5 flex flex-col h-full justify-between relative">
                                {/* Decorative top border glow */}
                                <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-blue-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                                <span className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-3">
                                    {spec.label}
                                </span>
                                <span className="text-xl font-bold text-slate-100 group-hover:text-blue-300 transition-colors">
                                    {spec.value}
                                </span>
                            </CardContent>
                        </Card>
                    ))}
                </div>

                {/* Right Col: Hero / Seal */}
                {(heroImage || engineeringSeal) && (
                    <div className="lg:col-span-1 flex flex-col gap-4">
                        {heroImage && (
                            <Card className="bg-slate-900/40 overflow-hidden border border-slate-800 shadow-2xl relative min-h-[200px] h-full group">
                                <Image
                                    src={heroImage}
                                    alt={projectTitle || 'Data Showcase Hero'}
                                    fill
                                    sizes="(max-width: 1024px) 100vw, 400px"
                                    className="object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-700 ease-in-out"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-transparent" />
                                <div className="absolute bottom-4 left-4 right-4">
                                    <span className="text-sm font-bold text-white tracking-widest uppercase drop-shadow-md">
                                        {projectTitle || 'MISSION ASSET'}
                                    </span>
                                </div>
                            </Card>
                        )}

                        {engineeringSeal && (
                            <Card className="bg-slate-800/30 border border-emerald-500/20 shadow-lg relative overflow-hidden group">
                                <div className="absolute inset-0 bg-emerald-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                                <CardContent className="p-6 flex items-center justify-center gap-4">
                                    <div className="relative w-16 h-16 rounded-full border border-emerald-500/50 flex items-center justify-center animate-[spin_10s_linear_infinite]">
                                        <div className="absolute inset-2 border border-dashed border-emerald-400/50 rounded-full" />
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-emerald-400 font-bold tracking-widest uppercase text-sm">
                                            Engineering Seal Validated
                                        </span>
                                        <span className="font-mono text-xs text-slate-400">
                                            ID: {engineeringSeal.toUpperCase()}
                                        </span>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
