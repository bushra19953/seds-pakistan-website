'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import {
  ShieldCheck,
  MapPin,
  CheckCircle,
  CircleDashed,
  Calendar,
  ChevronDown,
  FileCheck,
  User,
} from 'lucide-react';

// Verification standard: the six checks SEDS runs on every manufacturing base.
// Kept as data so this can move into an admin-editable collection later.
const VERIFICATION_STANDARD = [
  'Facility inspected',
  'Machinery verified',
  'Material traceability',
  'QA process reviewed',
  'First-article inspection',
  'SEDS on-ground coordination',
] as const;

type Facility = {
  id: string;
  name: string;
  location: string;
  capability: string;
  photo: string;
  photoAlt: string;
  verifiedDate: string;
  verificationPending: boolean;
  completedChecks: number;
  counterparty: { name: string; role: string };
  auditNote: string;
  evidence: string;
};

const FACILITIES: Facility[] = [
  {
    id: 'chijiang',
    name: 'Shanghai Chijiang Precision Machinery Co., Ltd.',
    location: 'Shanghai, China',
    capability: '5-Axis CNC Precision Machining',
    photo:
      'https://lh3.googleusercontent.com/d/1KYyICfmZILs4jUFdr1_vPvHy4ssX2Adj=w1600',
    photoAlt: 'Chijiang 5-axis CNC machining center on the factory floor',
    verifiedDate: 'Sep 10, 2026',
    verificationPending: false,
    completedChecks: 6,
    counterparty: { name: 'Steven Yue', role: 'General Manager' },
    auditNote:
      'On-site factory audit inspecting Doosan 5-axis CNC machining centers. Verified rapid-prototyping capabilities for aerospace impellers, lightweight aluminum structural bulkheads, and titanium components with 10-day delivery windows. Tolerances down to ±0.005 mm on 5-axis geometries in aviation-grade 7075-T6 aluminum and titanium.',
    evidence:
      'Video documentation and photo records preserved in SEDS SecondBrain archives.',
  },
  {
    id: 'guanghu',
    name: 'Guanghu Investment Casting & CNC',
    location: 'Shanghai, China',
    capability: 'Precision Investment Casting',
    photo:
      'https://lh3.googleusercontent.com/d/1WmODwHl5Zvsq7NPbbi08kxxqM7YNZW9n=w1600',
    photoAlt: 'Guanghu investment casting foundry floor',
    verifiedDate: 'Sep 7, 2026',
    verificationPending: false,
    completedChecks: 6,
    counterparty: { name: 'Stanley Yang', role: 'General Manager' },
    auditNote:
      'On-site foundry inspection of aerospace and automotive-grade investment casting facilities. Audited international export quality systems (IATF 16949, ISO 14001, ISO 45001) for casting complex thin-walled airframe structures. Inspected continuous furnace lines and coordinate measuring machine (CMM) quality control benches.',
    evidence:
      'Photographic and audit logs preserved in SEDS SecondBrain archives.',
  },
  {
    id: 'tiyitech',
    name: 'Shanghai Titanium Memory Tech (TiyiTech)',
    location: 'Minhang / Zhangjiagang, Jiangsu, China',
    capability: 'Shape Memory Alloy Actuators & Micro-Valves',
    photo:
      'https://lh3.googleusercontent.com/d/1-ZM92qZB6ZlH9BiKOuKLNDrdvQGJd_yF=w1600',
    photoAlt: 'TiyiTech SMA cleanroom furnace',
    verifiedDate: 'Documentation review in progress',
    verificationPending: true,
    completedChecks: 4,
    counterparty: { name: 'TiyiTech Advanced Materials', role: 'SJTU State Key Lab spin-off' },
    auditNote:
      'Spun directly out of the State Key Laboratory at Shanghai Jiao Tong University (SJTU) and backed by Huawei Hubble Investment. Supplies flight-proven non-explosive actuators (pin pullers, split-spool release nuts) and sub-gram SMA micro-valves for satellite cold-gas thrusters. Nitinol wire from 0.03 mm to 3.00 mm diameter, cleanroom tested.',
    evidence:
      'Partner documentation and cleanroom facility records under SEDS review.',
  },
];

function FacilityCard({ facility }: { facility: Facility }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-2xl border border-accent/20 bg-card/80 backdrop-blur-md overflow-hidden flex flex-col hover:border-primary/50 transition-all shadow-xl shadow-accent/5 group">
      {/* Facility photo */}
      <div className="relative h-52 w-full overflow-hidden">
        <Image
          src={facility.photo}
          alt={facility.photoAlt}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="(max-width: 1024px) 100vw, 33vw"
          // Drive thumbnails fail through the Next.js image optimizer
          // (server-side fetch gets blocked, returns 502). Load them
          // directly with a plain img tag instead.
          unoptimized={facility.photo.includes('drive.google.com')}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0B0F19]/90 via-transparent to-transparent" />
        <div
          className={`absolute top-3 right-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-accent uppercase tracking-wider border font-bold backdrop-blur-sm ${
            facility.verificationPending
              ? 'text-amber-300 border-amber-400/40 bg-amber-500/15'
              : 'text-emerald-300 border-emerald-400/40 bg-emerald-500/15'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {facility.verificationPending ? 'In Verification' : 'Verified'}
        </div>
      </div>

      {/* Card body */}
      <div className="p-6 flex flex-col flex-1">
        <div className="text-xs font-accent text-primary uppercase tracking-wider font-semibold mb-1.5">
          {facility.capability}
        </div>
        <h3 className="text-xl font-headline tracking-wide text-foreground uppercase mb-1.5 leading-snug">
          {facility.name}
        </h3>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-body mb-5">
          <MapPin className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span>{facility.location}</span>
        </div>

        {/* Verification checklist */}
        <div className="text-xs font-accent text-primary uppercase tracking-wider font-semibold mb-2.5 flex items-center gap-1.5">
          <FileCheck className="w-3.5 h-3.5" />
          Verification Checklist
        </div>
        <ul className="space-y-1.5 mb-5">
          {VERIFICATION_STANDARD.map((check, i) => {
            const done = i < facility.completedChecks;
            return (
              <li key={check} className="flex items-center gap-2 text-xs font-body">
                {done ? (
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                ) : (
                  <CircleDashed className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
                )}
                <span className={done ? 'text-foreground' : 'text-muted-foreground'}>
                  {check}
                </span>
              </li>
            );
          })}
        </ul>

        {/* Last verification date */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-body mb-5">
          <Calendar className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span>
            Last verification:{' '}
            <span className="text-foreground font-semibold">{facility.verifiedDate}</span>
          </span>
        </div>

        {/* Expandable verification detail */}
        {expanded && (
          <div className="rounded-xl bg-accent/10 border border-accent/25 p-4 mb-5 space-y-3">
            <div className="flex items-start gap-2">
              <User className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
              <p className="text-xs font-body text-foreground">
                <span className="font-semibold">{facility.counterparty.name}</span>
                <span className="text-muted-foreground"> · {facility.counterparty.role}</span>
              </p>
            </div>
            <p className="text-xs font-body text-muted-foreground leading-relaxed text-justify">
              {facility.auditNote}
            </p>
            <p className="text-xs font-body text-muted-foreground leading-relaxed">
              <span className="text-primary font-semibold">Evidence: </span>
              {facility.evidence}
            </p>
          </div>
        )}

        {/* View Verification toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-primary/40 bg-primary/10 text-primary text-xs font-accent uppercase tracking-wider font-bold hover:bg-primary/20 transition-all cursor-pointer"
        >
          <ShieldCheck className="w-4 h-4" />
          {expanded ? 'Hide Verification' : 'View Verification'}
          <ChevronDown
            className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
    </div>
  );
}

export default function VerifiedFacilities() {
  return (
    <section
      id="verified-facilities"
      className="py-16 md:py-24 bg-[#0B0F19] border-b border-border/30"
    >
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            <ShieldCheck className="w-3.5 h-3.5" />
            Trust &amp; Verification
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            Verified Facilities
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg text-justify max-w-2xl mx-auto">
            We do not list a facility until someone from the SEDS network has walked its
            floor. Every base below passed a six-point verification: inspection, machinery
            checks, material traceability, QA review, first-article inspection, and SEDS
            on-ground coordination.
          </p>
        </div>

        {/* Facilities Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {FACILITIES.map((facility) => (
            <FacilityCard key={facility.id} facility={facility} />
          ))}
        </div>

        {/* Honesty footnote */}
        <p className="text-center text-xs text-muted-foreground font-body mt-10 max-w-2xl mx-auto">
          Facilities marked &quot;In Verification&quot; are mid-audit. We publish them so
          you know what is coming, not to claim checks we have not finished.
        </p>
      </div>
    </section>
  );
}
