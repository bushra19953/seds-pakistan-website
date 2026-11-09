// Global starfield: the astronomy layer behind every public page.
//
// One seeded star chart for the whole site, so the sky a visitor sees
// on Home is the same sky on Grand Prix and About — a control-room
// chart, sparse and precise, never a snow globe. On the dark theme the
// stars are near-white points on the navy void; on the light theme the
// same field becomes faint navy-ink specks (texture, never dirt) via
// the --star-ink / --star-gain tokens in globals.css.
//
// Perf is by construction:
// - Pure server component, zero hooks, zero client JS of its own.
// - Positions come from a seeded PRNG (mulberry32, same generator the
//   hero's star chart uses) computed once at module load: server and
//   client render byte-identical markup, so there is no hydration
//   mismatch and no random-per-render flicker.
// - The layer is fixed and pointer-events-none; it never participates
//   in layout, and nothing about it is scroll-linked. The base chart
//   rasterises once. The only motion is one opacity tween on the
//   small twinkle layer (composited, and only under
//   prefers-reduced-motion: no-preference — see globals.css).
// - Content that needs an opaque surface keeps it: this layer lives
//   at z-0, behind the shell's z-10 content wrapper, and simply shows
//   through wherever a page leaves the ground transparent.
//
// Mounted by AppClientShell on public pages only; admin and the
// signed-in app shell never receive it.

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

const FIELD_W = 1920;
const FIELD_H = 1080;

type Star = { x: number; y: number; r: number; o: number };

function buildChart() {
  const rnd = mulberry32(20261110);
  const stars: Star[] = Array.from({ length: 118 }, () => {
    const band = rnd();
    return {
      x: Math.round(rnd() * FIELD_W * 10) / 10,
      y: Math.round(rnd() * FIELD_H * 10) / 10,
      // Three restrained magnitude bands: mostly faint chart points,
      // a few mid stars, a rare bright one.
      r: band < 0.7 ? 0.7 + rnd() * 0.4 : band < 0.95 ? 1.1 + rnd() * 0.4 : 1.6 + rnd() * 0.4,
      o: band < 0.7 ? 0.2 + rnd() * 0.2 : band < 0.95 ? 0.35 + rnd() * 0.2 : 0.5 + rnd() * 0.2,
    };
  });

  // The brightest handful carry a short plus tick, the way a printed
  // star chart marks its reference stars.
  const ticked = [...stars]
    .sort((a, b) => b.o - a.o)
    .slice(0, 6)
    .map((s) => `${s.x},${s.y}`);

  // Three short constellation chains: walk from a seed star to the
  // nearest unused star within 340 units, three links per chain (the
  // hero chart's construction, at site scale).
  const used = new Set<number>();
  const chains: string[] = [];
  for (let c = 0; c < 3; c++) {
    let current = Math.floor(rnd() * stars.length);
    const pts: string[] = [];
    for (let link = 0; link < 4; link++) {
      pts.push(`${stars[current].x},${stars[current].y}`);
      used.add(current);
      let best = -1;
      let bestD = 340;
      stars.forEach((s, i) => {
        if (used.has(i)) return;
        const d = Math.hypot(s.x - stars[current].x, s.y - stars[current].y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best === -1) break;
      current = best;
    }
    if (pts.length > 1) chains.push(pts.join(' '));
  }

  // Twinkle layer: its own small set, drawn by the animated wrapper.
  const twinkles: Star[] = Array.from({ length: 9 }, () => ({
    x: Math.round(rnd() * FIELD_W * 10) / 10,
    y: Math.round(rnd() * FIELD_H * 10) / 10,
    r: 1 + rnd() * 0.6,
    o: 0.45 + rnd() * 0.3,
  }));

  return { stars, ticked, chains, twinkles };
}

const CHART = buildChart();
const TICK_LEN = 7;

export default function Starfield() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0" style={{ opacity: 'var(--star-gain)' }}>
        <svg
          className="absolute inset-0 block h-full w-full"
          viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
          preserveAspectRatio="xMidYMid slice"
          focusable="false"
        >
          <g style={{ stroke: 'hsl(var(--star-link))' }} strokeOpacity={0.38} strokeWidth={1} fill="none">
            {CHART.chains.map((pts) => (
              <polyline key={pts} points={pts} />
            ))}
          </g>
          <g style={{ fill: 'hsl(var(--star-ink))' }}>
            {CHART.stars.map((s, i) => (
              <circle key={i} cx={s.x} cy={s.y} r={s.r} opacity={s.o} />
            ))}
          </g>
          <g style={{ stroke: 'hsl(var(--star-link))' }} strokeOpacity={0.55} strokeWidth={1}>
            {CHART.ticked.map((key) => {
              const [x, y] = key.split(',').map(Number);
              return (
                <path
                  key={key}
                  d={`M ${x - TICK_LEN} ${y} H ${x + TICK_LEN} M ${x} ${y - TICK_LEN} V ${y + TICK_LEN}`}
                />
              );
            })}
          </g>
        </svg>
        <div className="starfield-twinkle absolute inset-0">
          <svg
            className="absolute inset-0 block h-full w-full"
            viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
            preserveAspectRatio="xMidYMid slice"
            focusable="false"
          >
            <g style={{ fill: 'hsl(var(--star-ink))' }}>
              {CHART.twinkles.map((s, i) => (
                <circle key={i} cx={s.x} cy={s.y} r={s.r} opacity={s.o} />
              ))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
