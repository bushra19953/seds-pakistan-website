'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import Image from 'next/image';
import { motion } from 'framer-motion';
import { X, Check, Move, Maximize2, Type, QrCode, CheckCircle2, AlertTriangle, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface OverlayConfig {
    x: number;
    y: number;
    size: number;
    color: string;
    fontFamily?: string;
    fontWeight?: string;
    enabled?: boolean;
}

const FONTS = [
    { label: 'Inter', value: 'var(--font-inter), sans-serif' },
    { label: 'Orbitron', value: 'Orbitron, sans-serif' },
    { label: 'Space Mono', value: 'Space Mono, monospace' },
    { label: 'Roboto', value: 'Roboto, sans-serif' },
    { label: 'Montserrat', value: 'Montserrat, sans-serif' },
];

const WEIGHTS = [
    { label: 'Light', value: '300' },
    { label: 'Regular', value: '400' },
    { label: 'Medium', value: '500' },
    { label: 'Bold', value: '700' },
    { label: 'Black', value: '900' },
];

interface TicketAlignmentEditorProps {
    side: 'front' | 'back';
    imageUrl: string;
    overlays: Record<string, OverlayConfig>;
    previewData: Record<string, string | undefined>; // Stage 5: Real Data (values may be unset)
    onChange: (newOverlays: any) => void;
    onClose: () => void;
    title?: string;
}

export default function TicketAlignmentEditor({
    side,
    imageUrl,
    overlays,
    previewData,
    onChange,
    onClose,
    title = "Align Ticket Elements"
}: TicketAlignmentEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [localOverlays, setLocalOverlays] = useState<any>(overlays || {});
    const overlaysRef = useRef(localOverlays);
    useEffect(() => { overlaysRef.current = localOverlays; }, [localOverlays]);
    const [activeElement, setActiveElement] = useState<string | null>(null);
    const [renderedWidth, setRenderedWidth] = useState(800);
    const [imageAspect, setImageAspect] = useState<number>(1.618); // Default Golden Ratio
    const [imageError, setImageError] = useState(false);

    // Dynamic Aspect Ratio Sync (Stage 6)
    useEffect(() => {
        if (!imageUrl) return;
        let active = true;
        const img = new window.Image();
        img.onload = () => {
            if (active && img.width && img.height) {
                setImageAspect(img.width / img.height);
                setImageError(false);
            }
        };
        img.onerror = () => setImageError(true);
        img.src = imageUrl;
        return () => { active = false; };
    }, [imageUrl]);

    // Canva Style Resize Observer (Bulletproof Math-Only Scale)
    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.contentRect.width > 0) {
                    setRenderedWidth(entry.contentRect.width);
                }
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [imageAspect]);

    const renderScale = renderedWidth / 800;

    // Categorized Elements (Stage 6 FIGMA-LIKE Categorization)
    const allElements = [
        { id: 'logo', label: 'Org Logo', icon: ImageIcon, preview: 'Logo', side: 'front', category: 'Branding' },
        { id: 'orgName', label: 'Org Name', icon: Type, preview: previewData.orgName || 'SEDS Pakistan', side: 'front', category: 'Branding' },
        { id: 'orgTagline', label: 'Org Tagline', icon: Type, preview: previewData.orgTagline || 'Students for Space Exploration', side: 'front', category: 'Branding' },

        { id: 'eventTitle', label: 'Event Title', icon: Type, preview: previewData.title || 'SEDS Bootcamp 2026', side: 'front', category: 'Event' },
        { id: 'eventDate', label: 'Event Date', icon: Type, preview: previewData.startDate || '12th March 2026', side: 'front', category: 'Event' },
        { id: 'eventVenue', label: 'Event Venue', icon: Type, preview: previewData.venue || 'Islamabad, Pakistan', side: 'front', category: 'Event' },

        { id: 'name', label: 'Attendee Name', icon: Type, preview: 'Muhammad bin Sulayman', side: 'front', category: 'Attendee' },
        { id: 'email', label: 'Email Address', icon: Type, preview: 'suleman@seds.com', side: 'front', category: 'Attendee' },
        { id: 'ticketNum', label: 'Ticket ID', icon: Type, preview: '#2026-BOO-001', side: 'front', category: 'Attendee' },
        { id: 'statusBadge', label: 'Status Badge', icon: CheckCircle2, preview: 'Valid', side: 'front', category: 'Attendee' },
        { id: 'qrCode', label: 'QR Code', icon: QrCode, preview: '[QR]', side: 'both', category: 'Attendee' },

        { id: 'issuedDate', label: 'Issued Date', icon: Type, preview: previewData.issuedDate || 'Issued Mar 1, 2026', side: 'back', category: 'Event' },
        { id: 'paymentRef', label: 'Payment Ref', icon: Type, preview: 'Ref: 123456789', side: 'back', category: 'Attendee' },
        { id: 'verificationUrl', label: 'Verification URL', icon: Type, preview: 'seds-pakistan.web.app/ticket/[ID]', side: 'back', category: 'Attendee' },
        { id: 'disclaimer', label: 'Disclaimer', icon: Type, preview: previewData.disclaimer || '© SEDS Pakistan 2026. All Rights Reserved.', side: 'back', category: 'Branding' },
    ];

    const elements = useMemo(() =>
        allElements.filter(el => el.side === side || el.side === 'both'),
        [side]);

    const handleUpdate = (newOverlays: any) => {
        setLocalOverlays(newOverlays);
        onChange(newOverlays);
    };

    const handleDrag = (event: any, info: any, key: string) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();

        // Dynamic Snap
        const snapStep = event.shiftKey ? 0.1 : 0.5;
        const deltaXPercent = (info.delta.x / rect.width) * 100;
        const deltaYPercent = (info.delta.y / rect.height) * 100;

        setLocalOverlays((prev: any) => {
            const config = prev[key];
            if (!config) return prev;

            let newX = config.x + deltaXPercent;
            let newY = config.y + deltaYPercent;

            newX = Math.max(0, Math.min(100, newX));
            newY = Math.max(0, Math.min(100, newY));

            return {
                ...prev,
                [key]: {
                    ...config,
                    x: Math.round(newX / snapStep) * snapStep,
                    y: Math.round(newY / snapStep) * snapStep
                }
            };
        });
    };

    const handleDragEnd = (event: any, info: any, key: string) => {
        setActiveElement(null);
        // Wait for React to flush the final onPan state into overlaysRef, then sync to parent
        setTimeout(() => {
            handleUpdate(overlaysRef.current);
        }, 10);
    };

    // Keyboard Nudging (Stage 4 FIGMA-LIKE)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!activeElement || !localOverlays[activeElement]) return;

            const step = e.shiftKey ? 1.0 : 0.1;
            const config = localOverlays[activeElement];
            let { x, y } = config;

            if (e.key === 'ArrowLeft') x -= step;
            if (e.key === 'ArrowRight') x += step;
            if (e.key === 'ArrowUp') y -= step;
            if (e.key === 'ArrowDown') y += step;

            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const newOverlays = {
                    ...localOverlays,
                    [activeElement]: {
                        ...config,
                        x: Math.min(100, Math.max(0, Number(x.toFixed(2)))),
                        y: Math.min(100, Math.max(0, Number(y.toFixed(2))))
                    }
                };
                setLocalOverlays(newOverlays);
                handleUpdate(newOverlays);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeElement, localOverlays]);

    return (
        <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col items-center justify-center p-4 backdrop-blur-xl">
            <div className="w-full max-w-7xl flex flex-col h-full max-h-[95vh]">
                {/* Header */}
                <div className="flex items-center justify-between mb-4 bg-slate-900/50 border border-white/10 p-4 rounded-2xl">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                            <Move className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">{title}</h2>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Precision Alignment Mode • 0.5% Snap</p>
                        </div>
                    </div>
                    <Button onClick={onClose} className="bg-primary text-black hover:bg-primary/90 font-bold px-8 shadow-lg shadow-primary/20">
                        <Check className="w-4 h-4 mr-2" /> Save & Exit
                    </Button>
                </div>

                <div className="flex flex-1 gap-6 overflow-hidden">
                    {/* Left: Enhanced Sidebar */}
                    <div className="flex-1 overflow-y-auto pr-2 space-y-6">
                        {['Branding', 'Event', 'Attendee'].map(cat => (
                            <div key={cat} className="space-y-3">
                                <h4 className="text-[10px] uppercase tracking-widest text-primary font-black px-1 flex items-center gap-2">
                                    <div className="w-1 h-1 rounded-full bg-primary" />
                                    {cat}
                                </h4>
                                <div className="space-y-2">
                                    {elements.filter(el => el.category === cat).map((el, index) => {
                                        const config = localOverlays[el.id] || { x: 50, y: 50, size: 24, color: '#FFFFFF', enabled: false };
                                        const isEnabled = !!config.enabled;

                                        return (
                                            <Card key={el.id} className={`p-3 bg-white/[0.03] border-white/5 transition-all duration-300 ${activeElement === el.id ? 'ring-1 ring-primary/50 bg-white/[0.08]' : ''}`}>
                                                <div className="flex items-center justify-between gap-3 mb-2">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <div className={`p-1.5 rounded-lg ${isEnabled ? 'bg-primary/20 text-primary' : 'bg-white/5 text-slate-500'}`}>
                                                            <el.icon className="w-3 h-3" />
                                                        </div>
                                                        <span className={`text-[11px] font-bold truncate ${isEnabled ? 'text-white' : 'text-slate-500'}`}>
                                                            {el.label}
                                                        </span>
                                                    </div>
                                                    <Switch checked={isEnabled} onCheckedChange={(v) => handleUpdate({ ...localOverlays, [el.id]: { ...config, enabled: v } })} />
                                                </div>

                                                {isEnabled && (
                                                    <div className="space-y-3 pt-2">
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <div className="space-y-1">
                                                                <Label className="text-[9px] uppercase text-slate-500 font-bold">Pos X (%)</Label>
                                                                <Input type="number" step="0.5" value={config.x} onChange={(e) => handleUpdate({ ...localOverlays, [el.id]: { ...config, x: Number(e.target.value) } })} className="h-7 bg-black/40 border-white/5 text-[10px]" />
                                                            </div>
                                                            <div className="space-y-1">
                                                                <Label className="text-[9px] uppercase text-slate-500 font-bold">Pos Y (%)</Label>
                                                                <Input type="number" step="0.5" value={config.y} onChange={(e) => handleUpdate({ ...localOverlays, [el.id]: { ...config, y: Number(e.target.value) } })} className="h-7 bg-black/40 border-white/5 text-[10px]" />
                                                            </div>
                                                        </div>

                                                        {el.id !== 'qrCode' && el.id !== 'logo' && el.id !== 'statusBadge' && (
                                                            <div className="space-y-2 border-t border-white/5 pt-2">
                                                                <div className="grid grid-cols-2 gap-2">
                                                                    <div className="space-y-1">
                                                                        <Label className="text-[9px] uppercase text-slate-500 font-bold">Font Size</Label>
                                                                        <Input type="number" value={config.size} onChange={(e) => handleUpdate({ ...localOverlays, [el.id]: { ...config, size: Number(e.target.value) } })} className="h-7 bg-black/40 border-white/5 text-[10px]" />
                                                                    </div>
                                                                    <div className="space-y-1">
                                                                        <Label className="text-[9px] uppercase text-slate-500 font-bold">Color</Label>
                                                                        <Input type="color" value={config.color} onChange={(e) => handleUpdate({ ...localOverlays, [el.id]: { ...config, color: e.target.value } })} className="h-7 bg-black/40 border-white/5 p-0.5" />
                                                                    </div>
                                                                </div>

                                                                <div className="grid grid-cols-2 gap-2">
                                                                    <div className="space-y-1">
                                                                        <Label className="text-[9px] uppercase text-slate-500 font-bold">Font Family</Label>
                                                                        <Select value={config.fontFamily || FONTS[0].value} onValueChange={(v) => handleUpdate({ ...localOverlays, [el.id]: { ...config, fontFamily: v } })}>
                                                                            <SelectTrigger className="h-7 bg-black/40 border-white/5 text-[8px]">
                                                                                <SelectValue />
                                                                            </SelectTrigger>
                                                                            <SelectContent>
                                                                                {FONTS.map(f => <SelectItem key={f.value} value={f.value} className="text-xs">{f.label}</SelectItem>)}
                                                                            </SelectContent>
                                                                        </Select>
                                                                    </div>
                                                                    <div className="space-y-1">
                                                                        <Label className="text-[9px] uppercase text-slate-500 font-bold">Font Weight</Label>
                                                                        <Select value={config.fontWeight || '700'} onValueChange={(v) => handleUpdate({ ...localOverlays, [el.id]: { ...config, fontWeight: v } })}>
                                                                            <SelectTrigger className="h-7 bg-black/40 border-white/5 text-[8px]">
                                                                                <SelectValue />
                                                                            </SelectTrigger>
                                                                            <SelectContent>
                                                                                {WEIGHTS.map(w => <SelectItem key={w.value} value={w.value} className="text-xs">{w.label}</SelectItem>)}
                                                                            </SelectContent>
                                                                        </Select>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </Card>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Center: Precision Canvas (Stage 7 FIGMA-LIKE) */}
                    <div className="flex-1 bg-[#121212] rounded-3xl border border-white/5 relative overflow-auto flex items-center justify-center p-12 shadow-[inset_0_0_100px_rgba(0,0,0,0.8)]">
                        {/* Rulers */}
                        <div className="absolute top-0 left-12 right-0 h-6 border-b border-white/10 flex items-center text-[8px] text-slate-500 font-mono">
                            {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(val => (
                                <div key={val} className="absolute h-full flex items-end pb-1 border-l border-white/5" style={{ left: `${val}%` }}>
                                    <span className="ml-1">{val}%</span>
                                </div>
                            ))}
                        </div>
                        <div className="absolute top-12 left-0 bottom-0 w-6 border-r border-white/10 flex flex-col items-center text-[8px] text-slate-500 font-mono">
                            {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(val => (
                                <div key={val} className="absolute w-full flex justify-end pr-1 border-t border-white/5" style={{ top: `${val}%` }}>
                                    <span>{val}%</span>
                                </div>
                            ))}
                        </div>

                        <div className="relative shadow-2xl ring-1 ring-white/10 flex flex-col items-center justify-center p-2" style={{ width: '100%', height: '100%' }}>
                            <div
                                ref={containerRef}
                                className="relative overflow-hidden cursor-crosshair group flex-shrink-0"
                                style={{
                                    width: '100%',
                                    maxWidth: '800px',
                                    aspectRatio: `${imageAspect}`,
                                }}
                            >
                                {/* Template Image */}
                                {imageUrl ? (
                                    <Image src={imageUrl} alt="Ticket Template" fill sizes="(max-width: 800px) 100vw, 800px" className="w-full h-full object-contain block pointer-events-none select-none opacity-90 bg-slate-900" />
                                ) : (
                                    <div className="w-full aspect-[1.618/1] flex flex-col items-center justify-center text-slate-500 font-bold bg-slate-950">
                                        No Template Image Provided
                                    </div>
                                )}

                                {imageError && (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 text-red-400">
                                        <AlertTriangle className="w-12 h-12 mb-2" />
                                        <p className="text-sm font-bold">Invalid Template URL</p>
                                    </div>
                                )}

                                {/* Smart Guides (Stage 4 FIGMA-LIKE) */}
                                {activeElement && localOverlays[activeElement] && (
                                    <>
                                        {Math.abs(localOverlays[activeElement].x - 50) < 1 && (
                                            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-primary/40 z-10" />
                                        )}
                                        {Math.abs(localOverlays[activeElement].y - 50) < 1 && (
                                            <div className="absolute top-1/2 left-0 right-0 h-px bg-primary/40 z-10" />
                                        )}
                                    </>
                                )}

                                {/* Optional Grid Overlay */}
                                <div className="absolute inset-0 pointer-events-none opacity-[0.03]"
                                    style={{
                                        backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
                                        backgroundSize: '20px 20px'
                                    }}
                                />

                                {/* Draggable Overlays */}
                                {elements.map((el, index) => {
                                    const config = localOverlays?.[el.id];
                                    if (!config || config.enabled === false) return null;

                                    return (
                                        <motion.div
                                            key={el.id}
                                            onPanSessionStart={() => setActiveElement(el.id)}
                                            onPan={(e, info) => handleDrag(e, info, el.id)}
                                            onPanEnd={(e, info) => handleDragEnd(e, info, el.id)}
                                            className={`absolute cursor-move flex flex-col items-center justify-center p-1 group/item ${activeElement === el.id ? 'z-[100]' : 'z-20'}`}
                                            style={{
                                                left: `${config.x}%`,
                                                top: `${config.y}%`,
                                                translateX: '-50%',
                                                translateY: '-50%',
                                            }}
                                        >
                                            <div className={`transition-all duration-200 ${activeElement === el.id ? 'opacity-100' : 'opacity-0 group-hover/item:opacity-100'} absolute -top-8 bg-primary text-black text-[10px] font-black px-2 py-0.5 rounded shadow-lg flex items-center gap-2`}>
                                                <span>{el.label}</span>
                                                <span className="opacity-50 font-mono">{config.x}% , {config.y}%</span>
                                            </div>

                                            {/* Corner Resize Handle (Stage 10 FIGMA-LIKE) */}
                                            {activeElement === el.id && el.id !== 'qrCode' && (
                                                <motion.div
                                                    drag
                                                    dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
                                                    dragElastic={0}
                                                    onDrag={(e, info) => {
                                                        const physicalDelta = (info.delta.x + info.delta.y) / 2;
                                                        const virtualDelta = physicalDelta / renderScale;
                                                        const newSize = Math.max(8, config.size + virtualDelta);
                                                        handleUpdate({ ...localOverlays, [el.id]: { ...config, size: Math.round(newSize) } });
                                                    }}
                                                    className="absolute -bottom-1 -right-1 w-3 h-3 bg-primary rounded-full cursor-nwse-resize shadow-lg ring-2 ring-black z-[110]"
                                                />
                                            )}

                                            <div
                                                className={`transition-all duration-200 ${activeElement === el.id ? 'ring-2 ring-primary ring-offset-2 ring-offset-black/50' : 'group-hover/item:ring-1 group-hover/item:ring-primary/40'}`}
                                            >
                                                {el.id === 'logo' ? (
                                                    <div className="relative flex items-center justify-center p-1" style={{ width: config.size * renderScale, height: config.size * renderScale }}>
                                                        <Image src="/assets/logo.png" alt="SEDS Logo" fill sizes="120px" className="w-full h-full object-contain" />
                                                    </div>
                                                ) : el.id === 'qrCode' ? (
                                                    <div className="bg-white p-1 rounded-sm shadow-xl" style={{ width: (config.size || 60) * renderScale, height: (config.size || 60) * renderScale }}>
                                                        <QrCode className="w-full h-full text-black" />
                                                    </div>
                                                ) : (
                                                    <div
                                                        style={{
                                                            fontSize: `${config.size * renderScale}px`,
                                                            color: config.color,
                                                            lineHeight: 1,
                                                            fontFamily: config.fontFamily || 'inherit',
                                                            fontWeight: config.fontWeight || 'bold',
                                                            textShadow: '0px 2px 4px rgba(0,0,0,0.8), -1px -1px 0px rgba(0,0,0,0.2)'
                                                        }}
                                                        className="whitespace-nowrap px-2"
                                                    >
                                                        {el.preview}
                                                    </div>
                                                )}
                                            </div>
                                        </motion.div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
