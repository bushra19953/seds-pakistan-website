import React from 'react';
import { Zap, Award, ArrowRight } from 'lucide-react';

export default function SourcingHero() {
  return (
    <section className="relative overflow-hidden pt-10 pb-16 md:pt-20 md:pb-24 border-b border-border/30 bg-background">
      {/* Background Cosmic Glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-primary/10 blur-[130px] rounded-full pointer-events-none" />
      <div className="absolute top-1/3 right-10 w-[300px] h-[250px] bg-accent/15 blur-[100px] rounded-full pointer-events-none" />

      <div className="container mx-auto px-4 md:px-6 relative z-10 max-w-6xl">
        {/* Eyebrow badges */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase backdrop-blur-sm shadow-sm">
            <Zap className="w-3.5 h-3.5 text-primary animate-pulse" />
            <span>SEDS SOURCING BRIDGE</span>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-accent/30 bg-accent/10 text-accent text-xs font-accent tracking-wider uppercase">
            <Award className="w-3.5 h-3.5" />
            <span>SJTU Fellow Coordinated</span>
          </div>
        </div>

        {/* H1 Headline - SEDS Retro-Futuristic Bebas Neue with Text Glow */}
        <h1 className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-headline tracking-tight text-foreground max-w-5xl leading-[0.95] mb-6 text-glow uppercase">
          Aerospace Manufacturing,{' '}
          <span className="text-primary text-glow">
            Coordinated on the Ground
          </span>{' '}
          in China
        </h1>

        {/* Sub-headline: the 3-step value */}
        <p className="text-base sm:text-lg lg:text-xl text-muted-foreground max-w-3xl leading-relaxed mb-4 font-body">
          Send your CAD/BOM, receive DFM feedback and a benchmark quote, then we
          manufacture, inspect, and ship your hardware.
        </p>

        {/* Capability strip */}
        <p className="text-xs sm:text-sm font-accent uppercase tracking-widest text-foreground/70 mb-10">
          48-Hour DFM Review <span className="text-primary mx-1">·</span> 5-Axis CNC{' '}
          <span className="text-primary mx-1">·</span> PCBA <span className="text-primary mx-1">·</span>{' '}
          First-Article Inspection
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 mb-14">
          <a
            href="#intake-form"
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-accent tracking-widest uppercase font-semibold px-6 sm:px-8 py-4 text-xs sm:text-sm rounded-lg shadow-xl shadow-primary/20 border border-primary/40 transition-all cursor-pointer flex items-center justify-center gap-2 group text-center whitespace-normal leading-snug hover:text-glow pulse-glow"
          >
            <span>Start an RFQ</span>
            <ArrowRight className="w-4 h-4 flex-shrink-0 group-hover:translate-x-1 transition-transform" />
          </a>

          <a
            href="#capabilities"
            className="border border-accent/30 hover:border-primary/60 bg-card/60 hover:bg-card text-foreground font-accent tracking-widest uppercase font-medium px-6 sm:px-8 py-4 text-xs sm:text-sm rounded-lg cursor-pointer text-center whitespace-normal leading-snug transition-all shadow-md"
          >
            See Capabilities
          </a>
        </div>

        {/* Operational Corridor Footer Note */}
        <div className="mt-8 pt-6 border-t border-border/40 flex flex-wrap items-center justify-between gap-4 text-xs font-body text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground/80 font-accent uppercase tracking-wider text-[10px]">Operational Base:</span>
            <span className="text-foreground">Shanghai Jiao Tong University (SJTU) / Yangtze River Delta Precision Corridor</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground/80 font-accent uppercase tracking-wider text-[10px]">Project Lead:</span>
            <span className="text-primary font-medium">Muhammad Zubair Mongol (President, SEDS Pakistan | SJTU Fellow)</span>
          </div>
        </div>
      </div>
    </section>
  );
}
