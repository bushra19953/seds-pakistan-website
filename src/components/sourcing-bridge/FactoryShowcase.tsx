'use client';

import React, { useState } from 'react';
import { Cog, Flame, Zap, MapPin, Gauge, Layers, Box, CheckCircle } from 'lucide-react';

type CategoryTab = 'all' | 'cnc' | 'casting' | 'sma';

export default function FactoryShowcase() {
  const [activeTab, setActiveTab] = useState<CategoryTab>('all');

  const facilities = [
    {
      id: 'chijiang',
      category: 'cnc',
      categoryLabel: '5-Axis CNC Precision Machining',
      location: 'Shanghai, China',
      title: 'Shanghai Chijiang Precision Machinery Co., Ltd.',
      machinerySummary: 'Doosan 5-axis CNC machining centers, inspected on site during the SEDS factory audit.',
      machinery: [
        'Doosan 5-Axis CNC Machining Centers',
      ],
      tolerances: 'Tolerances down to ±0.005 mm on 5-axis geometries | 10-day delivery windows',
      materials: [
        'Aviation-grade 7075-T6 aluminum',
        'Titanium',
      ],
      components: [
        'Aerospace impellers',
        'Lightweight aluminum structural bulkheads',
        'Titanium components',
      ],
      badge: 'Verified · Sep 2026',
      badgeColor: 'text-primary border-primary/30 bg-primary/10',
      icon: Cog,
    },
    {
      id: 'guanghu',
      category: 'casting',
      categoryLabel: 'Precision Investment Casting',
      location: 'Shanghai, China',
      title: 'Guanghu Investment Casting & CNC',
      machinerySummary: 'Investment casting foundry with continuous furnace lines and CMM quality control benches, inspected on site.',
      machinery: [
        'Continuous Furnace Lines',
        'Coordinate Measuring Machine (CMM) Quality Control Benches',
      ],
      tolerances: 'Audited export quality systems: IATF 16949 | ISO 14001 | ISO 45001',
      materials: [
        'Aerospace-grade investment casting',
        'Automotive-grade investment casting',
      ],
      components: [
        'Complex thin-walled airframe structures',
      ],
      badge: 'Verified · Sep 2026',
      badgeColor: 'text-accent border-accent/30 bg-accent/10',
      icon: Flame,
    },
    {
      id: 'tiyitech',
      category: 'sma',
      categoryLabel: 'Shape Memory Alloy Actuators & Micro-Valves',
      location: 'Minhang / Zhangjiagang, Jiangsu, China',
      title: 'Shanghai Titanium Memory Tech (TiyiTech)',
      machinerySummary: 'Shape memory alloy actuator and micro-valve production, cleanroom tested. Verification still in progress (4 of 6 checks complete).',
      machinery: [
        'SMA Cleanroom Furnaces',
        'Cleanroom Testing Facilities',
      ],
      tolerances: 'Nitinol wire from 0.03 mm to 3.00 mm diameter',
      materials: [
        'Nitinol shape memory alloy wire',
      ],
      components: [
        'Pin pullers (non-explosive actuators)',
        'Split-spool release nuts',
        'Sub-gram SMA micro-valves for satellite cold-gas thrusters',
      ],
      badge: 'In Verification',
      badgeColor: 'text-amber-300 border-amber-400/40 bg-amber-500/15',
      icon: Zap,
    },
  ];

  const filteredFacilities = activeTab === 'all' 
    ? facilities 
    : facilities.filter(f => f.category === activeTab);

  return (
    <section id="factory-showcase" className="py-16 md:py-24 bg-background border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            Manufacturing Bases
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            Factory Floor &amp; Machine Showcase
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg text-justify max-w-2xl mx-auto">
            The bases in this showcase are the same facilities named in the Verified Facilities register below. Each one was walked and audited by the SEDS network; a base still completing verification is marked In Verification, not Verified.
          </p>
        </div>

        {/* Tab Filters */}
        <div className="flex flex-wrap items-center justify-center gap-2.5 mb-14">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-accent uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'all'
                ? 'bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20 border border-primary/40 pulse-glow'
                : 'bg-card/70 text-muted-foreground hover:text-foreground border border-accent/20'
            }`}
          >
            All Capabilities
          </button>
          <button
            onClick={() => setActiveTab('cnc')}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-accent uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'cnc'
                ? 'bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20 border border-primary/40 pulse-glow'
                : 'bg-card/70 text-muted-foreground hover:text-foreground border border-accent/20'
            }`}
          >
            5-Axis CNC
          </button>
          <button
            onClick={() => setActiveTab('casting')}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-accent uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'casting'
                ? 'bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20 border border-primary/40 pulse-glow'
                : 'bg-card/70 text-muted-foreground hover:text-foreground border border-accent/20'
            }`}
          >
            Investment Casting
          </button>
          <button
            onClick={() => setActiveTab('sma')}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-accent uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'sma'
                ? 'bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20 border border-primary/40 pulse-glow'
                : 'bg-card/70 text-muted-foreground hover:text-foreground border border-accent/20'
            }`}
          >
            SMA Actuators
          </button>
        </div>

        {/* Facilities Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {filteredFacilities.map((facility) => (
            <div
              key={facility.id}
              className="rounded-2xl border border-accent/20 bg-card/80 backdrop-blur-md overflow-hidden flex flex-col justify-between hover:border-primary/50 transition-all shadow-xl shadow-accent/5 group"
            >
              {/* Card Top */}
              <div>
                <div className="p-6 border-b border-border/50 bg-accent/5">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="p-2.5 rounded-lg bg-primary/10 text-primary border border-primary/20">
                      <facility.icon className="w-5 h-5" />
                    </div>
                    <span className={`px-2.5 py-1 rounded text-xs font-accent uppercase tracking-wider border font-semibold ${facility.badgeColor}`}>
                      {facility.badge}
                    </span>
                  </div>

                  <h3 className="text-2xl font-headline tracking-wide text-foreground uppercase group-hover:text-primary transition-colors mb-1.5">
                    {facility.title}
                  </h3>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-body">
                    <MapPin className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                    <span>{facility.location}</span>
                  </div>
                </div>

                {/* Card Body Details */}
                <div className="p-6 space-y-5 text-sm">
                  {/* Machinery */}
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-accent text-primary uppercase tracking-wider mb-2 font-semibold">
                      <Cog className="w-3.5 h-3.5 text-primary" />
                      <span>Equipment</span>
                    </div>
                    <p className="text-muted-foreground text-xs font-body mb-2">
                      {facility.machinerySummary}
                    </p>
                    <details className="text-xs font-body">
                      <summary className="cursor-pointer text-primary hover:text-primary/80 font-accent uppercase tracking-wider text-xs">
                        Technical details
                      </summary>
                      <ul className="space-y-1.5 text-muted-foreground mt-2">
                        {facility.machinery.map((m, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-primary">•</span>
                            <span>{m}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>

                  {/* Tolerances */}
                  <div className="p-3.5 rounded-xl bg-accent/10 border border-accent/25">
                    <div className="flex items-center gap-1.5 text-xs font-accent text-accent uppercase tracking-wider mb-1 font-bold">
                      <Gauge className="w-3.5 h-3.5" />
                      <span>Tolerances &amp; Standards</span>
                    </div>
                    <p className="text-xs text-foreground font-body leading-relaxed">
                      {facility.tolerances}
                    </p>
                  </div>

                  {/* Materials */}
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-accent text-primary uppercase tracking-wider mb-2 font-semibold">
                      <Layers className="w-3.5 h-3.5 text-primary" />
                      <span>Materials</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {facility.materials.map((mat, i) => (
                        <span
                          key={i}
                          className="px-2.5 py-1 rounded-md bg-card border border-border text-foreground text-xs font-body"
                        >
                          {mat}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Components */}
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-accent text-primary uppercase tracking-wider mb-2 font-semibold">
                      <Box className="w-3.5 h-3.5 text-primary" />
                      <span>Typical Target Components</span>
                    </div>
                    <ul className="space-y-1 text-xs text-muted-foreground font-body">
                      {facility.components.map((comp, i) => (
                        <li key={i} className="flex items-center gap-1.5">
                          <CheckCircle className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                          <span>{comp}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Capabilities that have not completed SEDS verification are not
            presented as verified bases; they run through the wider network. */}
        <p className="text-center text-xs text-muted-foreground font-body mt-10 max-w-2xl mx-auto">
          Need turnkey PCBA, composites, or large-format tooling? Those jobs run through partner facilities in the wider sourcing network that have not completed SEDS verification, so they are not shown as verified bases here. Put the job in your RFQ and we will name the facility before you commit.
        </p>
      </div>
    </section>
  );
}
