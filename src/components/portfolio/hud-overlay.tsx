"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";

interface HUDOverlayProps {
    isActive: boolean;
    project: {
        title: string;
        created_at?: any;
        tags: string[];
    };
}

export function HUDOverlay({ isActive, project }: HUDOverlayProps) {
    // Generate a deterministic "tech hash" based on title
    const techHash = useMemo(() => {
        return project.title.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0).toString(16).toUpperCase();
    }, [project.title]);

    const dateStr = new Date().toISOString().split("T")[0];

    return (
        <div className="absolute inset-0 pointer-events-none z-20 mix-blend-difference text-foreground/80 font-mono text-[10px] md:text-xs overflow-hidden">
            {/* Reticles */}
            <div className="absolute top-4 left-4 w-4 h-4 border-t border-l border-current opacity-50" />
            <div className="absolute top-4 right-4 w-4 h-4 border-t border-r border-current opacity-50" />
            <div className="absolute bottom-4 left-4 w-4 h-4 border-b border-l border-current opacity-50" />
            <div className="absolute bottom-4 right-4 w-4 h-4 border-b border-r border-current opacity-50" />

            {/* Grid Coordinates */}
            <div className="absolute top-4 left-10 opacity-70">
                COORD: {isActive ? "ACTIVE" : "STDBY"} {'//'} {techHash.slice(0, 4)}
            </div>

            <div className="absolute top-4 right-10 text-right opacity-70 hidden md:block">
                SYS.T // {dateStr}
            </div>

            {/* Center Reticle (Only Visible on Hover/Active) */}
            <motion.div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[1px] bg-muted"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: isActive ? 1 : 0 }}
                transition={{ duration: 0.4, ease: "circOut" }}
            />

            {/* Bottom Data Layer */}
            <div className="absolute bottom-4 left-10 flex gap-4 opacity-70">
                <span className="text-emerald-400">● {project.tags[0] || "PROTOTYPE"}</span>
                <span className="hidden md:inline">HASH: 0x{techHash}</span>
                {isActive && <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-amber-400">:: DEPLOYED</motion.span>}
            </div>
        </div>
    );
}
