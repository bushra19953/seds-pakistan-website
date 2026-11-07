/**
 * Inline SVG national flags for the bilateral hero.
 * Drawn by hand so the page carries no external flag image assets.
 * Pakistan: white stripe, green field, crescent and star (accurate layout).
 * Sri Lanka: gold border, green and saffron stripes, maroon field with bo
 * leaves; the lion is simplified, per the design brief, to a dignified gold
 * medallion carrying a bo leaf.
 */

export function PakistanFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 90 60" role="img" aria-label="Flag of Pakistan" className={className}>
      <rect x="0" y="0" width="90" height="60" fill="#FFFFFF" />
      <rect x="22.5" y="0" width="67.5" height="60" fill="#01411C" />
      <circle cx="56.25" cy="30" r="13" fill="#FFFFFF" />
      <circle cx="60.45" cy="30" r="10.6" fill="#01411C" />
      <polygon
        fill="#FFFFFF"
        points="65.5,18.9 66.59,22 69.87,22.08 67.26,24.07 68.2,27.22 65.5,25.35 62.8,27.22 63.74,24.07 61.13,22.08 64.41,22"
      />
      <rect x="0" y="0" width="90" height="60" fill="url(#pkSheen)" pointerEvents="none" />
      <defs>
        <linearGradient id="pkSheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.10" />
          <stop offset="45%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function BoLeaf({
  x,
  y,
  rotate,
  scale = 1,
}: {
  x: number;
  y: number;
  rotate: number;
  scale?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <path
        d="M0,-4.2 C2.6,-1.6 2.6,1.6 0,4.2 C-2.6,1.6 -2.6,-1.6 0,-4.2 Z"
        fill="#FFBE29"
      />
      <path d="M0,4.2 L0,6" stroke="#FFBE29" strokeWidth="0.9" strokeLinecap="round" />
    </g>
  );
}

export function SriLankaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 60" role="img" aria-label="Flag of Sri Lanka" className={className}>
      <rect x="0" y="0" width="120" height="60" fill="#FFBE29" />
      <rect x="4" y="4" width="26" height="52" fill="#00534E" />
      <rect x="30" y="4" width="13" height="52" fill="#EB7400" />
      <rect x="43" y="4" width="2" height="52" fill="#FFBE29" />
      <rect x="45" y="4" width="71" height="52" fill="#8D153A" />
      <BoLeaf x={52} y={11} rotate={-32} />
      <BoLeaf x={109} y={11} rotate={32} />
      <BoLeaf x={52} y={49} rotate={-148} />
      <BoLeaf x={109} y={49} rotate={148} />
      {/* Gold medallion in place of the lion: a dignified simplified emblem. */}
      <circle cx="80.5" cy="30" r="14" fill="none" stroke="#FFBE29" strokeWidth="2.4" />
      <circle cx="80.5" cy="30" r="11.4" fill="#8D153A" stroke="#FFBE29" strokeWidth="0.8" />
      <BoLeaf x={80.5} y={29} rotate={0} scale={1.55} />
      <rect x="0" y="0" width="120" height="60" fill="url(#lkSheen)" pointerEvents="none" />
      <defs>
        <linearGradient id="lkSheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.10" />
          <stop offset="45%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </linearGradient>
      </defs>
    </svg>
  );
}
