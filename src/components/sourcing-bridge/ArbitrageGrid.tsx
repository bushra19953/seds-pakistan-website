import React from 'react';
import { AlertCircle, CheckCircle2, DollarSign, Clock, ShieldCheck, Cpu } from 'lucide-react';

export default function ArbitrageGrid() {
  const comparisonItems = [
    {
      dimension: 'Prototyping Cost',
      icon: DollarSign,
      bottleneck: '$3,000 to $5,000 for a simple bracket when ordering low volumes from Western machine shops.',
      resolution: 'Factory-direct pricing, typically 50% to 70% less than Western low-volume quotes.',
      metric: '50%-70% Savings',
      metricColor: 'text-primary border-primary/30 bg-primary/10',
    },
    {
      dimension: 'Turnaround Time',
      icon: Clock,
      bottleneck: '10 to 14 weeks of queue time at university and local job shops, often missing launch deadlines.',
      resolution: 'Parts machined in 10 to 14 days, then shipped express to your lab.',
      metric: '10-14 Day Turnaround',
      metricColor: 'text-accent border-accent/30 bg-accent/10',
    },
    {
      dimension: 'Trust & Oversight',
      icon: ShieldCheck,
      bottleneck: 'Ordering from unknown overseas suppliers means no way to verify quality, materials, or hold anyone accountable.',
      resolution: 'Our engineers in Shanghai oversee production and verify every part with inspection reports.',
      metric: 'On-Ground Oversight',
      metricColor: 'text-primary border-primary/30 bg-primary/10',
    },
    {
      dimension: 'Aerospace Electronics QC',
      icon: Cpu,
      bottleneck: 'Risky components, hand-soldered joints, and uninspected BGA soldering on student-built boards.',
      resolution: 'Automated assembly lines with genuine components and X-ray inspection on every board.',
      metric: 'X-Ray Inspected',
      metricColor: 'text-accent border-accent/30 bg-accent/10',
    },
  ];

  return (
    <section id="capabilities" className="py-16 md:py-24 bg-background border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            Why Teams Use the Sourcing Bridge
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            Direct Factory Pricing, With Engineering Oversight
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg text-justify max-w-2xl mx-auto">
            Our team in Shanghai coordinates manufacturing for collegiate rocketry and CubeSat teams, so you get factory pricing without navigating the supply chain yourself.
          </p>
        </div>

        {/* Comparison Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {comparisonItems.map((item, idx) => (
            <div
              key={idx}
              className="rounded-2xl border border-accent/20 bg-card/80 backdrop-blur-md overflow-hidden flex flex-col justify-between hover:border-primary/50 transition-all shadow-xl shadow-accent/5"
            >
              {/* Card Header */}
              <div className="p-5 sm:p-6 border-b border-border/50 bg-accent/5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-lg bg-primary/10 text-primary border border-primary/20">
                    <item.icon className="w-5 h-5" />
                  </div>
                  <h3 className="text-2xl font-headline tracking-wide text-foreground uppercase">
                    {item.dimension}
                  </h3>
                </div>
                <span className={`px-3 py-1 rounded-md text-xs font-accent uppercase tracking-wider border font-semibold ${item.metricColor}`}>
                  {item.metric}
                </span>
              </div>

              {/* Card Content Comparison */}
              <div className="p-5 sm:p-6 space-y-4 flex-1 flex flex-col justify-between">
                {/* Traditional Bottleneck */}
                <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/25">
                  <div className="flex items-center gap-2 text-xs font-accent text-destructive uppercase tracking-wider mb-1.5 font-bold">
                    <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                    <span>The Usual Problem</span>
                  </div>
                  <p className="text-xs sm:text-sm text-muted-foreground font-body leading-relaxed text-justify">
                    {item.bottleneck}
                  </p>
                </div>

                {/* SEDS Resolution */}
                <div className="p-4 rounded-xl bg-primary/10 border border-primary/25">
                  <div className="flex items-center gap-2 text-xs font-accent text-primary uppercase tracking-wider mb-1.5 font-bold">
                    <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                    <span>What We Do Instead</span>
                  </div>
                  <p className="text-xs sm:text-sm text-foreground font-body leading-relaxed text-justify">
                    {item.resolution}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
