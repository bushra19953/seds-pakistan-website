/**
 * Hero flags for the bilateral hero: the OFFICIAL flag artwork, self-hosted
 * under public/flags/ (no external hotlinking). Sources, both public domain,
 * from Wikimedia Commons: "Flag of Pakistan.svg" and "Flag of Sri Lanka.svg".
 * The artwork is rendered exactly as published; nothing is simplified or
 * redrawn (the Sri Lanka lion appears in full).
 */

export function PakistanFlag({ className }: { className?: string }) {
  return <img src="/flags/pakistan.svg" alt="Flag of Pakistan" className={className} />;
}

export function SriLankaFlag({ className }: { className?: string }) {
  return <img src="/flags/sri-lanka.svg" alt="Flag of Sri Lanka" className={className} />;
}

/**
 * The wider SEDS family: small inline flags for the "Part of the Global
 * SEDS Family" strip. Same hand-drawn approach as the hero flags, with
 * softened, muted colours to sit quietly under the Patrons strip.
 * Complex emblems are simplified the way the Sri Lanka lion was:
 * Kazakhstan's eagle becomes a soaring silhouette, Mexico's coat of
 * arms a gold medallion, Zimbabwe's bird a small gold glyph.
 */

function FlagSheen({ id }: { id: string }) {
  return (
    <>
      <rect x="0" y="0" width="90" height="60" fill={`url(#${id})`} pointerEvents="none" />
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.10" />
          <stop offset="45%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </linearGradient>
      </defs>
    </>
  );
}

function starPoints(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  n = 5,
  rot = -90,
): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((rot + (i * 180) / n) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

export function IndiaFlag({ className }: { className?: string }) {
  const spokes: Array<[number, number]> = [
    [51.5, 30],
    [49.6, 34.6],
    [45, 36.5],
    [40.4, 34.6],
    [38.5, 30],
    [40.4, 25.4],
    [45, 23.5],
    [49.6, 25.4],
  ];
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of India" className={className}>
      <rect x="0" y="0" width="90" height="20" fill="#D98A3D" />
      <rect x="0" y="20" width="90" height="20" fill="#F2EDE2" />
      <rect x="0" y="40" width="90" height="20" fill="#2F7D4F" />
      <circle cx="45" cy="30" r="6.8" fill="none" stroke="#2B3A67" strokeWidth="1.7" />
      {spokes.map(([x, y]) => (
        <line key={`${x}-${y}`} x1="45" y1="30" x2={x} y2={y} stroke="#2B3A67" strokeWidth="0.9" />
      ))}
      <circle cx="45" cy="30" r="1.1" fill="#2B3A67" />
      <FlagSheen id="inSheen" />
    </svg>
  );
}

export function NepalFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 75 60" role="img" aria-label="Flag of Nepal" className={className}>
      <path
        d="M8,3 L56,29 L24,29 L60,57 L8,57 Z"
        fill="#A83A4B"
        stroke="#2E4390"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="15" r="4.2" fill="#F2EDE2" />
      <circle cx="21.9" cy="13.7" r="3.6" fill="#A83A4B" />
      <polygon points={starPoints(22, 44, 5.8, 3.5, 12)} fill="#F2EDE2" />
    </svg>
  );
}

export function UnitedStatesFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of the United States" className={className}>
      {Array.from({ length: 13 }, (_, i) => (
        <rect
          key={i}
          x="0"
          y={(i * 60) / 13}
          width="90"
          height={60 / 13 + 0.25}
          fill={i % 2 === 0 ? '#A83A46' : '#F2EDE2'}
        />
      ))}
      <rect x="0" y="0" width="38" height={(60 / 13) * 7} fill="#3A4066" />
      {Array.from({ length: 5 }, (_, row) =>
        Array.from({ length: 6 }, (_, col) => (
          <circle
            key={`${row}-${col}`}
            cx={3.6 + col * 6.1}
            cy={3.4 + row * 6.4}
            r="1.25"
            fill="#F2EDE2"
          />
        )),
      )}
      <FlagSheen id="usSheen" />
    </svg>
  );
}

export function CanadaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Canada" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#F2EDE2" />
      <rect x="0" y="0" width="20" height="60" fill="#BE3A44" />
      <rect x="70" y="0" width="20" height="60" fill="#BE3A44" />
      <path
        d="M45,16 L47.5,22 L52,19.5 L51,25.5 L56,24 L52.8,28.5 L57,29.5 L51.5,33 L52.5,38.5 L48.5,35.8 L48,44 L42,44 L41.5,35.8 L37.5,38.5 L38.5,33 L33,29.5 L37.2,28.5 L34,24 L39,25.5 L38,19.5 L42.5,22 Z"
        fill="#BE3A44"
      />
      <FlagSheen id="caSheen" />
    </svg>
  );
}

export function UnitedKingdomFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of the United Kingdom" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#2F3A68" />
      <path d="M0,0 L90,60 M90,0 L0,60" stroke="#F2EDE2" strokeWidth="13" />
      <path d="M0,0 L90,60 M90,0 L0,60" stroke="#B03A48" strokeWidth="4.5" />
      <rect x="34" y="0" width="22" height="60" fill="#F2EDE2" />
      <rect x="0" y="19" width="90" height="22" fill="#F2EDE2" />
      <rect x="39" y="0" width="12" height="60" fill="#B03A48" />
      <rect x="0" y="24" width="90" height="12" fill="#B03A48" />
      <FlagSheen id="ukSheen" />
    </svg>
  );
}

export function ItalyFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Italy" className={className}>
      <rect x="0" y="0" width="30" height="60" fill="#3E7D5B" />
      <rect x="30" y="0" width="30" height="60" fill="#F2EDE2" />
      <rect x="60" y="0" width="30" height="60" fill="#BE4A52" />
      <FlagSheen id="itSheen" />
    </svg>
  );
}

export function FranceFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of France" className={className}>
      <rect x="0" y="0" width="30" height="60" fill="#3A4A7D" />
      <rect x="30" y="0" width="30" height="60" fill="#F2EDE2" />
      <rect x="60" y="0" width="30" height="60" fill="#BE4A52" />
      <FlagSheen id="frSheen" />
    </svg>
  );
}

export function GermanyFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Germany" className={className}>
      <rect x="0" y="0" width="90" height="20" fill="#2A2A2E" />
      <rect x="0" y="20" width="90" height="20" fill="#B03A48" />
      <rect x="0" y="40" width="90" height="20" fill="#D9A83F" />
      <FlagSheen id="deSheen" />
    </svg>
  );
}

export function FinlandFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Finland" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#F2EDE2" />
      <rect x="24" y="0" width="11" height="60" fill="#3A5A8C" />
      <rect x="0" y="24.5" width="90" height="11" fill="#3A5A8C" />
      <FlagSheen id="fiSheen" />
    </svg>
  );
}

export function TurkeyFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Turkey" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#B03A48" />
      <circle cx="38" cy="30" r="13" fill="#F2EDE2" />
      <circle cx="41.3" cy="30" r="10.4" fill="#B03A48" />
      <polygon points={starPoints(57, 30, 5.6, 2.25, 5, 180)} fill="#F2EDE2" />
      <FlagSheen id="trSheen" />
    </svg>
  );
}

export function SingaporeFlag({ className }: { className?: string }) {
  const stars: Array<[number, number]> = [
    [31, 7.5],
    [37.5, 12],
    [35, 19.5],
    [27, 19.5],
    [24.5, 12],
  ];
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Singapore" className={className}>
      <rect x="0" y="0" width="90" height="30" fill="#C04552" />
      <rect x="0" y="30" width="90" height="30" fill="#F2EDE2" />
      <circle cx="14" cy="15" r="7.5" fill="#F2EDE2" />
      <circle cx="16.6" cy="15" r="6" fill="#C04552" />
      {stars.map(([x, y]) => (
        <polygon key={`${x}-${y}`} points={starPoints(x, y, 2.3, 0.95)} fill="#F2EDE2" />
      ))}
      <FlagSheen id="sgSheen" />
    </svg>
  );
}

export function KazakhstanFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Kazakhstan" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#57A7C4" />
      <rect x="4" y="0" width="5" height="60" fill="#D9A83F" />
      <polygon points="6.5,7 8.6,10 6.5,13 4.4,10" fill="#57A7C4" />
      <polygon points="6.5,27 8.6,30 6.5,33 4.4,30" fill="#57A7C4" />
      <polygon points="6.5,47 8.6,50 6.5,53 4.4,50" fill="#57A7C4" />
      <polygon points={starPoints(53, 25, 12.5, 7.9, 16)} fill="#D9A83F" />
      <circle cx="53" cy="25" r="7" fill="#D9A83F" />
      {/* Soaring steppe eagle, simplified to a sweeping silhouette. */}
      <path
        d="M35,45 C43,39 49,41 53,44 C57,41 63,39 71,45 C64,46 58,48 53,50 C48,48 42,46 35,45 Z"
        fill="#D9A83F"
      />
      <FlagSheen id="kzSheen" />
    </svg>
  );
}

export function MexicoFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Mexico" className={className}>
      <rect x="0" y="0" width="30" height="60" fill="#2F6B4F" />
      <rect x="30" y="0" width="30" height="60" fill="#F2EDE2" />
      <rect x="60" y="0" width="30" height="60" fill="#B03A48" />
      {/* Coat of arms simplified to a gold medallion with an eagle glyph. */}
      <circle cx="45" cy="30" r="8.4" fill="#F7F2E2" stroke="#C79A3B" strokeWidth="1.6" />
      <path
        d="M45,23.5 L46.8,27.5 L50.5,26.5 L48.2,30 L49.5,33.5 L46.6,32.4 L46.3,36.5 L43.7,36.5 L43.4,32.4 L40.5,33.5 L41.8,30 L39.5,26.5 L43.2,27.5 Z"
        fill="#8A6D2F"
      />
      <rect x="43.8" y="35.8" width="2.4" height="3.2" rx="1.1" fill="#2F6B4F" />
      <FlagSheen id="mxSheen" />
    </svg>
  );
}

export function CostaRicaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Costa Rica" className={className}>
      <rect x="0" y="0" width="90" height="10" fill="#3A5A8C" />
      <rect x="0" y="10" width="90" height="10" fill="#F2EDE2" />
      <rect x="0" y="20" width="90" height="20" fill="#B03A48" />
      <rect x="0" y="40" width="90" height="10" fill="#F2EDE2" />
      <rect x="0" y="50" width="90" height="10" fill="#3A5A8C" />
      <FlagSheen id="crSheen" />
    </svg>
  );
}

export function BrazilFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Brazil" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#2F7D4F" />
      <polygon points="45,6 84,30 45,54 6,30" fill="#D9A83F" />
      <circle cx="45" cy="30" r="13" fill="#2F3A68" />
      <path d="M33.5,35.5 A13,13 0 0 1 56.5,24.5" stroke="#F2EDE2" strokeWidth="2.6" fill="none" />
      <circle cx="40" cy="24" r="0.95" fill="#F2EDE2" />
      <circle cx="49" cy="21.5" r="0.95" fill="#F2EDE2" />
      <circle cx="52" cy="31" r="0.95" fill="#F2EDE2" />
      <circle cx="42" cy="34" r="0.95" fill="#F2EDE2" />
      <circle cx="38" cy="28.5" r="0.8" fill="#F2EDE2" />
      <FlagSheen id="brSheen" />
    </svg>
  );
}

export function ArgentinaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Argentina" className={className}>
      <rect x="0" y="0" width="90" height="20" fill="#74A9C7" />
      <rect x="0" y="20" width="90" height="20" fill="#F5F1E6" />
      <rect x="0" y="40" width="90" height="20" fill="#74A9C7" />
      <polygon points={starPoints(45, 30, 8.2, 5.4, 8)} fill="#D9A83F" />
      <circle cx="45" cy="30" r="4.6" fill="#D9A83F" stroke="#B07E2A" strokeWidth="0.8" />
      <circle cx="43.6" cy="29.2" r="0.5" fill="#8A5E14" />
      <circle cx="46.4" cy="29.2" r="0.5" fill="#8A5E14" />
      <path d="M43.4,31.4 A2.2,2.2 0 0 0 46.6,31.4" stroke="#8A5E14" strokeWidth="0.6" fill="none" />
      <FlagSheen id="arSheen" />
    </svg>
  );
}

export function SouthAfricaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of South Africa" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#35477D" />
      <polygon points="0,0 90,0 90,19 43,26 59,0" fill="#BE4A52" />
      <polygon points="0,5 42,30 0,55" fill="#D9A83F" />
      <polygon points="0,11.5 35.5,30 0,48.5" fill="#232326" />
      <path d="M55,0 L37,30 L55,60 M37,30 L90,30" stroke="#F2EDE2" strokeWidth="14" fill="none" />
      <path d="M55,0 L37,30 L55,60 M37,30 L90,30" stroke="#2F7D57" strokeWidth="8.5" fill="none" />
      <FlagSheen id="zaSheen" />
    </svg>
  );
}

export function ZimbabweFlag({ className }: { className?: string }) {
  const stripes = ['#2F7D4F', '#D9A83F', '#B03A48', '#232326', '#B03A48', '#D9A83F', '#2F7D4F'];
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Zimbabwe" className={className}>
      {stripes.map((color, i) => (
        <rect key={color + i} x="0" y={(i * 60) / 7} width="90" height={60 / 7 + 0.25} fill={color} />
      ))}
      <polygon
        points="0,0 34,30 0,60"
        fill="#F5F1E6"
        stroke="#232326"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <polygon points={starPoints(13, 30, 9, 3.6)} fill="#B03A48" />
      {/* Zimbabwe bird, simplified to a small gold glyph on the star. */}
      <path d="M9.5,33.8 L13,25.8 L16.5,33.8 L14.7,33.8 L13,30 L11.3,33.8 Z" fill="#D9A83F" />
      <FlagSheen id="zwSheen" />
    </svg>
  );
}

export function AngolaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Angola" className={className}>
      <rect x="0" y="0" width="90" height="30" fill="#B03A48" />
      <rect x="0" y="30" width="90" height="30" fill="#232326" />
      <polygon points={starPoints(45, 15.5, 4.6, 1.9)} fill="#D9A83F" />
      {/* Cog and machete emblem, simplified: a dashed gold cog ring
          crossed by the machete's diagonal stroke. */}
      <circle
        cx="45"
        cy="33"
        r="7.6"
        fill="none"
        stroke="#D9A83F"
        strokeWidth="3"
        strokeDasharray="3.4 2.5"
      />
      <circle cx="45" cy="33" r="7.6" fill="none" stroke="#D9A83F" strokeWidth="1" />
      <line x1="36" y1="42" x2="55" y2="23" stroke="#D9A83F" strokeWidth="2.6" strokeLinecap="round" />
      <FlagSheen id="aoSheen" />
    </svg>
  );
}
