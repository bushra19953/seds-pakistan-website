import React from 'react';
import { ShieldCheck, Cpu, Clock, Compass, ArrowRight, Zap, Award } from 'lucide-react';

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
            <span className="text-border">|</span>
            <span>ACADEMIC HARDWARE PIPELINE</span>
          </div>
          
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-accent/30 bg-accent/10 text-accent text-xs font-accent tracking-wider uppercase">
            <Award className="w-3.5 h-3.5" />
            <span>SJTU Fellow Coordinated</span>
          </div>
        </div>

        {/* H1 Headline - SEDS Retro-Futuristic Bebas Neue with Text Glow */}
        <h1 className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-headline tracking-tight text-foreground max-w-5xl leading-[0.95] mb-6 text-glow uppercase">
          Direct Factory-Floor Access for{' '}
          <span className="text-primary text-glow">
            Collegiate Aerospace
          </span>{' '}
          &amp; Hardware Teams
        </h1>

        {/* Sub-headline */}
        <p className="text-base sm:text-lg lg:text-xl text-muted-foreground max-w-3xl leading-relaxed mb-10 font-body text-justify">
          Eliminate 12-week machine shop delays and 500% low-volume markups. Access verified{' '}
          <strong className="text-foreground font-semibold">5-axis CNC machining</strong>,{' '}
          <strong className="text-foreground font-semibold">rapid tooling</strong>, and{' '}
          <strong className="text-foreground font-semibold">turnkey IATF 16949 electronics prototyping</strong> through{' '}
          on-ground engineering coordination in Shanghai.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 mb-14">
          <a
            href="#intake-form"
            className="bg-primary hover:bg-primary/90 text-primary-foreground font-accent tracking-widest uppercase font-semibold px-6 sm:px-8 py-4 text-xs sm:text-sm rounded-lg shadow-xl shadow-primary/20 border border-primary/40 transition-all cursor-pointer flex items-center justify-center gap-2 group text-center whitespace-normal leading-snug hover:text-glow pulse-glow"
          >
            <span>Request 48-Hour DFM &amp; Benchmark Quote</span>
            <ArrowRight className="w-4 h-4 flex-shrink-0 group-hover:translate-x-1 transition-transform" />
          </a>

          <a
            href="#capabilities"
            className="border border-accent/30 hover:border-primary/60 bg-card/60 hover:bg-card text-foreground font-accent tracking-widest uppercase font-medium px-6 sm:px-8 py-4 text-xs sm:text-sm rounded-lg cursor-pointer text-center whitespace-normal leading-snug transition-all shadow-md"
          >
            Explore Verified Capabilities
          </a>
        </div>

        {/* 4 Metric Badges Grid - Glassmorphic SEDS Card Styling */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl border border-accent/20 bg-card/80 backdrop-blur-md hover:border-primary/50 shadow-xl shadow-accent/5 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 rounded-lg bg-primary/10 text-primary border border-primary/20 group-hover:scale-110 transition-transform">
                <Compass className="w-5 h-5" />
              </div>
              <div className="font-accent text-xs text-muted-foreground uppercase tracking-wider">5-Axis Precision</div>
            </div>
            <div className="text-2xl sm:text-3xl font-headline text-foreground tracking-wide text-glow mb-1">±0.005 mm</div>
            <p className="text-xs text-muted-foreground font-body">Al 7075-T651 / Ti-6Al-4V</p>
          </div>

          <div className="p-5 rounded-xl border border-accent/20 bg-card/80 backdrop-blur-md hover:border-primary/50 shadow-xl shadow-accent/5 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 rounded-lg bg-accent/10 text-accent border border-accent/20 group-hover:scale-110 transition-transform">
                <Cpu className="w-5 h-5" />
              </div>
              <div className="font-accent text-xs text-muted-foreground uppercase tracking-wider">Turnkey SMT &amp; X-Ray</div>
            </div>
            <div className="text-2xl sm:text-3xl font-headline text-foreground tracking-wide text-glow mb-1">IATF 16949</div>
            <p className="text-xs text-muted-foreground font-body">01005 passives &amp; 0.2mm BGA pitch</p>
          </div>

          <div className="p-5 rounded-xl border border-accent/20 bg-card/80 backdrop-blur-md hover:border-primary/50 shadow-xl shadow-accent/5 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 rounded-lg bg-primary/10 text-primary border border-primary/20 group-hover:scale-110 transition-transform">
                <Clock className="w-5 h-5" />
              </div>
              <div className="font-accent text-xs text-muted-foreground uppercase tracking-wider">Turnaround</div>
            </div>
            <div className="text-2xl sm:text-3xl font-headline text-foreground tracking-wide text-glow mb-1">10–14 Days</div>
            <p className="text-xs text-muted-foreground font-body">Spindle Time + Air Express Delivery</p>
          </div>

          <div className="p-5 rounded-xl border border-accent/20 bg-card/80 backdrop-blur-md hover:border-primary/50 shadow-xl shadow-accent/5 transition-all group">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 rounded-lg bg-accent/10 text-accent border border-accent/20 group-hover:scale-110 transition-transform">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="font-accent text-xs text-muted-foreground uppercase tracking-wider">Quality Shield</div>
            </div>
            <div className="text-2xl sm:text-3xl font-headline text-foreground tracking-wide text-glow mb-1">Zeiss CMM</div>
            <p className="text-xs text-muted-foreground font-body">On-Ground First-Article Inspection</p>
          </div>
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
