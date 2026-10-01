'use client';

import { useEffect } from 'react';
import { CheckCircle2, Ticket, Printer, X, PartyPopper } from 'lucide-react';

interface TicketCongratsModalProps {
    displayName: string;
    eventTitle: string;
    ticketNumber: number;
    ticketId?: string;
    onClose: () => void;
}

// ─── Confetti colors ──────────────────────────────────────────────────────────
const CONFETTI_COLORS = [
    '#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ec4899',
    '#8b5cf6', '#10b981', '#3b82f6', '#f97316', '#e11d48',
];

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

function ConfettiPiece({ index }: { index: number }) {
    const color = CONFETTI_COLORS[index % CONFETTI_COLORS.length];
    const duration = 1.4 + (index % 7) * 0.25;
    const delay = (index % 13) * 0.06;
    const left = 2 + (index * 1.57) % 96;
    const shape = index % 3 === 0 ? '50%' : index % 3 === 1 ? '0' : '2px';
    const width = 7 + (index % 5);
    const height = width * (index % 4 === 0 ? 0.45 : 1);

    return (
        <div
            style={{
                position: 'absolute',
                top: '-20px',
                left: `${left}%`,
                width: `${width}px`,
                height: `${height}px`,
                backgroundColor: color,
                borderRadius: shape,
                animation: `confettiFall-${index % 2 === 0 ? 'cw' : 'ccw'} ${duration}s ease-in ${delay}s forwards`,
                opacity: 0,
                zIndex: 0,
            }}
        />
    );
}

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
        @keyframes confettiFall-cw {
          0%   { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(440px) rotate(540deg); opacity: 0; }
        }
        @keyframes confettiFall-ccw {
          0%   { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(440px) rotate(-540deg); opacity: 0; }
        }
        @keyframes modalPop {
          0%   { transform: scale(0.65) translateY(24px); opacity: 0; }
          65%  { transform: scale(1.05) translateY(-5px); }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        @keyframes ticketBounce {
          0%, 100% { transform: translateY(0) rotate(-4deg); }
          50%       { transform: translateY(-8px) rotate(4deg); }
        }
        @keyframes shimmer {
          0%, 100% { opacity: 0.7; }
          50%       { opacity: 1; }
        }
        @keyframes pulseRing {
          0%   { box-shadow: 0 0 0 0 rgba(99,102,241,0.5); }
          100% { box-shadow: 0 0 0 18px rgba(99,102,241,0); }
        }
        @keyframes starFloat {
          0%, 100% { transform: translateY(0) scale(1); opacity: 0.6; }
          50%       { transform: translateY(-8px) scale(1.15); opacity: 1; }
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
                        background: 'linear-gradient(145deg, #0a0f1e, #141c2f)',
                        border: '1px solid rgba(99,102,241,0.45)',
                        borderRadius: 28,
                        padding: '44px 36px 36px',
                        maxWidth: 440,
                        width: '100%',
                        textAlign: 'center',
                        animation: 'modalPop 0.55s cubic-bezier(0.34,1.56,0.64,1) forwards',
                        boxShadow: '0 30px 100px rgba(99,102,241,0.3), 0 0 0 1px rgba(99,102,241,0.12)',
                        overflow: 'hidden',
                        zIndex: 9999,
                    }}
                >
                    {/* 60 confetti pieces for maximum explosion */}
                    {[...Array(60)].map((_, i) => <ConfettiPiece key={i} index={i} />)}

                    {/* Close button */}
                    <button
                        onClick={onClose}
                        style={{
                            position: 'absolute', top: 16, right: 16,
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

                    {/* Floating star accents */}
                    {['✦', '★', '✦', '★'].map((s, i) => (
                        <div
                            key={i}
                            style={{
                                position: 'absolute',
                                top: `${20 + i * 22}%`,
                                left: i % 2 === 0 ? '6%' : '88%',
                                fontSize: 16,
                                color: i % 2 === 0 ? '#f59e0b' : '#8b5cf6',
                                animation: `starFloat ${2 + i * 0.4}s ease-in-out ${i * 0.3}s infinite`,
                                opacity: 0.5,
                                pointerEvents: 'none',
                                zIndex: 1,
                            }}
                        >
                            {s}
                        </div>
                    ))}

                    {/* Animated ticket icon with pulse ring */}
                    <div
                        style={{
                            width: 80, height: 80, borderRadius: '50%',
                            background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto 22px',
                            animation: 'ticketBounce 2s ease-in-out infinite, pulseRing 1.8s ease-out infinite',
                            boxShadow: '0 0 40px rgba(99,102,241,0.45)',
                            position: 'relative', zIndex: 2,
                        }}
                    >
                        <Ticket size={36} color="white" />
                    </div>

                    {/* 🎉 Congrats header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 6 }}>
                        <PartyPopper size={18} color="#f59e0b" />
                        <h2 style={{
                            fontSize: 28, fontWeight: 900, color: '#fff',
                            margin: 0, letterSpacing: '-0.5px', lineHeight: 1.1,
                        }}>
                            You're In, {displayName}!
                        </h2>
                        <PartyPopper size={18} color="#f59e0b" />
                    </div>

                    <p style={{ fontSize: 14, color: '#94a3b8', margin: '0 0 22px', lineHeight: 1.6 }}>
                        Your ticket for <strong style={{ color: '#e2e8f0' }}>{eventTitle}</strong> has been officially issued. 🚀
                    </p>

                    {/* Giant ticket number */}
                    <div style={{
                        display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                        background: 'rgba(99,102,241,0.12)',
                        border: '1px solid rgba(99,102,241,0.35)',
                        borderRadius: 18, padding: '14px 36px', marginBottom: 22,
                    }}>
                        <span style={{ fontSize: 11, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 4 }}>
                            Ticket Number
                        </span>
                        <span style={{
                            fontSize: 48, fontWeight: 900, color: '#818cf8', lineHeight: 1,
                            animation: 'shimmer 2s ease-in-out infinite',
                            fontVariantNumeric: 'tabular-nums',
                        }}>
                            #{ticketNumber.toString().padStart(3, '0')}
                        </span>
                    </div>

                    {/* Valid checkmark */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 24 }}>
                        <CheckCircle2 size={16} color="#22c55e" />
                        <span style={{ fontSize: 13, color: '#86efac', fontWeight: 600 }}>Ticket is valid &amp; ready to use</span>
                    </div>

                    {/* CTA buttons */}
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                        {ticketId && (
                            <a
                                href={`/events/ticket/${ticketId}`}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                                    color: '#fff', borderRadius: 12, padding: '11px 22px',
                                    fontSize: 14, fontWeight: 700, textDecoration: 'none',
                                    boxShadow: '0 0 20px rgba(99,102,241,0.35)',
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
                                    color: '#cbd5e1', borderRadius: 12, padding: '11px 22px',
                                    fontSize: 14, fontWeight: 600, textDecoration: 'none',
                                }}
                            >
                                <Printer size={15} /> Print
                            </a>
                        )}
                    </div>

                    {/* Auto-dismiss footer */}
                    <p style={{ fontSize: 11, color: '#1e293b', marginTop: 22 }}>
                        Closes automatically in a few seconds…
                    </p>
                </div>
            </div>
        </>
    );
}
