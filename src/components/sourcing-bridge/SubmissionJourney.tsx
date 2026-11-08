import React from 'react';
import {
  Send,
  Inbox,
  FileSearch,
  MessageCircleQuestion,
  Receipt,
  ShieldCheck,
  Cog,
  ScanSearch,
  ClipboardCheck,
  PlaneTakeoff,
  ArrowDown,
  Lock,
} from 'lucide-react';
import { JourneySpine, JourneyReveal } from './JourneyMotion';

// Each stage answers three questions so the visitor always knows
// their role: what they provide, what the Sourcing Bridge team does,
// and what they receive in return.
const stages = [
  {
    step: '01',
    title: 'Submit',
    tagline: 'Your package enters the secure engineering vault.',
    icon: Send,
    provide: 'CAD files, 2D drawings, BOM, target date, and your contact email.',
    action: 'Your files land in the secure vault. Access is restricted to the SEDS Sourcing Bridge engineering team only.',
    receive: 'Instant confirmation plus your RFQ tracking token (RFQ-PK-2026-XXXX).',
  },
  {
    step: '02',
    title: 'Package received',
    tagline: 'We confirm everything arrived intact.',
    icon: Inbox,
    provide: 'Nothing more, unless we spot a gap.',
    action: 'Completeness check: file integrity, formats, required fields, and export classification screening.',
    receive: 'A short checklist of anything missing, so nothing stalls silently.',
  },
  {
    step: '03',
    title: 'Engineering review',
    tagline: 'Fellows at SJTU review your design for manufacturability.',
    icon: FileSearch,
    provide: 'Quick answers to clarifying questions, only if we have any.',
    action: 'On-ground engineering fellows review tolerances, wall thicknesses, materials, and assembly approach.',
    receive: 'A plain-language summary of what reviewers examined.',
  },
  {
    step: '04',
    title: 'DFM questions',
    tagline: 'Problems get caught before they cost you money.',
    icon: MessageCircleQuestion,
    provide: 'Fast answers on threads, finishes, fits, and critical dimensions.',
    action: 'We flag anything that would fail in machining or assembly and propose fixes with you, not after you.',
    receive: 'A concise DFM note list, written for engineers, not sales decks.',
  },
  {
    step: '05',
    title: 'Factory quote',
    tagline: 'Real numbers from verified manufacturing bases.',
    icon: Receipt,
    provide: 'Your target budget window, if you have one.',
    action: 'We solicit factory-direct benchmark quotes across the verified network and sanity-check them against your DFM notes.',
    receive: 'A line-item quote with DFM notes and an estimated production timeline.',
  },
  {
    step: '06',
    title: 'You approve',
    tagline: 'The gate that matters most.',
    icon: ShieldCheck,
    isApprovalGate: true,
    provide: 'Written approval of the quote, quantities, and timeline.',
    action: 'Nothing moves forward without your sign-off. No spindle time is booked, no material is ordered.',
    receive: 'Production authorization confirmation with a locked scope of work.',
  },
  {
    step: '07',
    title: 'Production',
    tagline: 'Your approved design goes to the factory floor.',
    icon: Cog,
    provide: 'Your approved package is already in the vault. No further action needed.',
    action: 'Spindle time is booked and an on-ground engineer coordinates the run, watching tolerances in person.',
    receive: 'Production start notice plus status updates as your parts move through the line.',
  },
  {
    step: '08',
    title: 'First article inspection',
    tagline: 'Measured, not assumed.',
    icon: ScanSearch,
    provide: 'Nothing. This stage is entirely on us.',
    action: 'Physical first-article inspection on Zeiss CMM in Shanghai. Every critical dimension is verified against your GD&T.',
    receive: 'A full inspection report with measured values, not pass/fail stamps.',
  },
  {
    step: '09',
    title: 'QC report',
    tagline: 'Final verification before anything ships.',
    icon: ClipboardCheck,
    provide: 'Approval of the FAI results, or revision requests if something is off.',
    action: 'Final QC pass, packing documentation, and shipment preparation.',
    receive: 'The complete QC report package for your records and your faculty advisor.',
  },
  {
    step: '10',
    title: 'Shipment',
    tagline: 'Inspected hardware, tracked to your lab.',
    icon: PlaneTakeoff,
    provide: 'Shipping address and any customs details for your institution.',
    action: 'Express air dispatch with full tracking and export-compliant documentation.',
    receive: 'Your hardware, delivered. Track it with the same RFQ token from step one.',
  },
];

export default function SubmissionJourney() {
  return (
    <section id="after-you-submit" className="py-16 md:py-24 bg-background border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            After You Click Submit
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase mb-4">
            What Happens After You Submit
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg max-w-2xl mx-auto">
            Submitting CAD is the start of a guided process, not a leap of faith.
            Here is every step between your upload and inspected hardware arriving at your lab.
          </p>
        </div>

        {/* Vertical Timeline: a route card. One rail, one accent (the
            site's primary, reserved for progress and the approval
            gate); every stage panel reads like a spec sheet row set. */}
        <JourneySpine>
          <div className="space-y-7">
            {stages.map((stage) => {
              const isGate = (stage as { isApprovalGate?: boolean }).isApprovalGate;

              return (
                <JourneyReveal key={stage.step} className="relative flex gap-5 md:gap-7">
                  {/* Node */}
                  <div className="relative z-10 shrink-0">
                    <div
                      className={`w-14 h-14 rounded-lg border flex items-center justify-center ${
                        isGate
                          ? 'border-primary bg-primary text-primary-foreground ring-1 ring-primary/40'
                          : 'border-border bg-card text-foreground'
                      }`}
                    >
                      <stage.icon className="w-6 h-6" />
                    </div>
                    <span className="absolute -bottom-1 -right-1 text-[10px] font-accent font-bold bg-background border border-border rounded-full px-1.5 py-0.5 text-muted-foreground">
                      {stage.step}
                    </span>
                  </div>

                  {/* Card */}
                  <div
                    className={`flex-1 rounded-xl border bg-card p-5 md:p-6 shadow-sm ${
                      isGate ? 'border-primary/60 bg-primary/[0.04]' : 'border-border/70'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <h3 className="text-xl md:text-2xl font-headline tracking-wide text-foreground uppercase">
                        {stage.title}
                      </h3>
                      {isGate && (
                        <span className="px-2.5 py-0.5 rounded text-xs font-accent uppercase tracking-wider border font-semibold text-primary bg-primary/10 border-primary/30">
                          Approval Gate
                        </span>
                      )}
                    </div>
                    <p className={`text-xs sm:text-sm font-body mb-4 ${isGate ? 'text-primary-text font-semibold' : 'text-muted-foreground'}`}>
                      {stage.tagline}
                    </p>

                    {isGate && (
                      <p className="text-base md:text-lg font-headline tracking-wide text-foreground uppercase border-l-2 border-primary pl-3 mb-4">
                        No manufacturing starts without your approval.
                      </p>
                    )}

                    <dl className="divide-y divide-border/50 text-xs sm:text-sm">
                      <div className="flex gap-3 py-2.5 first:pt-0">
                        <dt className="w-24 shrink-0 font-accent uppercase tracking-wider text-foreground/60 font-semibold">
                          You provide
                        </dt>
                        <dd className="text-muted-foreground font-body leading-relaxed">{stage.provide}</dd>
                      </div>
                      <div className="flex gap-3 py-2.5">
                        <dt className="w-24 shrink-0 font-accent uppercase tracking-wider text-foreground/60 font-semibold">
                          We do
                        </dt>
                        <dd className="text-muted-foreground font-body leading-relaxed">{stage.action}</dd>
                      </div>
                      <div className="flex gap-3 py-2.5 last:pb-0">
                        <dt className="w-24 shrink-0 font-accent uppercase tracking-wider text-foreground/60 font-semibold">
                          You receive
                        </dt>
                        <dd className="text-muted-foreground font-body leading-relaxed">{stage.receive}</dd>
                      </div>
                    </dl>
                  </div>
                </JourneyReveal>
              );
            })}
          </div>

          {/* End marker */}
          <JourneyReveal className="relative flex gap-5 md:gap-7 mt-7">
            <div className="relative z-10 shrink-0">
              <div className="w-14 h-14 rounded-lg border border-primary/40 bg-primary/10 text-primary flex items-center justify-center">
                <ArrowDown className="w-6 h-6" />
              </div>
            </div>
            <div className="flex-1 flex items-center">
              <p className="text-sm font-body text-muted-foreground">
                Hardware in hand. That is the whole journey, end to end.
              </p>
            </div>
          </JourneyReveal>
        </JourneySpine>

        {/* IP and trust reassurance strip */}
        <div className="mt-14 rounded-xl border border-border/70 bg-card p-6 md:p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-lg bg-primary/10 border border-primary/20 text-primary shrink-0">
              <Lock className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-xl font-headline tracking-wide text-foreground uppercase mb-2">
                Your IP remains yours
              </h3>
              <ul className="text-xs sm:text-sm text-muted-foreground font-body leading-relaxed space-y-1.5 list-disc list-inside">
                <li>NDA available before you upload anything.</li>
                <li>Vault access is restricted to the SEDS Sourcing Bridge engineering team.</li>
                <li>No manufacturing starts without your written approval.</li>
                <li>Your files are deleted on request when the engagement ends.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
