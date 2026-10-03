'use client';

import { useEffect, useState } from 'react';
import { Clock, AlertTriangle, XCircle, Timer } from 'lucide-react';

interface DeadlineCountdownProps {
    /** Firestore Timestamp or JS Date or ISO string */
    deadline: any;
    /** If true, shows a compact inline version */
    compact?: boolean;
}

interface TimeLeft {
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    isPast: boolean;
    totalMs: number;
}

function computeTimeLeft(deadline: any): TimeLeft {
    try {
        let target: Date;
        if (deadline?.seconds) target = new Date(deadline.seconds * 1000);
        else if (deadline?.toDate) target = deadline.toDate();
        else target = new Date(deadline);

        const now = Date.now();
        const diff = target.getTime() - now;

        if (diff <= 0) {
            return { days: 0, hours: 0, minutes: 0, seconds: 0, isPast: true, totalMs: diff };
        }

        const totalSeconds = Math.floor(diff / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return { days, hours, minutes, seconds, isPast: false, totalMs: diff };
    } catch {
        return { days: 0, hours: 0, minutes: 0, seconds: 0, isPast: true, totalMs: -1 };
    }
}

// ─── Main Countdown Component ─────────────────────────────────────────────────
export default function RegistrationDeadlineCountdown({
    deadline,
    compact = false,
}: DeadlineCountdownProps) {
    const [timeLeft, setTimeLeft] = useState<TimeLeft>(() => computeTimeLeft(deadline));

    // Real-time update every second
    useEffect(() => {
        const tick = () => setTimeLeft(computeTimeLeft(deadline));
        tick(); // immediate initial
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [deadline]);

    // ── Urgency levels based on time remaining ────────────────────────────────
    const isUrgent = !timeLeft.isPast && timeLeft.totalMs < 48 * 60 * 60 * 1000; // < 48 hours
    const isCritical = !timeLeft.isPast && timeLeft.totalMs < 6 * 60 * 60 * 1000; // < 6 hours

    // ── Closed state ──────────────────────────────────────────────────────────
    if (timeLeft.isPast) {
        if (compact) {
            return (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold">
                    <XCircle className="w-3 h-3" />
                    Registration Closed
                </div>
            );
        }
        return (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                <div>
                    <p className="text-red-400 font-semibold text-sm">Registration Closed</p>
                    <p className="text-red-400/60 text-xs">The deadline for this event has passed.</p>
                </div>
            </div>
        );
    }

    // ── Compact inline variant ────────────────────────────────────────────────
    if (compact) {
        const color = isCritical ? 'text-red-400 border-red-500/30 bg-red-500/10'
            : isUrgent ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
                : 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10';

        return (
            <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${color}`}>
                <Timer className="w-3 h-3" />
                {timeLeft.days > 0 && `${timeLeft.days}d `}
                {`${timeLeft.hours.toString().padStart(2, '0')}:${timeLeft.minutes.toString().padStart(2, '0')}:${timeLeft.seconds.toString().padStart(2, '0')}`}
                {' '}left
            </div>
        );
    }

    // ── Full countdown display ────────────────────────────────────────────────
    const bgColor = isCritical
        ? 'bg-red-500/10 border-red-500/25'
        : isUrgent
            ? 'bg-amber-500/10 border-amber-500/25'
            : 'bg-indigo-500/10 border-indigo-500/20';

    const textColor = isCritical ? 'text-red-400' : isUrgent ? 'text-amber-400' : 'text-indigo-400';

    const units = [
        { label: 'Days', value: timeLeft.days },
        { label: 'Hours', value: timeLeft.hours },
        { label: 'Mins', value: timeLeft.minutes },
        { label: 'Secs', value: timeLeft.seconds },
    ];

    return (
        <div className={`rounded-2xl border p-4 ${bgColor}`}>
            <div className="flex items-center gap-2 mb-3">
                {isCritical ? (
                    <AlertTriangle className={`w-4 h-4 ${textColor} shrink-0`} />
                ) : (
                    <Clock className={`w-4 h-4 ${textColor} shrink-0`} />
                )}
                <span className={`text-sm font-semibold ${textColor}`}>
                    {isCritical ? '⚡ Closing Soon — Register Now!' : isUrgent ? '⏳ Deadline Approaching' : '📅 Registration Closes In'}
                </span>
            </div>

            {/* Flip-counter style digit blocks */}
            <div className="flex items-center gap-2 justify-center">
                {units.map(({ label, value }) => (
                    <div key={label} className="flex flex-col items-center">
                        <div
                            className={`
                min-w-[52px] h-[52px] rounded-xl flex items-center justify-center
                font-black text-2xl tabular-nums
                ${isCritical
                                    ? 'bg-red-500/20 text-red-300'
                                    : isUrgent
                                        ? 'bg-amber-500/20 text-amber-300'
                                        : 'bg-indigo-500/20 text-indigo-300'
                                }
              `}
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                            {value.toString().padStart(2, '0')}
                        </div>
                        <span className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wider">{label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
