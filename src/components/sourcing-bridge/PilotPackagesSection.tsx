import React from 'react';
import { Rocket, Cpu, Wrench, ArrowRight, BadgeCheck, Timer, PackageCheck } from 'lucide-react';

// Prominent conversion section placed immediately after the workflow.
// Lets skeptical teams start with a small prototype before committing
// to a full production run.
export default function PilotPackagesSection() {
  const packages = [
    {
      icon: Rocket,
      name: '5-Axis CNC Motor Mounts & Brackets',
      description: 'Al 7075-T651 billet machining, lightweight pocketing, hard anodized Type III finish.',
      meta: ['48h DFM', '7-Day Express Ship'],
      accent: 'emerald',
    },
    {
      icon: Cpu,
      name: 'Avionics Flight Computer Prototypes',
      description: 'Turnkey 4-to-8 layer SMT PCBA with full BGA X-Ray inspection and functional test.',
      meta: ['Turnkey PCBA', '100% X-Ray Verified'],
      accent: 'cyan',
    },
    {
      icon: Wrench,
      name: 'Static Test Stand Plates & Foam',
      description: 'Static test stand thrust plates and custom CNC-cut protective case foam.',
      meta: ['Heavy GSE', 'Field Transport Ready'],
      accent: 'purple',
    },
  ];

  const accentStyles: Record<string, { border: string; hover: string; text: string; iconBg: string }> = {
    emerald: {
      border: 'border-emerald-500/30',
      hover: 'hover:border-emerald-400/70 hover:shadow-emerald-500/10',
      text: 'text-emerald-400',
      iconBg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    },
    cyan: {
      border: 'border-cyan-500/30',
      hover: 'hover:border-cyan-400/70 hover:shadow-cyan-500/10',
      text: 'text-cyan-400',
      iconBg: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400',
    },
    purple: {
      border: 'border-purple-500/30',
      hover: 'hover:border-purple-400/70 hover:shadow-purple-500/10',
      text: 'text-purple-400',
      iconBg: 'bg-purple-500/10 border-purple-500/30 text-purple-400',
    },
  };

  return (
    <section id="pilot-packages" className="py-16 md:py-24 bg-background border-b border-border/30 relative overflow-hidden">
      {/* Distinct glow backdrop so this reads as a conversion moment, not another info block */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(16,185,129,0.10),transparent)]" />

      <div className="container mx-auto px-4 md:px-6 max-w-6xl relative">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Start Small, Benchmark Us
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            Not ready for a full production run?
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg max-w-2xl mx-auto">
            Start with a <span className="text-emerald-400 font-semibold">$200-$500 pilot package</span> and
            benchmark our quality before authorizing larger runs.
          </p>
        </div>

        {/* Package cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          {packages.map((pkg) => {
            const style = accentStyles[pkg.accent];
            return (
              <div
                key={pkg.name}
                className={`rounded-2xl border ${style.border} ${style.hover} bg-card/80 backdrop-blur-md p-6 flex flex-col justify-between transition-all shadow-xl hover:shadow-2xl group`}
              >
                <div>
                  <div className={`inline-flex p-3 rounded-xl border ${style.iconBg} mb-4 group-hover:scale-110 transition-transform`}>
                    <pkg.icon className="w-6 h-6" />
                  </div>
                  <h3 className="text-xl font-headline tracking-wide text-foreground uppercase mb-2">
                    {pkg.name}
                  </h3>
                  <p className="text-sm text-muted-foreground font-body leading-relaxed">
                    {pkg.description}
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between">
                  {pkg.meta.map((m) => (
                    <span key={m} className={`text-[11px] font-mono font-semibold ${style.text} flex items-center gap-1`}>
                      <BadgeCheck className="w-3.5 h-3.5" />
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Trust strip + CTA */}
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-emerald-500/25 bg-emerald-950/20 px-6 py-8 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-mono text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Timer className="w-4 h-4 text-emerald-400" /> Zero minimum commitment
            </span>
            <span className="flex items-center gap-1.5">
              <PackageCheck className="w-4 h-4 text-emerald-400" /> 48-hour DFM review included
            </span>
            <span className="flex items-center gap-1.5">
              <BadgeCheck className="w-4 h-4 text-emerald-400" /> No manufacturing without your approval
            </span>
          </div>
          <a
            href="#intake-form"
            className="inline-flex items-center gap-2 px-8 py-3.5 rounded-xl bg-emerald-500 text-emerald-950 font-accent font-bold uppercase tracking-widest text-sm hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/25"
          >
            Start a Pilot
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
