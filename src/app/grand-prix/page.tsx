import { Fraunces, Manrope } from 'next/font/google';
import Link from 'next/link';
import StarryBackground from '@/components/starry-background';
import Footer from '@/components/layout/footer';
import { MODULES, SERIES_NAME } from '@/lib/grand-prix/registration';

const display = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--gp-display',
});

const body = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--gp-body',
});

const IVORY = '#F5F0E4';
const GOLD = '#C9A45C';
const GOLD_LIGHT = '#E8CF8F';
const displayFont = '[font-family:var(--gp-display)]';

export default function GrandPrixPage() {
  return (
    <div
      className={`relative flex min-h-screen flex-col ${display.variable} ${body.variable} [font-family:var(--gp-body)]`}
      style={{ color: IVORY }}
    >
      <StarryBackground />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-55"
        style={{
          backgroundImage: 'url(/assets/grand-prix-nebula.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
        }}
      />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_55%_40%_at_50%_-5%,rgba(201,164,92,0.14),transparent),linear-gradient(180deg,rgba(6,9,16,0.35),rgba(6,9,16,0.78))]" />
      <main className="container relative z-10 mx-auto flex-1 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-center gap-4">
            <span className="h-px w-12 bg-gradient-to-r from-transparent to-[#C9A45C]/80" />
            <p
              className="text-center text-[11px] font-extrabold uppercase tracking-[0.42em]"
              style={{ color: GOLD_LIGHT }}
            >
              SEDS Pakistan and SEDS Sri Lanka
            </p>
            <span className="h-px w-12 bg-gradient-to-l from-transparent to-[#C9A45C]/80" />
          </div>
          <h1
            className={`mt-6 bg-gradient-to-r from-[#E8CF8F] via-[#C9A45C] to-[#E8CF8F] bg-clip-text text-center text-4xl font-semibold leading-[1.08] text-transparent sm:text-[3.4rem] ${displayFont}`}
          >
            {SERIES_NAME}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-center text-[15px] leading-relaxed text-[#CFC8B8]">
            A joint bilateral engineering initiative co-hosted by SEDS Pakistan and SEDS Sri Lanka. Six
            intensive virtual masterclasses connecting collegiate engineers with real-world astronautics,
            propulsion dynamics, and space mission design.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3" aria-hidden="true">
            <span className="h-px w-24 bg-white/15" />
            <span className="block h-1.5 w-1.5 rotate-45" style={{ backgroundColor: GOLD }} />
            <span className="h-px w-24 bg-white/15" />
          </div>

          <section aria-labelledby="curriculum-heading" className="mt-14">
            <h2
              id="curriculum-heading"
              className={`text-center text-3xl font-semibold ${displayFont}`}
              style={{ color: GOLD_LIGHT }}
            >
              Curriculum
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {MODULES.map((module, i) => (
                <div
                  key={module.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-5 shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-md"
                >
                  <p className="text-[11px] font-extrabold uppercase tracking-[0.24em] text-[#CBBFA5]">
                    Module {String(i + 1).padStart(2, '0')}
                  </p>
                  <p className={`mt-2 text-xl font-semibold leading-snug ${displayFont}`} style={{ color: IVORY }}>
                    {module.title}
                  </p>
                </div>
              ))}
            </div>
            <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-[#CFC8B8]">
              This series represents Phase 1 of our bilateral roadmap. Subsequent phases, fabrication, or
              flight campaigns are evaluated post-Phase 1.
            </p>
          </section>

          <div className="mt-12 text-center">
            <Link
              href="/grand-prix/register"
              className="inline-flex h-[52px] items-center rounded-full bg-[linear-gradient(120deg,#E8CF8F,#C9A45C_45%,#A87F35)] px-10 text-sm font-extrabold uppercase tracking-[0.14em] text-[#171106] shadow-[0_16px_40px_rgba(201,164,92,0.35)] transition hover:brightness-110"
            >
              Enrol now
            </Link>
            <p className="mt-4 text-xs text-[#8E887A]">
              Registration open until Nov 15, 2026, 23:59 PKT. Late admission Nov 21-28, 2026.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
