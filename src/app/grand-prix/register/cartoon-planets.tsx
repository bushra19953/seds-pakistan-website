'use client';

/**
 * Cartoon space backdrop for the Grand Prix portal, drawn as inline SVG in
 * the bright educational solar-system poster style the task owner picked:
 * a ringed Saturn-like planet with a small red planet on the left, a blue
 * gas giant with a small rocky planet on the right, TWO satellites orbiting
 * each large planet, tumbling asteroids, falling comets, and a detailed
 * cartoon rocket in the portal palette (steel-blue nose, silver body,
 * muted fins, soft blue flame) that rises from the bottom right corner,
 * flies diagonally up-left, fades out as it leaves through the top, and
 * reappears from the bottom. Pure CSS
 * animations, soft glows, edge-anchored so the centre of the page (title,
 * countdown, form) stays clear.
 */
export default function CartoonPlanets() {
  const satellite = (size: number, panels: string, bus: string) => (
    <svg viewBox="0 0 60 40" style={{ width: size }}>
      <rect x="25" y="11" width="10" height="18" rx="2" fill={bus} stroke="#8a6a2f" />
      <rect x="2" y="14" width="20" height="12" rx="2" fill={panels} stroke="#274690" />
      <rect x="38" y="14" width="20" height="12" rx="2" fill={panels} stroke="#274690" />
      <circle cx="30" cy="8" r="3.5" fill="#F5F0E4" stroke="#8a6a2f" />
    </svg>
  );

  const orbit = (
    size: number,
    duration: number,
    reverse: boolean,
    child: React.ReactNode,
    childStyle: React.CSSProperties,
  ) => (
    <div
      className={reverse ? 'gp-orbit gp-orbit-rev absolute rounded-full border border-dashed border-white/10' : 'gp-orbit absolute rounded-full border border-dashed border-white/10'}
      style={{ left: '50%', top: '50%', width: size, height: size, animationDuration: `${duration}s` }}
    >
      <div className="absolute" style={childStyle}>
        {child}
      </div>
    </div>
  );

  const asteroids = [
    { left: '11%', top: '5%', size: 36, dur: 34, delay: 0 },
    { left: '23%', top: '60%', size: 22, dur: 27, delay: 3 },
    { right: '15%', top: '10%', size: 27, dur: 39, delay: 1.5 },
    { right: '25%', top: '68%', size: 40, dur: 44, delay: 5 },
    { left: '37%', top: '2%', size: 18, dur: 24, delay: 2 },
    { right: '38%', top: '90%', size: 21, dur: 31, delay: 4 },
    { left: '3.5%', top: '76%', size: 29, dur: 37, delay: 6 },
  ];

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <style>{`
        @keyframes gpFloatA { from { transform: translateY(-8px); } to { transform: translateY(10px); } }
        @keyframes gpFloatB { from { transform: translateY(9px); } to { transform: translateY(-9px); } }
        @keyframes gpSway { from { transform: rotate(-1.6deg); } to { transform: rotate(1.6deg); } }
        @keyframes gpOrbit { from { transform: translate(-50%, -50%) rotate(0deg); } to { transform: translate(-50%, -50%) rotate(360deg); } }
        @keyframes gpTumble {
          from { transform: translateY(-6px) rotate(0deg); }
          to { transform: translateY(16px) rotate(300deg); }
        }
        @keyframes gpCometFall {
          0% { transform: translate(0, 0); opacity: 0; }
          5% { opacity: 1; }
          30% { transform: translate(-46vw, 42vh); opacity: 1; }
          37% { transform: translate(-54vw, 49vh); opacity: 0; }
          100% { transform: translate(-54vw, 49vh); opacity: 0; }
        }
        .gp-float-a { animation: gpFloatA 9s ease-in-out infinite alternate; }
        .gp-float-b { animation: gpFloatB 11s ease-in-out infinite alternate; }
        .gp-sway { animation: gpSway 16s ease-in-out infinite alternate; transform-origin: center; }
        .gp-orbit { animation: gpOrbit 52s linear infinite; }
        .gp-orbit-rev { animation-direction: reverse; }
        .gp-tumble { animation: gpTumble 30s ease-in-out infinite alternate; }
        .gp-comet { animation: gpCometFall 13s linear infinite; }
        .gp-comet-2 { animation-duration: 19s; animation-delay: 7s; }
        .gp-comet-tail {
          position: absolute; left: 5px; top: 50%; height: 3px; border-radius: 9999px;
          transform: translateY(-50%) rotate(-42deg); transform-origin: left center;
          background: linear-gradient(90deg, rgba(255,244,200,0.95), rgba(232,207,143,0.45) 40%, rgba(232,207,143,0));
        }
        .gp-comet-head {
          position: absolute; left: 0; top: 50%; width: 9px; height: 9px; border-radius: 9999px;
          transform: translateY(-50%); background: #fff6d8;
          box-shadow: 0 0 14px 4px rgba(255,240,190,0.8);
        }
        .gp-cluster-left { transform-origin: left center; }
        .gp-cluster-right { transform-origin: right center; }
        @keyframes gpRocketRise {
          from { transform: translate(3vw, 28vh) rotate(-32deg); }
          to { transform: translate(-42vw, -105vh) rotate(-32deg); }
        }
        @keyframes gpRocketFade {
          0% { opacity: 1; }
          74% { opacity: 1; }
          90% { opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes gpFlameFlicker {
          from { transform: scaleY(0.9) scaleX(1); }
          to { transform: scaleY(1.2) scaleX(0.93); }
        }
        .gp-rocket { animation: gpRocketRise 20s cubic-bezier(0.35, 0.08, 0.62, 0.55) infinite, gpRocketFade 20s linear infinite; }
        .gp-flame {
          animation: gpFlameFlicker 0.16s ease-in-out infinite alternate;
          transform-box: fill-box; transform-origin: 50% 0%;
        }
        .gp-rocket-trail {
          position: absolute; left: 50%; top: 80%; width: 30px; height: 200px;
          transform: translateX(-50%); border-radius: 9999px; filter: blur(7px);
          background: linear-gradient(to bottom, rgba(120,190,255,0.5), rgba(80,150,240,0.18) 45%, rgba(80,150,240,0));
        }
        .gp-rocket-zone { transform-origin: bottom right; }
        @media (max-width: 1150px) {
          .gp-cluster-left { transform: scale(0.66); }
          .gp-cluster-right { transform: scale(0.66); }
          .gp-rocket-zone { transform: scale(0.78); }
        }
        @media (max-width: 760px) {
          .gp-cluster-left { transform: translate(-54px, -6px) scale(0.34); opacity: 0.35; }
          .gp-cluster-right { transform: translate(54px, 130px) scale(0.34); opacity: 0.35; }
          .gp-rocket-zone { transform: scale(0.72); opacity: 0.8; }
          .gp-rocket { animation-duration: 34s, 34s; }
          @keyframes gpRocketRise {
            from { transform: translate(2vw, 34vh) rotate(-16deg); }
            to { transform: translate(-51vw, -136vh) rotate(-16deg); }
          }
          @keyframes gpRocketFade {
            0% { opacity: 1; }
            80% { opacity: 1; }
            95% { opacity: 0; }
            100% { opacity: 0; }
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .gp-float-a, .gp-float-b, .gp-sway, .gp-orbit, .gp-tumble, .gp-comet, .gp-rocket, .gp-flame { animation: none; }
        }
      `}</style>

      {/* shared asteroid shading */}
      <svg width="0" height="0" className="absolute">
        <defs>
          <radialGradient id="astGrad" cx="0.36" cy="0.3" r="0.95">
            <stop offset="0%" stopColor="#cbb593" />
            <stop offset="50%" stopColor="#8a7358" />
            <stop offset="100%" stopColor="#54432c" />
          </radialGradient>
        </defs>
      </svg>

      {/* COMETS */}
      <div className="gp-comet absolute" style={{ right: '13%', top: '1%' }}>
        <div className="gp-comet-tail" style={{ width: 150 }} />
        <div className="gp-comet-head" />
      </div>
      <div className="gp-comet gp-comet-2 absolute" style={{ right: '43%', top: '-3%' }}>
        <div className="gp-comet-tail" style={{ width: 110 }} />
        <div className="gp-comet-head" />
      </div>

      {/* ASTEROIDS */}
      {asteroids.map((a, i) => (
        <svg
          key={i}
          viewBox="0 0 100 100"
          className="gp-tumble absolute"
          style={{
            width: a.size,
            left: a.left,
            right: a.right,
            top: a.top,
            animationDuration: `${a.dur}s`,
            animationDelay: `${a.delay}s`,
            filter: 'drop-shadow(0 0 8px rgba(160,130,90,0.35))',
          }}
        >
          <path
            d="M50 6 C70 4 90 22 93 44 C96 64 86 84 66 93 C46 101 22 95 12 76 C2 57 8 30 24 16 C33 8 40 7 50 6 Z"
            fill="url(#astGrad)"
          />
          <circle cx="38" cy="36" r="8" fill="#00000030" stroke="#ffffff22" />
          <circle cx="64" cy="58" r="10" fill="#00000030" stroke="#ffffff22" />
          <circle cx="44" cy="70" r="5" fill="#00000030" stroke="#ffffff22" />
        </svg>
      ))}

      {/* LEFT CLUSTER: ringed planet + 2 orbiting satellites + small red planet */}
      <div className="gp-cluster-left absolute" style={{ left: '0.5%', top: '17%' }}>
        <div className="gp-float-a relative" style={{ width: 400 }}>
          {orbit(478, 46, false, satellite(48, '#4F83CC', '#E8CF8F'), { top: -18, left: '50%', transform: 'translateX(-50%)' })}
          {orbit(592, 74, true, satellite(36, '#7FB2F0', '#F5F0E4'), { bottom: -14, left: '50%', transform: 'translateX(-50%)' })}

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
            style={{ width: 108, right: -2, bottom: -42, filter: 'drop-shadow(0 0 16px rgba(242,112,63,0.4))' }}
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

      {/* RIGHT CLUSTER: blue gas giant + 2 orbiting satellites + small rocky planet */}
      <div className="gp-cluster-right absolute" style={{ right: '1%', top: '44%' }}>
        <div className="gp-float-b relative" style={{ width: 300 }}>
          {orbit(356, 42, false, satellite(44, '#4F83CC', '#E8CF8F'), { top: -16, left: '50%', transform: 'translateX(-50%)' })}
          {orbit(452, 66, true, satellite(33, '#7FB2F0', '#F5F0E4'), { bottom: -12, left: '50%', transform: 'translateX(-50%)' })}

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
            style={{ width: 86, left: -48, top: -38, filter: 'drop-shadow(0 0 14px rgba(200,169,126,0.4))' }}
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

      {/* ROCKET: detailed cartoon rocket in the portal's own palette
          (steel-blue nose, silver body, muted fins, soft blue flame).
          Flight loop: starts fully below the bottom edge and emerges as it
          rises from the bottom right corner (no fade-in), crosses diagonally
          toward the top left, fades away while leaving through the top
          edge, rests off-screen, then emerges from the bottom again. */}
      <div className="gp-rocket-zone absolute" style={{ right: '4.5%', bottom: '2%' }}>
        <div className="gp-rocket relative" style={{ width: 118 }}>
          <div className="gp-rocket-trail" />
          <svg
            viewBox="0 0 220 336"
            className="relative w-full"
            style={{ filter: 'drop-shadow(0 0 24px rgba(110,175,255,0.42))' }}
          >
            <defs>
              <linearGradient id="rocketBody" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#fbfcfd" />
                <stop offset="55%" stopColor="#dde4ea" />
                <stop offset="100%" stopColor="#a7b3bf" />
              </linearGradient>
              <linearGradient id="noseGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#9dbdd4" />
                <stop offset="55%" stopColor="#6d90ab" />
                <stop offset="100%" stopColor="#476a86" />
              </linearGradient>
              <linearGradient id="finGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#bccfdd" />
                <stop offset="100%" stopColor="#7e97ab" />
              </linearGradient>
              <linearGradient id="flameOuter" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#57a8ff" />
                <stop offset="70%" stopColor="#57a8ff" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#57a8ff" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="flameMid" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#9fd4ff" />
                <stop offset="100%" stopColor="#9fd4ff" stopOpacity="0.15" />
              </linearGradient>
            </defs>

            {/* flame, flickers from the nozzle: wide teardrop like the reference */}
            <g className="gp-flame">
              <path d="M110 254 C 129 273 135 297 110 332 C 85 297 91 273 110 254 Z" fill="url(#flameOuter)" />
              <path d="M110 256 C 123 270 127 287 110 312 C 93 287 97 270 110 256 Z" fill="url(#flameMid)" />
              <path d="M110 258 C 118 268 120 280 110 296 C 100 280 102 268 110 258 Z" fill="#f2fbff" />
            </g>

            {/* side fins: long frame-style legs sweeping out and down past
                the body, pale inset panel inside a coloured frame */}
            <path d="M72 158 L28 236 L28 290 L52 290 L74 210 Z" fill="url(#finGrad)" />
            <path d="M69 182 L42 240 L42 276 L50 276 L67 216 Z" fill="#e9eef3" opacity="0.85" />
            <path d="M148 158 L192 236 L192 290 L168 290 L146 210 Z" fill="url(#finGrad)" />
            <path d="M151 182 L178 240 L178 276 L170 276 L153 216 Z" fill="#e9eef3" opacity="0.85" />

            {/* engine nozzle, tucked under the body */}
            <path d="M94 240 L126 240 L120 259 L100 259 Z" fill="#5b6570" />
            <rect x="101" y="255" width="18" height="4.5" rx="2" fill="#39424c" />

            {/* body: short and wide like the reference, panel seams across */}
            <rect x="68" y="92" width="84" height="150" rx="10" fill="url(#rocketBody)" stroke="#7c8896" strokeOpacity="0.35" />
            {/* nose cone: smooth rounded bullet curve */}
            <path d="M68 102 C 72 56 89 20 110 5 C 131 20 148 56 152 102 C 134 89 86 89 68 102 Z" fill="url(#noseGrad)" />
            <path d="M95 24 C 86 38 80 56 78 74" fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="4" strokeLinecap="round" />
            {/* window */}
            <circle cx="110" cy="124" r="13" fill="#1d2f47" stroke="#8fa5ba" strokeWidth="4" />
            <circle cx="105" cy="119" r="3.8" fill="#ffffff" opacity="0.85" />
            {/* panel seams + small body dots from the reference */}
            <line x1="70" y1="158" x2="150" y2="158" stroke="#8d99a7" strokeOpacity="0.55" strokeWidth="1.6" />
            <line x1="70" y1="200" x2="150" y2="200" stroke="#8d99a7" strokeOpacity="0.55" strokeWidth="1.6" />
            <ellipse cx="110" cy="179" rx="2.8" ry="4.2" fill="#546b7d" />
            <ellipse cx="110" cy="212" rx="2.8" ry="4.2" fill="#546b7d" />
            {/* steel band near the base */}
            <rect x="68" y="224" width="84" height="13" fill="#546b7d" opacity="0.85" />
            {/* body highlight */}
            <rect x="76" y="104" width="7" height="128" rx="3.5" fill="#ffffff" opacity="0.4" />
            {/* centre fin: long teardrop down the front, muted brick */}
            <path d="M110 198 C 123 218 125 246 110 284 C 95 246 97 218 110 198 Z" fill="#bd6a4a" />
          </svg>
        </div>
      </div>
    </div>
  );
}
