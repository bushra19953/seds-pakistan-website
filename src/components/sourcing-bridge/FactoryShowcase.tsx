'use client';

import React, { useState } from 'react';
import { Cog, Cpu, Wrench, MapPin, Gauge, Layers, Box, CheckCircle } from 'lucide-react';

type CategoryTab = 'all' | 'cnc' | 'pcba' | 'tooling';

export default function FactoryShowcase() {
  const [activeTab, setActiveTab] = useState<CategoryTab>('all');

  const facilities = [
    {
      id: 'cnc-base',
      category: 'cnc',
      categoryLabel: '5-Axis Precision Machining',
      location: 'Kunshan / Suzhou / Shanghai Precision Corridor',
      title: '5-Axis Aerospace Machining Base',
      machinerySummary: '5-axis simultaneous machining centers, high-speed precision centers, and Swiss-type lathes.',
      machinery: [
        'DMG MORI 5-Axis Simultaneous Machining Centers',
        'Haas UMC-750 5-Axis Universal Machining Centers',
        'Beijing Jingdiao High-Speed Precision Centers',
        'Citizen Swiss-Type Precision Lathes',
      ],
      tolerances: 'Linear accuracy ±0.005 mm | Hole fits H7/g6 | Surface finish Ra 0.8 µm',
      materials: [
        'Aluminum 7075-T651 & 6061-T6',
        'Titanium Ti-6Al-4V (Grade 5)',
        '316L Stainless Steel',
        'Aerospace Grade PEEK',
        'Inconel 718 (on request)',
      ],
      components: [
        'Rocket motor gimbal mounts & injector domes',
        'CubeSat 1U–12U structural bulkheads',
        'High-pressure propellant valve bodies',
        'Optical payload & sensor housings',
      ],
      badge: 'CMM Inspected',
      badgeColor: 'text-primary border-primary/30 bg-primary/10',
      icon: Cog,
    },
    {
      id: 'pcba-base',
      category: 'pcba',
      categoryLabel: 'Turnkey Aerospace Electronics',
      location: 'Shenzhen & Zhuhai Aerospace Electronics Hubs',
      title: 'Turnkey IATF 16949 Electronics Facility',
      machinerySummary: 'Automated SMT lines, nitrogen reflow ovens, and selective soldering stations.',
      machinery: [
        'Europlacer Prototyping Line (±0.02 mm placement, 01005 passives, 0.2mm BGA)',
        'JUKI High-Speed Multi-Feeder Production Lines',
        'Heller 10-Zone Nitrogen Forced Convection Reflow',
        'Pillarhouse Selective Soldering Stations',
      ],
      tolerances: '01005 passives | 0.2mm ultra-fine pitch BGA | 100% IPC-A-610 Class 3 standard',
      materials: [
        'High-Tg Rogers / Isola RF Substrates',
        'FR-4 High-Frequency Multi-Layer (up to 32 layers)',
        'Rigid-Flex PCB with Polyimide Core',
        'Aerospace Grade Conformal Coatings (Parylene / Silicone)',
      ],
      components: [
        'CubeSat Flight On-Board Computers (OBCs)',
        '915MHz / 2.4GHz High-Power Telemetry Transceivers',
        'Solar MPPT Electronic Power Systems (EPS)',
        'Pyro & Ejection Deployment Controllers',
      ],
      badge: 'X-Ray Inspected',
      badgeColor: 'text-accent border-accent/30 bg-accent/10',
      icon: Cpu,
    },
    {
      id: 'tooling-base',
      category: 'tooling',
      categoryLabel: 'Rapid Tooling & Ground Support',
      location: 'Yangtze River Delta Industrial Tooling Corridor',
      title: 'Aerospace Tooling & GSE Fabrication',
      machinerySummary: 'Wire EDM systems, large gantry mills, and precision cutting arrays.',
      machinery: [
        'Sodick & Mitsubishi High-Speed Wire EDM Systems',
        'Large-Envelope CNC Gantry Milling Centers (3000mm x 1500mm)',
        'Heated Vacuum Composite Autoclave Tooling Fixtures',
        'Waterjet & Laser Precision Cutting Arrays',
      ],
      tolerances: 'EDM Corner radius R0.05 mm | Flatness 0.02 mm over 1000 mm span',
      materials: [
        'Tool Steel (P20, 718H, SKD61)',
        'High-Density Polyurethane Tooling Board',
        'Carbon Fiber Composite Layup Mandrels',
        'Custom High-Density CNC Foam',
      ],
      components: [
        'Rocket Carbon Fiber Airframe Mandrels & Molds',
        'Heavy-Duty Static Test Stand Thrust Plates',
        'Rocket Integration & Ejection Cradles',
        'Custom Pelican CNC Flight Box Foam Inserts',
      ],
      badge: 'Heavy Aerospace Tooling',
      badgeColor: 'text-primary border-primary/30 bg-primary/10',
      icon: Wrench,
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
            Verified Manufacturing Bases
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            Factory Floor &amp; Machine Showcase
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg text-justify max-w-2xl mx-auto">
            Direct access to tier-1 manufacturing clusters in China with proven capability in high-spec aerospace, CubeSat, and rocketry hardware.
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
            onClick={() => setActiveTab('pcba')}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-accent uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'pcba'
                ? 'bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20 border border-primary/40 pulse-glow'
                : 'bg-card/70 text-muted-foreground hover:text-foreground border border-accent/20'
            }`}
          >
            Turnkey PCBA
          </button>
          <button
            onClick={() => setActiveTab('tooling')}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-accent uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'tooling'
                ? 'bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20 border border-primary/40 pulse-glow'
                : 'bg-card/70 text-muted-foreground hover:text-foreground border border-accent/20'
            }`}
          >
            Tooling &amp; GSE
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
                      <summary className="cursor-pointer text-primary hover:text-primary/80 font-accent uppercase tracking-wider text-[11px]">
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
                      <span>Certified Aerospace Materials</span>
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
      </div>
    </section>
  );
}
