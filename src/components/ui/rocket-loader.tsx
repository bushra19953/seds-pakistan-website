'use client';
import { useEffect, useState } from 'react';

const DEFAULT_MESSAGES = [
  'Fueling the rocket...',
  'Calibrating star charts...',
  'Polishing the viewport...',
  'Counting down to orbit...',
];

interface RocketLoaderProps {
  messages?: string[];
  compact?: boolean;
  className?: string;
}

/**
 * RocketLoader — a playful launch-scene loading state so waits feel like
 * a countdown instead of a stall. Pure CSS + inline SVG, no dependencies.
 */
export function RocketLoader({ messages = DEFAULT_MESSAGES, compact = false, className = '' }: RocketLoaderProps) {
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    if (messages.length < 2) return;
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), 2200);
    return () => clearInterval(id);
  }, [messages.length]);

  const stars = Array.from({ length: 40 }, (_, i) => {
    const left = (i * 37 + 13) % 100;
    const top = (i * 53 + 7) % 100;
    const size = (i % 3) + 1;
    const delay = (i % 7) * 0.4;
    return { left, top, size, delay };
  });

  return (
    <div className={`rl-scope relative flex flex-col items-center justify-center overflow-hidden ${compact ? 'py-10' : 'min-h-[60vh] py-16'} ${className}`}>
      <style>{`
        .rl-scope .rl-star { position: absolute; border-radius: 9999px; background: #fff; animation: rl-twinkle 2.4s ease-in-out infinite; }
        @keyframes rl-twinkle { 0%, 100% { opacity: 0.15; transform: scale(0.8); } 50% { opacity: 0.9; transform: scale(1.15); } }
        .rl-scope .rl-rocket { animation: rl-hover 2.6s ease-in-out infinite; filter: drop-shadow(0 0 24px rgba(251,146,60,0.35)); }
        @keyframes rl-hover { 0%, 100% { transform: translateY(6px); } 50% { transform: translateY(-8px); } }
        .rl-scope .rl-flame { transform-origin: 50px 118px; animation: rl-flicker 0.28s ease-in-out infinite alternate; }
        @keyframes rl-flicker { from { transform: scaleY(1) scaleX(1); opacity: 1; } to { transform: scaleY(1.25) scaleX(0.88); opacity: 0.85; } }
        .rl-scope .rl-smoke { transform-origin: 50px 150px; animation: rl-puff 2.2s ease-out infinite; opacity: 0; }
        .rl-scope .rl-smoke.s2 { animation-delay: 0.7s; }
        .rl-scope .rl-smoke.s3 { animation-delay: 1.4s; }
        @keyframes rl-puff { 0% { transform: translateY(0) scale(0.4); opacity: 0; } 25% { opacity: 0.55; } 100% { transform: translateY(46px) scale(1.6); opacity: 0; } }
        .rl-scope .rl-msg { animation: rl-msgfade 2.2s ease-in-out infinite; }
        @keyframes rl-msgfade { 0% { opacity: 0; transform: translateY(6px); } 12%, 88% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-6px); } }
        .rl-scope .rl-ground { background: radial-gradient(ellipse at center, rgba(148,163,184,0.25) 0%, transparent 70%); }
      `}</style>

      {/* night sky */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#050816] via-[#0a1030] to-[#131a3a]" />
      {stars.map((s, i) => (
        <span
          key={i}
          className="rl-star pointer-events-none"
          style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, animationDelay: `${s.delay}s` }}
        />
      ))}

      {/* rocket scene */}
      <div className="relative">
        <svg className="rl-rocket relative z-10" width="120" height="170" viewBox="0 0 100 170" fill="none" aria-hidden="true">
          {/* flame */}
          <g className="rl-flame">
            <ellipse cx="50" cy="132" rx="10" ry="22" fill="#fb923c" />
            <ellipse cx="50" cy="128" rx="6" ry="14" fill="#fde047" />
            <ellipse cx="50" cy="124" rx="3" ry="8" fill="#fff7ed" />
          </g>
          {/* smoke puffs */}
          <g fill="#cbd5e1">
            <ellipse className="rl-smoke" cx="50" cy="156" rx="14" ry="7" />
            <ellipse className="rl-smoke s2" cx="38" cy="158" rx="11" ry="6" />
            <ellipse className="rl-smoke s3" cx="62" cy="158" rx="11" ry="6" />
          </g>
          {/* fins */}
          <path d="M32 96 L20 122 L34 116 Z" fill="#ef4444" />
          <path d="M68 96 L80 122 L66 116 Z" fill="#ef4444" />
          {/* body */}
          <rect x="32" y="34" width="36" height="72" rx="14" fill="#f1f5f9" />
          <rect x="32" y="34" width="36" height="72" rx="14" fill="url(#rl-body-shade)" />
          {/* nose cone */}
          <path d="M32 44 C32 24 40 12 50 12 C60 12 68 24 68 44 Z" fill="#ef4444" />
          {/* window */}
          <circle cx="50" cy="62" r="10" fill="#0ea5e9" />
          <circle cx="50" cy="62" r="10" fill="none" stroke="#94a3b8" strokeWidth="3" />
          <circle cx="46.5" cy="58.5" r="3" fill="#bae6fd" opacity="0.9" />
          {/* belly band */}
          <rect x="32" y="92" width="36" height="8" fill="#ef4444" opacity="0.9" />
          <defs>
            <linearGradient id="rl-body-shade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#0f172a" stopOpacity="0.25" />
              <stop offset="45%" stopColor="#0f172a" stopOpacity="0" />
              <stop offset="100%" stopColor="#0f172a" stopOpacity="0.18" />
            </linearGradient>
          </defs>
        </svg>
        {/* launch pad glow */}
        <div className="rl-ground absolute -bottom-4 left-1/2 h-10 w-40 -translate-x-1/2 rounded-full" />
      </div>

      {/* status message */}
      <p key={msgIndex} className="rl-msg relative z-10 mt-8 text-center text-sm font-medium tracking-wide text-slate-300">
        {messages[msgIndex % messages.length]}
      </p>
      {/* progress shimmer bar */}
      <div className="relative z-10 mt-4 h-1 w-44 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-orange-400 via-amber-300 to-orange-400 rl-msg" />
      </div>
    </div>
  );
}

export default RocketLoader;
