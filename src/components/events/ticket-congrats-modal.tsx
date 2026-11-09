'use client';

import { useEffect } from 'react';
import { CheckCircle2, Ticket, Printer, X } from 'lucide-react';

interface TicketCongratsModalProps {
    displayName: string;
    eventTitle: string;
    ticketNumber: number;
    ticketId?: string;
    onClose: () => void;
}

// ─── Web Audio victory fanfare ────────────────────────────────────────────────
function playTicketFanfare() {
    try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const melody = [
            { freq: 523.25, t: 0, vol: 0.20, dur: 0.45 },
            { freq: 659.25, t: 0.10, vol: 0.18, dur: 0.45 },
            { freq: 783.99, t: 0.20, vol: 0.18, dur: 0.45 },
            { freq: 1046.5, t: 0.30, vol: 0.16, dur: 0.85 },
            { freq: 1318.5, t: 0.46, vol: 0.12, dur: 0.6 },
            { freq: 1567.9, t: 0.56, vol: 0.09, dur: 0.65 },
        ];
        melody.forEach(({ freq, t, vol, dur }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, ctx.currentTime + t);
            gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + dur);
            osc.start(ctx.currentTime + t);
            osc.stop(ctx.currentTime + t + dur + 0.05);
        });
        // Percussion thud
        const boom = ctx.createOscillator();
        const boomGain = ctx.createGain();
        boom.connect(boomGain); boomGain.connect(ctx.destination);
        boom.type = 'sine';
        boom.frequency.setValueAtTime(110, ctx.currentTime);
        boom.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.25);
        boomGain.gain.setValueAtTime(0.3, ctx.currentTime);
        boomGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        boom.start(ctx.currentTime); boom.stop(ctx.currentTime + 0.35);
    } catch { /* silently ignore */ }
}

// ─── The modal's own star chart ───────────────────────────────────────────────
// Same seeded construction as the site starfield: quiet printed-chart points
// and one constellation chain behind the card content. Fixed seed — the
// celebration sky does not change between renders.
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const MODAL_CHART = (() => {
    const rnd = mulberry32(20261109);
    const W = 440, H = 520;
    const stars = Array.from({ length: 44 }, () => {
        const band = rnd();
        return {
            x: Math.round(rnd() * W * 10) / 10,
            y: Math.round(rnd() * H * 10) / 10,
            r: band < 0.75 ? 0.7 + rnd() * 0.4 : 1.1 + rnd() * 0.4,
            o: band < 0.75 ? 0.14 + rnd() * 0.16 : 0.3 + rnd() * 0.18,
        };
    });
    const bright = [...stars].sort((a, b) => b.o - a.o).slice(0, 8);
    const chain: string[] = [];
    let current = bright[0];
    const pool = new Set(bright.slice(1));
    for (let link = 0; link < 4 && current; link++) {
        chain.push(`${current.x},${current.y}`);
        let best: typeof current | undefined; let bestD = Infinity;
        pool.forEach((s) => { const d = Math.hypot(s.x - current.x, s.y - current.y); if (d < bestD) { bestD = d; best = s; } });
        if (!best) break;
        pool.delete(best); current = best;
    }
    return { stars, chain, W, H };
})();

const FONT_DISPLAY = "'Bebas Neue', 'Noto Sans', sans-serif";
const FONT_LABEL = "'Orbitron', 'Noto Sans', sans-serif";
const FONT_BODY = "'Courier Prime', 'Noto Sans', monospace";
const CORAL = 'hsl(15 72% 63%)';
const HAIRLINE = 'hsl(210 40% 96% / 0.14)';

export default function TicketCongratsModal({
    displayName,
    eventTitle,
    ticketNumber,
    ticketId,
    onClose,
}: TicketCongratsModalProps) {
    useEffect(() => {
        playTicketFanfare();
        const timer = setTimeout(onClose, 10000);
        return () => clearTimeout(timer);
    }, [onClose]);

    return (
        <>
            <style>{`
        @keyframes modalPop {
          0%   { transform: scale(0.92) translateY(16px); opacity: 0; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        @keyframes ticketFloat {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(-6px); }
        }
        @keyframes pulseRing {
          0%   { box-shadow: 0 0 0 0 hsl(15 72% 63% / 0.45); }
          100% { box-shadow: 0 0 0 18px hsl(15 72% 63% / 0); }
        }
      `}</style>

            {/* Backdrop */}
            <div
                onClick={onClose}
                style={{
                    position: 'fixed', inset: 0, zIndex: 9998,
                    background: 'rgba(0,0,0,0.80)',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '24px',
                }}
            >
                {/* Modal card */}
                <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'relative',
                        background: '#0f172a',
                        border: `1px solid ${HAIRLINE}`,
                        borderRadius: 16,
                        padding: '44px 36px 36px',
                        maxWidth: 440,
                        width: '100%',
                        textAlign: 'center',
                        animation: 'modalPop 0.55s cubic-bezier(0.16,1,0.3,1) forwards',
                        boxShadow: '0 30px 100px rgba(0,0,0,0.55)',
                        overflow: 'hidden',
                        zIndex: 9999,
                        fontFamily: FONT_BODY,
                    }}
                >
                    {/* Star chart field */}
                    <svg
                        viewBox={`0 0 ${MODAL_CHART.W} ${MODAL_CHART.H}`}
                        preserveAspectRatio="xMidYMid slice"
                        aria-hidden="true"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                    >
                        {MODAL_CHART.chain.length > 1 && (
                            <polyline points={MODAL_CHART.chain.join(' ')} fill="none" stroke="hsl(210 40% 96% / 0.28)" strokeWidth="1" />
                        )}
                        {MODAL_CHART.stars.map((s, i) => (
                            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="hsl(210 40% 96%)" fillOpacity={s.o} />
                        ))}
                    </svg>

                    {/* The one coral rule */}
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: CORAL }} />

                    {/* Close button */}
                    <button
                        onClick={onClose}
                        style={{
                            position: 'absolute', top: 16, right: 16, zIndex: 2,
                            background: 'rgba(255,255,255,0.07)',
                            border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '50%', width: 32, height: 32,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', color: '#94a3b8',
                            transition: 'background 0.2s',
                        }}
                    >
                        <X size={14} />
                    </button>

                    {/* Ticket medallion with coral pulse */}
                    <div
                        style={{
                            width: 80, height: 80, borderRadius: '50%',
                            background: 'hsl(222 40% 14%)',
                            border: `1px solid ${HAIRLINE}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto 22px',
                            animation: 'ticketFloat 2.4s ease-in-out infinite, pulseRing 1.8s ease-out infinite',
                            position: 'relative', zIndex: 2,
                        }}
                    >
                        <Ticket size={34} color="hsl(210 40% 96%)" />
                    </div>

                    {/* Header */}
                    <p style={{
                        fontFamily: FONT_LABEL, fontSize: 10, letterSpacing: '0.3em',
                        color: 'hsl(210 40% 96% / 0.55)', margin: '0 0 8px', position: 'relative', zIndex: 2,
                    }}>
                        TICKET ISSUED
                    </p>
                    <h2 style={{
                        fontFamily: FONT_DISPLAY, fontSize: 36, fontWeight: 400, color: '#fff',
                        margin: '0 0 8px', letterSpacing: '0.02em', lineHeight: 1.05,
                        textTransform: 'uppercase', position: 'relative', zIndex: 2,
                    }}>
                        You&apos;re In, {displayName}!
                    </h2>

                    <p style={{ fontSize: 14, color: '#a7b3c7', margin: '0 0 22px', lineHeight: 1.6, position: 'relative', zIndex: 2 }}>
                        Your ticket for <strong style={{ color: '#e2e8f0' }}>{eventTitle}</strong> has been officially issued.
                    </p>

                    {/* Ticket number readout */}
                    <div style={{
                        display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                        background: 'hsl(222 40% 14%)',
                        border: `1px solid ${HAIRLINE}`,
                        borderRadius: 12, padding: '14px 36px 10px', marginBottom: 22,
                        position: 'relative', zIndex: 2,
                    }}>
                        <span style={{ fontFamily: FONT_LABEL, fontSize: 10, color: 'hsl(210 40% 96% / 0.5)', textTransform: 'uppercase', letterSpacing: '0.28em', marginBottom: 4 }}>
                            Ticket Number
                        </span>
                        <span style={{
                            fontFamily: FONT_DISPLAY,
                            fontSize: 56, color: CORAL, lineHeight: 1,
                            fontVariantNumeric: 'tabular-nums',
                        }}>
                            #{ticketNumber.toString().padStart(3, '0')}
                        </span>
                    </div>

                    {/* Valid checkmark */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 24, position: 'relative', zIndex: 2 }}>
                        <CheckCircle2 size={16} color="#4ade80" />
                        <span style={{ fontSize: 13, color: '#86efac', fontWeight: 600 }}>Ticket is valid &amp; ready to use</span>
                    </div>

                    {/* CTA buttons */}
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', position: 'relative', zIndex: 2 }}>
                        {ticketId && (
                            <a
                                href={`/events/ticket/${ticketId}`}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    background: CORAL,
                                    color: '#000', borderRadius: 8, padding: '11px 22px',
                                    fontSize: 14, fontWeight: 700, textDecoration: 'none',
                                    transition: 'transform 0.15s',
                                }}
                            >
                                <Ticket size={15} /> View My Ticket
                            </a>
                        )}
                        {ticketId && (
                            <a
                                href={`/events/ticket/${ticketId}`}
                                onClick={() => window.print()}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    background: 'rgba(255,255,255,0.07)',
                                    border: '1px solid rgba(255,255,255,0.14)',
                                    color: '#cbd5e1', borderRadius: 8, padding: '11px 22px',
                                    fontSize: 14, fontWeight: 600, textDecoration: 'none',
                                }}
                            >
                                <Printer size={15} /> Print
                            </a>
                        )}
                    </div>

                    {/* Auto-dismiss footer */}
                    <p style={{ fontSize: 11, color: '#64748b', marginTop: 22, position: 'relative', zIndex: 2 }}>
                        Closes automatically in a few seconds…
                    </p>
                </div>
            </div>
        </>
    );
}
