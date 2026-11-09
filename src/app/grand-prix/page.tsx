import Image from 'next/image';
import Link from 'next/link';
import StarryBackground from '@/components/starry-background';
import Footer from '@/components/layout/footer';
import { FadeRise, OrbitRings, SpotlightCard } from './motion';
import { MODULES, SERIES_NAME } from '@/lib/grand-prix/registration';
import {
  AngolaFlag,
  ArgentinaFlag,
  BrazilFlag,
  CanadaFlag,
  CostaRicaFlag,
  FinlandFlag,
  FranceFlag,
  GermanyFlag,
  IndiaFlag,
  ItalyFlag,
  KazakhstanFlag,
  MexicoFlag,
  NepalFlag,
  PakistanFlag,
  SingaporeFlag,
  SouthAfricaFlag,
  SriLankaFlag,
  TurkeyFlag,
  UnitedKingdomFlag,
  UnitedStatesFlag,
  ZimbabweFlag,
} from './flags';

// This page speaks the site's own type system (Bebas display, Orbitron
// labels, Courier Prime body, inherited from the root layout) and the
// site's coral signal colour, in both themes. The old page-local Fraunces
// / Manrope / gold sub-brand is gone: one world, every page.
const displayFont = 'font-headline';

const iconProps = {
  width: 30,
  height: 30,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const DISCIPLINES = [
  {
    name: 'Rocketry',
    line: 'Propulsion ballistics and supersonic aerodynamics.',
    icon: (
      <svg {...iconProps}>
        <path d="M12 2.5c2.3 2 3.5 4.9 3.5 8l-3.5 3.5-3.5-3.5c0-3.1 1.2-6 3.5-8Z" />
        <circle cx="12" cy="8.5" r="1.5" />
        <path d="M8.5 11.5 5.8 15l2.9.4M15.5 11.5 18.2 15l-2.9.4" />
        <path d="M10.2 16.8c.5 1.6 1 2.9 1.8 4.2.8-1.3 1.3-2.6 1.8-4.2" />
      </svg>
    ),
  },
  {
    name: 'CubeSat',
    line: 'SmallSat power and comms, flight avionics and telemetry.',
    icon: (
      <svg {...iconProps}>
        <rect x="9" y="9" width="6.5" height="6.5" rx="0.8" />
        <rect x="2" y="10.2" width="5" height="4.1" />
        <path d="M4.5 10.2v4.1M9 12.2H7M17.5 10.2v4.1" />
        <rect x="17.5" y="10.2" width="5" height="4.1" />
        <path d="M20 10.2v4.1M15.5 12.2h2" />
        <path d="M12.2 9V5.8M10.8 5.8h2.9" />
        <path d="M9.8 19.4c1.5.9 3 1.3 4.5 1.3" strokeDasharray="1.8 2.2" />
      </svg>
    ),
  },
  {
    name: 'Rover',
    line: 'Rover kinematics and digital twins.',
    icon: (
      <svg {...iconProps}>
        <rect x="6" y="8.5" width="12.5" height="4.6" rx="1.2" />
        <path d="M15.5 8.5 18.8 4h2.7v3.4" />
        <rect x="20.3" y="3.4" width="2.4" height="2" rx="0.5" />
        <path d="M7.5 13.1 6 17M12.2 13.1v3.9M17 13.1l1.4 3.9" />
        <circle cx="5.6" cy="18.6" r="2" />
        <circle cx="12.2" cy="18.6" r="2" />
        <circle cx="18.8" cy="18.6" r="2" />
      </svg>
    ),
  },
];

const FAMILY = [
  { name: 'India', Flag: IndiaFlag },
  { name: 'Nepal', Flag: NepalFlag },
  { name: 'USA', Flag: UnitedStatesFlag },
  { name: 'Canada', Flag: CanadaFlag },
  { name: 'United Kingdom', Flag: UnitedKingdomFlag },
  { name: 'Italy', Flag: ItalyFlag },
  { name: 'France', Flag: FranceFlag },
  { name: 'Germany', Flag: GermanyFlag },
  { name: 'Finland', Flag: FinlandFlag },
  { name: 'Turkey', Flag: TurkeyFlag },
  { name: 'Singapore', Flag: SingaporeFlag },
  { name: 'Kazakhstan', Flag: KazakhstanFlag },
  { name: 'Mexico', Flag: MexicoFlag },
  { name: 'Costa Rica', Flag: CostaRicaFlag },
  { name: 'Brazil', Flag: BrazilFlag },
  { name: 'Argentina', Flag: ArgentinaFlag },
  { name: 'South Africa', Flag: SouthAfricaFlag },
  { name: 'Zimbabwe', Flag: ZimbabweFlag },
  { name: 'Angola', Flag: AngolaFlag },
];

export default function GrandPrixPage() {
  return (
    <div className="relative flex min-h-screen flex-col text-foreground">
      <StarryBackground />
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 hidden opacity-55 dark:block">
        {/* next/image (priority + responsive variants) instead of a CSS
            background: the raw backdrop is a 403 KB full-size JPG that every
            visitor, phone included, used to download at full resolution. */}
        <Image
          src="/assets/grand-prix-nebula.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-[center_top]"
        />
      </div>
      {/* Dark-only deep-space film over the nebula, kept light enough that
          the star layer reads through the plain ground below the hero.
          Light mode drops the film and the nebula entirely: the page sits
          on the site's light ground with the same type and hairlines. */}
      <div className="pointer-events-none fixed inset-0 hidden bg-[radial-gradient(ellipse_55%_40%_at_50%_-5%,rgba(233,113,76,0.08),transparent),linear-gradient(180deg,rgba(6,9,16,0.22),rgba(6,9,16,0.52))] dark:block" />
      <main className="container relative z-10 mx-auto flex-1 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl">
          <FadeRise>
            <div className="flex items-center justify-center gap-4">
              <span className="h-px w-12 bg-gradient-to-r from-transparent to-primary/70" />
              <p className="text-center font-accent text-[11px] font-semibold uppercase tracking-[0.32em] text-primary-text">
                SEDS Pakistan and SEDS Sri Lanka
              </p>
              <span className="h-px w-12 bg-gradient-to-l from-transparent to-primary/70" />
            </div>
          </FadeRise>
          <FadeRise delay={0.12}>
            <h1
              className={`mt-6 text-center text-5xl leading-[0.98] tracking-[0.02em] sm:text-7xl ${displayFont}`}
            >
              {SERIES_NAME}
            </h1>
          </FadeRise>
          <FadeRise delay={0.24}>
            <p className="mx-auto mt-5 max-w-2xl text-center text-[15px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
              A joint bilateral engineering initiative co-hosted by SEDS Pakistan and SEDS Sri Lanka. Six
              intensive virtual masterclasses connecting collegiate engineers with real-world astronautics,
              propulsion dynamics, and space mission design.
            </p>
          </FadeRise>
          {/* Hero flags sit in identical frames (same width, height and
              styling for both) and each flag fills its frame edge to edge
              (object-cover), so the two flags display at exactly the same
              size. Pakistan crops symmetrically top/bottom around its
              central crescent and star; Sri Lanka's crop is biased to the
              stripes side (object-position 65%) so the lion field and all
              four bo leaves stay fully in frame. */}
          <FadeRise delay={0.36}>
            <div className="mt-10 flex items-start justify-center gap-5 sm:gap-10">
              <figure className="text-center">
                <span className="flex aspect-[7/4] w-36 items-center justify-center overflow-hidden rounded-md shadow-[0_18px_44px_rgba(0,0,0,0.5)] ring-1 ring-[#C9A45C]/45 sm:w-60">
                  <PakistanFlag className="h-full w-full object-cover object-center" />
                </span>
                <figcaption className="mt-3 font-accent text-[11px] font-semibold uppercase tracking-[0.28em] text-[#6B5E3F] dark:text-[#CBBFA5]">
                  Pakistan
                </figcaption>
                <p lang="ur" dir="rtl" className="mt-1.5 text-[13px] leading-relaxed text-[#6B5E3F] dark:text-[#CBBFA5]">
                  خوش آمدید
                </p>
              </figure>
              <span
                aria-hidden="true"
                className={`mt-[19px] flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/50 bg-primary/[0.05] text-xl text-primary-text sm:mt-[46px] dark:bg-white/[0.04] ${displayFont}`}
              >
                &times;
              </span>
              <figure className="text-center">
                <span className="flex aspect-[7/4] w-36 items-center justify-center overflow-hidden rounded-md shadow-[0_18px_44px_rgba(0,0,0,0.5)] ring-1 ring-[#C9A45C]/45 sm:w-60">
                  <SriLankaFlag className="h-full w-full object-cover object-[65%_50%]" />
                </span>
                <figcaption className="mt-3 font-accent text-[11px] font-semibold uppercase tracking-[0.28em] text-[#6B5E3F] dark:text-[#CBBFA5]">
                  Sri Lanka
                </figcaption>
                <p lang="si" className="mt-1.5 text-[13px] leading-relaxed text-[#6B5E3F] dark:text-[#CBBFA5]">
                  ආයුබෝවන්
                </p>
              </figure>
            </div>
          </FadeRise>
          <OrbitRings />
          <div className="mt-8 flex items-center justify-center gap-3" aria-hidden="true">
            <span className="h-px w-24 bg-[#1A1610]/15 dark:bg-white/15" />
            <span className="block h-1.5 w-1.5 rotate-45 bg-primary" />
            <span className="h-px w-24 bg-[#1A1610]/15 dark:bg-white/15" />
          </div>

          <section aria-labelledby="disciplines-heading" className="mt-16">
            <h2 id="disciplines-heading" className={`text-center text-4xl ${displayFont}`}>
              Three Engineering Disciplines
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
              {DISCIPLINES.map((discipline) => (
                <SpotlightCard
                  key={discipline.name}
                  className="rounded-lg border border-[#1A1610]/10 bg-white px-5 py-6 text-center dark:border-white/10 dark:bg-white/[0.04] dark:backdrop-blur-md"
                >
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-primary/[0.05] text-primary">
                    {discipline.icon}
                  </span>
                  <p className={`mt-4 text-2xl leading-snug ${displayFont}`}>{discipline.name}</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
                    {discipline.line}
                  </p>
                </SpotlightCard>
              ))}
            </div>
          </section>

          <section aria-labelledby="curriculum-heading" className="mt-16">
            <h2 id="curriculum-heading" className={`text-center text-4xl ${displayFont}`}>
              Curriculum
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {MODULES.map((module, i) => (
                <SpotlightCard
                  key={module.id}
                  className="rounded-lg border border-[#1A1610]/10 bg-white px-5 py-5 dark:border-white/10 dark:bg-white/[0.04] dark:backdrop-blur-md"
                >
                  <p className="font-accent text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-text">
                    Module {String(i + 1).padStart(2, '0')}
                  </p>
                  <p className={`mt-2 text-2xl leading-snug ${displayFont}`}>{module.title}</p>
                </SpotlightCard>
              ))}
            </div>
            <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
              This series represents Phase 1 of our bilateral roadmap. Subsequent phases, fabrication, or
              flight campaigns are evaluated post-Phase 1.
            </p>
          </section>

          <section aria-labelledby="patrons-heading" className="mt-16">
            <h2 id="patrons-heading" className={`text-center text-4xl ${displayFont}`}>
              Patrons
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SpotlightCard className="rounded-lg border border-[#1A1610]/10 bg-white px-5 py-6 text-center dark:border-white/10 dark:bg-white/[0.04] dark:backdrop-blur-md">
                <p className="font-accent text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-text">
                  Patron
                </p>
                <p className={`mt-2 text-2xl leading-snug ${displayFont}`}>Dr. Najam Abbas Naqvi</p>
                <p className="mt-2 text-[13px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
                  Patron, SEDS Pakistan
                </p>
              </SpotlightCard>
              <SpotlightCard className="rounded-lg border border-[#1A1610]/10 bg-white px-5 py-6 text-center dark:border-white/10 dark:bg-white/[0.04] dark:backdrop-blur-md">
                <p className="font-accent text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-text">
                  International Patron
                </p>
                <p className={`mt-2 text-2xl leading-snug ${displayFont}`}>Professor Shufan Wu</p>
                <p className="mt-2 text-[13px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
                  Chair Professor, Shanghai Jiao Tong University
                </p>
              </SpotlightCard>
            </div>
          </section>

          <section aria-labelledby="family-heading" className="mt-16">
            <div className="flex items-center justify-center gap-4">
              <span className="h-px w-10 bg-gradient-to-r from-transparent to-primary/60" />
              <h2
                id="family-heading"
                className="text-center font-accent text-[11px] font-semibold uppercase tracking-[0.28em] text-[#6B5E3F] dark:text-[#CBBFA5]"
              >
                Part of the Global SEDS Family
              </h2>
              <span className="h-px w-10 bg-gradient-to-l from-transparent to-primary/60" />
            </div>
            <p className="mx-auto mt-4 max-w-xl text-center text-[13px] leading-relaxed text-[#57503E] dark:text-[#CFC8B8]">
              SEDS Pakistan and SEDS Sri Lanka belong to a worldwide family of SEDS chapters spanning
              22 nations, connecting space-minded students across borders.
            </p>
            <div className="mt-7 flex flex-wrap items-start justify-center gap-x-4 gap-y-4 sm:gap-x-5">
              {FAMILY.map(({ name, Flag }) => (
                <figure key={name} className="text-center">
                  <span className="flex h-9 items-center justify-center sm:h-10">
                    <Flag className="block h-full w-auto rounded-[3px] shadow-[0_8px_20px_rgba(0,0,0,0.4)] ring-1 ring-white/15" />
                  </span>
                  <figcaption className="mt-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[#7A7260] dark:text-[#A79E8B]">
                    {name}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          <div className="mt-12 text-center">
            <Link
              href="/grand-prix/register"
              className="inline-flex h-[52px] items-center rounded-full bg-primary px-10 font-accent text-sm font-semibold uppercase tracking-[0.14em] text-primary-foreground transition hover:bg-primary/90"
            >
              Enrol now
            </Link>
            <p className="mt-4 text-xs text-[#7A7260] dark:text-[#8E887A]">
              Registration open until Nov 15, 2026, 23:59 PKT. Late admission Nov 21-28, 2026.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
