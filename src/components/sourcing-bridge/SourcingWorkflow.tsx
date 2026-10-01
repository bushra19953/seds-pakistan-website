import React from 'react';
import { UploadCloud, FileSearch, Cog, PlaneTakeoff, ArrowRight } from 'lucide-react';

export default function SourcingWorkflow() {
  const steps = [
    {
      step: '01',
      title: 'Submit CAD & Specs',
      description: 'Upload your 3D models (.STEP, .IGES), 2D GD&T drawings (.PDF), or electronics BOMs (.XLSX) through our secure intake portal.',
      icon: UploadCloud,
      badge: 'Step 1',
      badgeColor: 'text-primary bg-primary/10 border-primary/30',
    },
    {
      step: '02',
      title: '48-Hour DFM & Quote',
      description: 'SJTU engineering fellows review toolpaths, critical wall thicknesses, and negotiate factory-direct benchmark quotes across our verified network.',
      icon: FileSearch,
      badge: 'Step 2',
      badgeColor: 'text-accent bg-accent/10 border-accent/30',
    },
    {
      step: '03',
      title: 'Precision Machining',
      description: 'Immediate spindle time on verified DMG MORI/Haas 5-axis machining centers or high-precision IATF 16949 automated SMT lines.',
      icon: Cog,
      badge: 'Step 3',
      badgeColor: 'text-primary bg-primary/10 border-primary/30',
    },
    {
      step: '04',
      title: 'CMM Inspection & Express Air',
      description: 'Physical First-Article Inspection (FAI) on Zeiss Coordinate Measuring Machines in Shanghai, full QC reports, and DHL/FedEx air dispatch.',
      icon: PlaneTakeoff,
      badge: 'Step 4',
      badgeColor: 'text-accent bg-accent/10 border-accent/30',
    },
  ];

  return (
    <section id="how-it-works" className="py-16 md:py-24 bg-background border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            Seamless Execution Pipeline
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            The 4-Step Sourcing Workflow
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg text-justify max-w-2xl mx-auto">
            From university CAD workstation to flight-ready flight hardware in 10 to 14 days.
          </p>
        </div>

        {/* Steps Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 relative">
          {steps.map((step, idx) => (
            <div
              key={idx}
              className="rounded-2xl border border-accent/20 bg-card/80 backdrop-blur-md p-6 flex flex-col justify-between hover:border-primary/50 transition-all shadow-xl shadow-accent/5 relative group"
            >
              {/* Step number watermark */}
              <div className="absolute top-4 right-4 text-5xl font-headline text-foreground/10 group-hover:text-primary/30 transition-colors select-none">
                {step.step}
              </div>

              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="p-3 rounded-xl bg-primary/10 border border-primary/20 text-primary group-hover:scale-110 transition-transform">
                    <step.icon className="w-5 h-5 sm:w-6 sm:h-6" />
                  </div>
                  <span className={`px-2.5 py-0.5 rounded text-xs font-accent uppercase tracking-wider border font-semibold ${step.badgeColor}`}>
                    {step.badge}
                  </span>
                </div>

                <h3 className="text-2xl font-headline tracking-wide text-foreground uppercase mb-2 group-hover:text-primary transition-colors">
                  {step.title}
                </h3>
                <p className="text-xs sm:text-sm text-muted-foreground font-body leading-relaxed text-justify">
                  {step.description}
                </p>
              </div>

              {idx < steps.length - 1 && (
                <div className="hidden lg:block absolute -right-3.5 top-1/2 -translate-y-1/2 z-20 text-muted-foreground/60 pointer-events-none">
                  <ArrowRight className="w-5 h-5" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
