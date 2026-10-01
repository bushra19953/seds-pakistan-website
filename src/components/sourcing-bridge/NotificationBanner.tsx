import React from 'react';
import { Compass, Factory, GitPullRequest, ArrowRight } from 'lucide-react';

export default function NotificationBanner() {
  return (
    <div className="sticky top-0 z-40 w-full border-b border-accent/20 bg-background/95 backdrop-blur-md px-3 sm:px-4 py-2 text-xs text-foreground/90 shadow-md">
      <div className="container mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-3 max-w-6xl">
        {/* Left: Operational status badge */}
        <div className="flex items-center gap-2 max-w-full overflow-hidden text-center sm:text-left">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          <span className="font-accent font-bold text-primary tracking-wider uppercase text-[10px] sm:text-[11px] flex-shrink-0">
            LIVE ON-GROUND:
          </span>
          <span className="text-muted-foreground font-body text-[10px] sm:text-[11px] truncate">
            Shanghai &amp; GBA precision clusters · 48h DFM open
          </span>
        </div>

        {/* Right: Clean scrollable navigation tabs */}
        <nav className="flex items-center justify-center gap-1 sm:gap-1.5 overflow-x-auto max-w-full pb-0.5 no-scrollbar flex-shrink-0">
          <a
            href="#capabilities"
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] sm:text-[11px] font-accent uppercase tracking-wider text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap"
          >
            <Compass className="w-3 h-3 text-primary" />
            <span>Capabilities</span>
          </a>

          <span className="text-border select-none text-[10px]">•</span>

          <a
            href="#factory-showcase"
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] sm:text-[11px] font-accent uppercase tracking-wider text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap"
          >
            <Factory className="w-3 h-3 text-accent" />
            <span>Showcase</span>
          </a>

          <span className="text-border select-none text-[10px]">•</span>

          <a
            href="#how-it-works"
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[10px] sm:text-[11px] font-accent uppercase tracking-wider text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap"
          >
            <GitPullRequest className="w-3 h-3 text-primary" />
            <span>Workflow</span>
          </a>

          <a
            href="#intake-form"
            className="ml-1 sm:ml-2 flex items-center gap-1 px-3 py-1 rounded text-[10px] sm:text-[11px] font-accent uppercase tracking-widest font-semibold text-primary-foreground bg-primary hover:bg-primary/90 shadow-sm border border-primary/40 transition-all cursor-pointer whitespace-nowrap pulse-glow"
          >
            <span>Quote</span>
            <ArrowRight className="w-3 h-3" />
          </a>
        </nav>
      </div>
    </div>
  );
}
