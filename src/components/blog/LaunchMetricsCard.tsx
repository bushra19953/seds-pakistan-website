import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { LaunchMetric } from '@/lib/blog-data-utils';

interface LaunchMetricsCardProps {
    metrics: LaunchMetric[];
}

export function LaunchMetricsCard({ metrics }: LaunchMetricsCardProps) {
    if (!metrics || metrics.length === 0) return null;

    return (
        <Card className="bg-slate-900/40 border border-slate-800 backdrop-blur-md shadow-2xl overflow-hidden my-8 w-full">
            <CardHeader className="bg-slate-800/30 border-b border-slate-800/50">
                <div className="flex items-center gap-3">
                    <div className="h-3 w-3 rounded-full bg-blue-500 animate-pulse" />
                    <CardTitle className="text-xl font-mono text-slate-100 tracking-wider">
                        SYSTEM READINESS METRICS
                    </CardTitle>
                </div>
            </CardHeader>
            <CardContent className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {metrics.map((metric, index) => (
                        <div
                            key={index}
                            className="group flex flex-col p-4 rounded-lg bg-slate-800/30 border border-slate-700/30 hover:bg-slate-800/50 hover:border-blue-500/30 transition-all duration-300"
                        >
                            <div className="flex items-center justify-between mb-2">
                                <span className="font-mono text-sm text-slate-300 group-hover:text-blue-400 transition-colors">
                                    {metric.name || 'METRIC_UNDEFINED'}
                                </span>
                                <div className="flex items-center gap-2">
                                    {metric.isReady ? (
                                        <>
                                            <span className="text-xs font-bold text-emerald-400 tracking-widest uppercase">Go</span>
                                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                        </>
                                    ) : (
                                        <>
                                            <span className="text-xs font-bold text-rose-400 tracking-widest uppercase">No-Go</span>
                                            <XCircle className="w-4 h-4 text-rose-400" />
                                        </>
                                    )}
                                </div>
                            </div>

                            {(metric.progressPercentage !== undefined) && (
                                <div className="w-full h-1.5 bg-slate-800 rounded-full mt-2 overflow-hidden">
                                    <div
                                        className={`h-full rounded-full ${metric.isReady ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]'}`}
                                        style={{ width: `${Math.min(100, Math.max(0, metric.progressPercentage))}%` }}
                                    />
                                </div>
                            )}

                            {metric.notes && (
                                <p className="text-xs text-slate-400 mt-3 border-l-2 border-slate-600 pl-2 group-hover:border-blue-500/50 transition-colors">
                                    {metric.notes}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
