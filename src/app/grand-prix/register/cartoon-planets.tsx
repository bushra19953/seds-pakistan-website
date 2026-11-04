'use client';

/**
 * Cartoon planets for the Grand Prix portal, drawn as inline SVG in the
 * bright educational solar-system poster style the task owner picked:
 * a ringed Saturn-like planet with a small red planet on the left, a blue
 * gas giant with a small rocky planet on the right. Pure CSS float / sway /
 * orbit animations, soft glows, edge-anchored so the centre of the page
 * (title, countdown, form) stays clear. A tiny satellite orbits Saturn.
 */
export default function CartoonPlanets() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <style>{`
        @keyframes gpFloatA { from { transform: translateY(-8px); } to { transform: translateY(10px); } }
        @keyframes gpFloatB { from { transform: translateY(9px); } to { transform: translateY(-9px); } }
        @keyframes gpSway { from { transform: rotate(-1.6deg); } to { transform: rotate(1.6deg); } }
        @keyframes gpOrbit { from { transform: translate(-50%, -50%) rotate(0deg); } to { transform: translate(-50%, -50%) rotate(360deg); } }
        .gp-float-a { animation: gpFloatA 9s ease-in-out infinite alternate; }
        .gp-float-b { animation: gpFloatB 11s ease-in-out infinite alternate; }
        .gp-sway { animation: gpSway 16s ease-in-out infinite alternate; transform-origin: center; }
        .gp-orbit { animation: gpOrbit 52s linear infinite; }
        .gp-cluster-left { transform-origin: left center; }
        .gp-cluster-right { transform-origin: right center; }
        @media (max-width: 1150px) {
          .gp-cluster-left { transform: scale(0.72); }
          .gp-cluster-right { transform: scale(0.72); }
        }
        @media (max-width: 760px) {
          .gp-cluster-left { transform: scale(0.46); opacity: 0.6; }
          .gp-cluster-right { transform: scale(0.46); opacity: 0.6; }
        }
        @media (prefers-reduced-motion: reduce) {
          .gp-float-a, .gp-float-b, .gp-sway, .gp-orbit { animation: none; }
        }
      `}</style>

      {/* LEFT CLUSTER: ringed planet + orbiting satellite + small red planet */}
      <div className="gp-cluster-left absolute" style={{ left: '0.5%', top: '19%' }}>
        <div className="gp-float-a relative" style={{ width: 310 }}>
          {/* orbit ring for the satellite */}
          <div
            className="gp-orbit absolute rounded-full border border-dashed border-white/10"
            style={{ left: '50%', top: '47%', width: 356, height: 356 }}
          >
            <svg
              viewBox="0 0 60 40"
              className="absolute"
              style={{ top: -16, left: '50%', transform: 'translateX(-50%)', width: 46 }}
            >
              <rect x="25" y="11" width="10" height="18" rx="2" fill="#E8CF8F" stroke="#8a6a2f" />
              <rect x="2" y="14" width="20" height="12" rx="2" fill="#4F83CC" stroke="#274690" />
              <rect x="38" y="14" width="20" height="12" rx="2" fill="#4F83CC" stroke="#274690" />
              <circle cx="30" cy="8" r="3.5" fill="#F5F0E4" stroke="#8a6a2f" />
            </svg>
          </div>

          <svg viewBox="0 0 320 240" className="gp-sway w-full" style={{ filter: 'drop-shadow(0 0 26px rgba(242,166,90,0.35))' }}>
            <defs>
              <linearGradient id="saturnBands" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffdfba" />
                <stop offset="24%" stopColor="#ffc98f" />
                <stop offset="44%" stopColor="#ff9e7a" />
                <stop offset="60%" stopColor="#ffc98f" />
                <stop offset="80%" stopColor="#ffdfba" />
                <stop offset="100%" stopColor="#f2a65a" />
              </linearGradient>
              <radialGradient id="saturnShade" cx="0.36" cy="0.3" r="0.95">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
                <stop offset="52%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="100%" stopColor="#2b1040" stopOpacity="0.3" />
              </radialGradient>
              <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#d9a45c" />
                <stop offset="50%" stopColor="#f7e3ae" />
                <stop offset="100%" stopColor="#d9a45c" />
              </linearGradient>
              <clipPath id="saturnClip">
                <circle cx="160" cy="120" r="64" />
              </clipPath>
            </defs>
            <g transform="rotate(-10 160 120)">
              <ellipse cx="160" cy="120" rx="148" ry="36" fill="none" stroke="url(#ringGrad)" strokeWidth="15" opacity="0.95" />
              <circle cx="160" cy="120" r="64" fill="url(#saturnBands)" />
              <g clipPath="url(#saturnClip)">
                <rect x="96" y="88" width="128" height="9" fill="#ffffff" opacity="0.18" />
                <rect x="96" y="112" width="128" height="7" fill="#c65a2e" opacity="0.16" />
                <rect x="96" y="134" width="128" height="10" fill="#ffffff" opacity="0.14" />
              </g>
              <circle cx="160" cy="120" r="64" fill="url(#saturnShade)" />
              <path d="M 12 120 A 148 36 0 0 0 308 120" fill="none" stroke="url(#ringGrad)" strokeWidth="15" opacity="0.98" />
            </g>
          </svg>

          {/* small red planet */}
          <svg
            viewBox="0 0 120 120"
            className="gp-float-b absolute"
            style={{ width: 86, right: -6, bottom: -34, filter: 'drop-shadow(0 0 16px rgba(242,112,63,0.4))' }}
          >
            <defs>
              <radialGradient id="marsGrad" cx="0.36" cy="0.3" r="0.95">
                <stop offset="0%" stopColor="#ffb27a" />
                <stop offset="45%" stopColor="#f2703f" />
                <stop offset="78%" stopColor="#c33d21" />
                <stop offset="100%" stopColor="#8f2418" />
              </radialGradient>
              <radialGradient id="marsShade" cx="0.36" cy="0.3" r="0.95">
                <stop offset="55%" stopColor="#000000" stopOpacity="0" />
                <stop offset="100%" stopColor="#1e0000" stopOpacity="0.35" />
              </radialGradient>
            </defs>
            <circle cx="60" cy="60" r="46" fill="url(#marsGrad)" />
            <ellipse cx="42" cy="72" rx="14" ry="8" fill="#a02c17" opacity="0.45" />
            <ellipse cx="76" cy="48" rx="10" ry="6" fill="#a02c17" opacity="0.4" />
            <ellipse cx="66" cy="84" rx="8" ry="5" fill="#a02c17" opacity="0.35" />
            <circle cx="48" cy="44" r="5" fill="#00000022" stroke="#ffffff2e" />
            <circle cx="82" cy="70" r="4" fill="#00000022" stroke="#ffffff2e" />
            <ellipse cx="60" cy="17" rx="13" ry="5" fill="#ffffff" opacity="0.75" />
            <circle cx="60" cy="60" r="46" fill="url(#marsShade)" />
          </svg>
        </div>
      </div>

      {/* RIGHT CLUSTER: blue gas giant + small rocky planet */}
      <div className="gp-cluster-right absolute" style={{ right: '1%', top: '47%' }}>
        <div className="gp-float-b relative" style={{ width: 225 }}>
          <svg viewBox="0 0 220 220" className="gp-sway w-full" style={{ filter: 'drop-shadow(0 0 26px rgba(111,177,255,0.35))' }}>
            <defs>
              <radialGradient id="neptuneGrad" cx="0.36" cy="0.3" r="0.98">
                <stop offset="0%" stopColor="#cfeaff" />
                <stop offset="35%" stopColor="#6fb1ff" />
                <stop offset="66%" stopColor="#3d6fd1" />
                <stop offset="100%" stopColor="#274690" />
              </radialGradient>
              <radialGradient id="neptuneShade" cx="0.36" cy="0.3" r="0.98">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.3" />
                <stop offset="52%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="100%" stopColor="#0a1030" stopOpacity="0.32" />
              </radialGradient>
              <clipPath id="neptuneClip">
                <circle cx="110" cy="110" r="74" />
              </clipPath>
            </defs>
            <g transform="rotate(-16 110 110)">
              <ellipse cx="110" cy="110" rx="102" ry="19" fill="none" stroke="#bcd8ff" strokeWidth="4" opacity="0.45" />
            </g>
            <circle cx="110" cy="110" r="74" fill="url(#neptuneGrad)" />
            <g clipPath="url(#neptuneClip)">
              <ellipse cx="110" cy="82" rx="80" ry="10" fill="#ffffff" opacity="0.13" />
              <ellipse cx="110" cy="106" rx="80" ry="8" fill="#ffffff" opacity="0.1" />
              <ellipse cx="110" cy="140" rx="80" ry="11" fill="#123a7a" opacity="0.14" />
              <ellipse cx="140" cy="126" rx="17" ry="9" fill="#eaf7ff" opacity="0.85" />
              <ellipse cx="140" cy="126" rx="9" ry="4.5" fill="#ffffff" opacity="0.9" />
            </g>
            <circle cx="110" cy="110" r="74" fill="url(#neptuneShade)" />
            <g transform="rotate(-16 110 110)">
              <path d="M 8 110 A 102 19 0 0 0 212 110" fill="none" stroke="#bcd8ff" strokeWidth="4" opacity="0.55" />
            </g>
          </svg>

          {/* small rocky planet */}
          <svg
            viewBox="0 0 100 100"
            className="gp-float-a absolute"
            style={{ width: 68, left: -38, top: -30, filter: 'drop-shadow(0 0 14px rgba(200,169,126,0.4))' }}
          >
            <defs>
              <radialGradient id="rockGrad" cx="0.36" cy="0.3" r="0.95">
                <stop offset="0%" stopColor="#f0dcba" />
                <stop offset="45%" stopColor="#c8a97e" />
                <stop offset="80%" stopColor="#8a6a44" />
                <stop offset="100%" stopColor="#5f4226" />
              </radialGradient>
              <radialGradient id="rockShade" cx="0.36" cy="0.3" r="0.95">
                <stop offset="55%" stopColor="#000000" stopOpacity="0" />
                <stop offset="100%" stopColor="#140a00" stopOpacity="0.35" />
              </radialGradient>
            </defs>
            <circle cx="50" cy="50" r="38" fill="url(#rockGrad)" />
            <circle cx="36" cy="38" r="7" fill="#46321459" stroke="#ffe9c233" />
            <circle cx="62" cy="58" r="9" fill="#46321459" stroke="#ffe9c233" />
            <circle cx="44" cy="68" r="4.5" fill="#46321459" stroke="#ffe9c233" />
            <circle cx="68" cy="32" r="4" fill="#46321459" stroke="#ffe9c233" />
            <circle cx="50" cy="50" r="38" fill="url(#rockShade)" />
          </svg>
        </div>
      </div>
    </div>
  );
}
