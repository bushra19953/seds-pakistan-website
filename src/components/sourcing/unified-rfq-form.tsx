'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  CheckCircle2,
  Loader2,
  Shield,
  Factory,
  Copy,
  ArrowRight,
  ArrowLeft,
  Lock,
  UserCheck,
  LogIn,
  FileCheck,
} from 'lucide-react';
import CadDropzone, { CadUploadMeta } from './cad-dropzone';

// Must match MANUFACTURING_CATEGORIES in src/app/api/sourcing/rfq/route.ts exactly.
// The server rejects any category not on this list.
const CATEGORIES = [
  '5-Axis High-Speed CNC Machining (Sendottech / Dongguan)',
  'Multilayer SMT PCBA & Avionics (ILINKGLOBE / Shenzhen)',
  'SLM Metal Additive Manufacturing Inconel/Titanium (Yunzhu 3D / Shanghai)',
  'Precision Molds & Aerospace Composites (Taizhou Tengfei)',
];

const AFFILIATIONS = [
  'SEDS Pakistan',
  'SEDS USA',
  'UKSEDS (United Kingdom)',
  'SEDS Canada',
  'International SEDS (Other Chapter)',
  'University Research Lab',
  'Aerospace Startup / Team',
];

// One-click pilot packages: prefill category + material + quantity for teams testing us first.
const PILOT_PACKAGES = [
  {
    title: '5-Axis CNC Motor Mounts & Brackets',
    desc: 'Al 7075-T651 billet machining, lightweight pocketing, hard anodized.',
    category: CATEGORIES[0],
    material: 'Al 7075-T651 (Hard Anodized Type III)',
    quantity: '2 prototypes + 15 flight units',
  },
  {
    title: 'Avionics Flight Computer Prototypes',
    desc: 'Turnkey 4-to-8 layer SMT PCBA with full BGA X-Ray inspection.',
    category: CATEGORIES[1],
    material: 'FR4 High-Tg / ENIG Gold Finish',
    quantity: '5 turnkey prototypes',
  },
  {
    title: 'SLM Titanium Brackets & Nozzles',
    desc: 'Direct metal laser sintered Inconel/Titanium for hot structures.',
    category: CATEGORIES[2],
    material: 'Ti-6Al-4V (Grade 5)',
    quantity: '4 flight units',
  },
];

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

const STEPS = [
  { index: 1, title: 'Manufacturing', desc: 'Category, files, deadline' },
  { index: 2, title: 'Project', desc: 'Specs and tolerances' },
  { index: 3, title: 'Contact', desc: 'Who we talk to' },
  { index: 4, title: 'Review', desc: 'Confirm and transmit' },
];

function makeInquiryId() {
  return `RFQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/**
 * UnifiedRFQForm: the single Sourcing Bridge intake. A 4-step progressive flow that
 * replaces the old split between the 12-field EngineeringIntakeForm and the separate
 * RFQForm pipeline. Step 1 is low friction (category, CAD upload, deadline,
 * institution, email), then project details, then contact, then review and submit.
 *
 * Backend is unchanged: CAD files go to the Drive vault through CadDropzone, and the
 * final submit posts to /api/sourcing/rfq which returns the RFQ-PK-2026-XXXX tracking token.
 */
export default function UnifiedRFQForm() {
  const { user, isLoading: isUserLoading } = useUser();
  const { toast } = useToast();

  const [step, setStep] = useState(1);
  const [inquiryId, setInquiryId] = useState<string>(() => makeInquiryId());

  // Step 1
  const [category, setCategory] = useState('');
  const [cadFiles, setCadFiles] = useState<CadUploadMeta[]>([]);
  const [deadline, setDeadline] = useState('');
  const [institution, setInstitution] = useState('');
  const [email, setEmail] = useState('');

  // Step 2
  const [projectTitle, setProjectTitle] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [materialSpec, setMaterialSpec] = useState('');
  const [targetTolerance, setTargetTolerance] = useState('');
  const [quantity, setQuantity] = useState('');
  const [engineeringNotes, setEngineeringNotes] = useState('');

  // Step 3
  const [fullName, setFullName] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [ndaAgreed, setNdaAgreed] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [trackingToken, setTrackingToken] = useState<string | null>(null);

  // Prefill contact details for signed-in users.
  useEffect(() => {
    if (user) {
      setFullName((prev) => prev || user.displayName || '');
      setEmail((prev) => prev || user.email || '');
    }
  }, [user]);

  const clearError = (key: string) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const validateStep1 = () => {
    const next: Record<string, string> = {};
    if (!user) next.auth = 'You must be signed in to request a DFM review.';
    if (!category) next.category = 'Please select a manufacturing category.';
    if (cadFiles.length === 0) next.cadFiles = 'Upload at least one CAD package to the vault before continuing.';
    if (!institution.trim()) next.institution = 'Institution / team name is required.';
    if (!email.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) {
      next.email = 'A valid email is required so we can send your quote.';
    }
    setErrors(next);
    return next;
  };

  const validateStep2 = () => {
    const next: Record<string, string> = {};
    if (!projectTitle.trim()) next.projectTitle = 'Project Title is required.';
    if (!contactPerson.trim()) next.contactPerson = 'Contact Person is required.';
    if (!E164_REGEX.test(whatsapp.trim())) {
      next.whatsapp = 'WhatsApp Number must be in E.164 format (e.g. +923001234567).';
    }
    if (!materialSpec.trim()) next.materialSpec = 'Material Specification is required (e.g. Al 7075-T6, Inconel 718, FR-4).';
    if (!targetTolerance.trim()) next.targetTolerance = 'Target Tolerance is required (e.g. +/- 0.005mm).';
    setErrors(next);
    return next;
  };

  const validateStep3 = () => {
    const next: Record<string, string> = {};
    if (!fullName.trim()) next.fullName = 'Full Name is required.';
    if (!affiliation) next.affiliation = 'Please select your SEDS / Chapter affiliation.';
    if (!ndaAgreed) next.ndaAgreed = 'You must confirm the mutual NDA agreement.';
    setErrors(next);
    return next;
  };

  const goNext = () => {
    const errs = step === 1 ? validateStep1() : step === 2 ? validateStep2() : validateStep3();
    if (Object.keys(errs).length > 0) {
      toast({ title: 'Missing Required Fields', description: 'Please complete all highlighted fields.', variant: 'destructive' });
      return;
    }
    setStep((s) => Math.min(s + 1, 4));
    window.scrollTo({ top: document.getElementById('intake-form')?.offsetTop ?? 0, behavior: 'smooth' });
  };

  const goBack = () => {
    setErrors({});
    setStep((s) => Math.max(s - 1, 1));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast({ title: 'Authentication Required', description: 'Please sign in before submitting your RFQ.', variant: 'destructive' });
      return;
    }
    // Final full pass over every step before transmitting.
    const errs = { ...validateStep1(), ...validateStep2(), ...validateStep3() };
    if (Object.keys(errs).length > 0) {
      const firstBad = [1, 2, 3].find((s) =>
        (s === 1 && Object.keys(validateStep1()).length) ||
        (s === 2 && Object.keys(validateStep2()).length) ||
        (s === 3 && Object.keys(validateStep3()).length),
      );
      if (firstBad) setStep(firstBad);
      toast({ title: 'Missing Required Fields', description: 'Please complete all highlighted fields.', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      // Fold the intake-only fields (no dedicated columns in the RFQ record) into notes
      // so nothing the user typed is lost on the backend.
      const noteLines = [
        `Submitted by: ${fullName.trim()} <${email.trim()}>`,
        `SEDS affiliation: ${affiliation}`,
        'Mutual NDA & IP agreement: confirmed',
      ];
      if (quantity.trim()) noteLines.push(`Quantity: ${quantity.trim()}`);
      if (deadline) noteLines.push(`Target deadline: ${deadline}`);
      if (engineeringNotes.trim()) noteLines.push(`Engineering notes: ${engineeringNotes.trim()}`);
      const notes = noteLines.join('\n');

      const idToken = await user.getIdToken();
      const res = await fetch('/api/sourcing/rfq', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          projectTitle: projectTitle.trim(),
          organizationName: institution.trim(),
          contactPerson: contactPerson.trim(),
          whatsapp: whatsapp.trim(),
          category,
          materialSpec: materialSpec.trim(),
          targetTolerance: targetTolerance.trim(),
          inquiryId,
          cadFiles,
          notes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to submit RFQ.');
      setTrackingToken(data.trackingToken);
      toast({ title: 'RFQ Submitted', description: `Tracking token: ${data.trackingToken}` });
    } catch (err: any) {
      toast({ title: 'Submission Failed', description: err.message || 'An error occurred.', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setTrackingToken(null);
    setStep(1);
    setErrors({});
    setCategory('');
    setCadFiles([]);
    setDeadline('');
    setInstitution('');
    setEmail(user?.email || '');
    setProjectTitle('');
    setContactPerson('');
    setWhatsapp('');
    setMaterialSpec('');
    setTargetTolerance('');
    setQuantity('');
    setEngineeringNotes('');
    setFullName(user?.displayName || '');
    setAffiliation('');
    setNdaAgreed(false);
    setInquiryId(makeInquiryId());
  };

  const copyToken = () => {
    if (trackingToken) {
      navigator.clipboard.writeText(trackingToken).catch(() => {});
      toast({ title: 'Copied', description: 'Tracking token copied to clipboard.' });
    }
  };

  const inputClass = (hasError?: string) =>
    `bg-card border ${hasError ? 'border-destructive' : 'border-border'} text-foreground placeholder:text-muted-foreground`;

  const fieldLabel = (text: string, required?: boolean) => (
    <Label className="text-xs font-accent uppercase tracking-wider font-semibold flex items-center gap-1">
      <span>{text}</span>
      {required && <span className="text-primary">*</span>}
    </Label>
  );

  const fieldError = (key: string) =>
    errors[key] ? <p className="text-xs text-destructive">{errors[key]}</p> : null;

  const summaryRows = useMemo(
    () => [
      ['Manufacturing category', category],
      ['CAD packages', `${cadFiles.length} file${cadFiles.length === 1 ? '' : 's'} uploaded`],
      ['Target deadline', deadline || 'Not set'],
      ['Institution', institution],
      ['Email', email],
      ['Project title', projectTitle],
      ['Contact person', contactPerson],
      ['WhatsApp', whatsapp],
      ['Material spec', materialSpec],
      ['Target tolerance', targetTolerance],
      ['Quantity', quantity || 'Not set'],
      ['Engineering notes', engineeringNotes || 'None'],
      ['Full name', fullName],
      ['Affiliation', affiliation],
      ['NDA agreement', ndaAgreed ? 'Confirmed' : 'Not confirmed'],
    ],
    [category, cadFiles, deadline, institution, email, projectTitle, contactPerson, whatsapp, materialSpec, targetTolerance, quantity, engineeringNotes, fullName, affiliation, ndaAgreed],
  );

  // Success state: tracking token card (same treatment as the old RFQ pipeline).
  if (trackingToken) {
    return (
      <section className="py-16 md:py-24 bg-[#0B0F19]">
        <div className="container mx-auto px-4 md:px-6 max-w-3xl text-center">
          <div className="p-8 sm:p-12 rounded-2xl border border-primary/40 bg-card/90 backdrop-blur-md shadow-2xl shadow-primary/10">
            <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-3xl sm:text-4xl font-headline text-foreground uppercase tracking-wide mb-3">
              RFQ Transmitted
            </h2>
            <p className="text-muted-foreground font-body text-sm leading-relaxed mb-6">
              Your manufacturing request has been logged. Our Shanghai liaison team will review your CAD package
              and respond with a 48-hour DFM report plus factory-direct pricing. Keep this tracking token for all follow-ups.
            </p>
            <button
              type="button"
              onClick={copyToken}
              className="inline-flex items-center gap-3 px-6 py-4 rounded-xl bg-primary/10 border border-primary/40 text-primary font-mono text-xl tracking-widest hover:bg-primary/20 transition-colors"
            >
              {trackingToken}
              <Copy className="w-5 h-5" />
            </button>
            <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 border border-accent/25 text-xs font-accent uppercase tracking-wider text-accent">
              <Shield className="w-4 h-4" />
              <span>Mutual NDA IP Protection Active</span>
            </div>
            <div className="mt-8">
              <Button onClick={resetForm}>Submit Another RFQ</Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="intake-form" className="py-16 md:py-24 bg-[#0B0F19] border-t border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl">
        <div className="text-center max-w-3xl mx-auto mb-10">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4">
            <Factory className="w-3.5 h-3.5 text-primary" />
            <span>Request Manufacturing Quote</span>
          </div>
          <h2 className="text-4xl sm:text-5xl font-headline tracking-wide text-foreground uppercase mb-4">
            Get a 48-Hour DFM Review
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg">
            Tell us what you are manufacturing and drop your CAD files. Our Shanghai fellows review tolerances
            and toolpaths, then deliver factory-direct pricing within 48 hours.
          </p>
        </div>

        {!isUserLoading && !user ? (
          <div className="rounded-2xl border border-primary/30 bg-card/90 backdrop-blur-md p-8 sm:p-12 text-center shadow-2xl shadow-primary/10 space-y-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 text-primary flex items-center justify-center mx-auto mb-2">
              <Lock className="w-8 h-8" />
            </div>
            <div className="space-y-2 max-w-lg mx-auto">
              <h3 className="text-2xl sm:text-3xl font-headline text-foreground uppercase tracking-wider">
                Sign In to Request a Quote
              </h3>
              <p className="text-xs sm:text-sm text-muted-foreground font-body leading-relaxed">
                To guarantee mutual NDA confidentiality and bind aerospace quality records to your team,
                please sign in or register before uploading your CAD package.
              </p>
            </div>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href="/auth?redirect=/sourcing-bridge#intake-form" className="w-full sm:w-auto">
                <Button
                  size="lg"
                  className="w-full sm:w-auto bg-primary hover:bg-primary/90 text-primary-foreground font-accent tracking-widest uppercase font-semibold py-4 px-8 rounded-xl shadow-lg shadow-primary/25 border border-primary/40 cursor-pointer flex items-center justify-center gap-2"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Sign In / Create Account</span>
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
            </div>
            <div className="pt-4 border-t border-border/40 flex items-center justify-center gap-2 text-[11px] font-accent uppercase tracking-widest text-muted-foreground">
              <Shield className="w-3.5 h-3.5 text-primary" />
              <span>Mutual NDA &amp; EAR99 Protection Guaranteed</span>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card/60 p-6 sm:p-10">
            {/* Progress indicator */}
            <ol className="flex items-center justify-between gap-2 mb-10">
              {STEPS.map((s) => (
                <li key={s.index} className="flex-1 flex flex-col items-center text-center">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-accent font-bold border transition-colors ${
                      s.index < step
                        ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-400'
                        : s.index === step
                          ? 'bg-primary/15 border-primary text-primary'
                          : 'bg-background border-border/60 text-muted-foreground'
                    }`}
                  >
                    {s.index < step ? <CheckCircle2 className="w-4 h-4" /> : s.index}
                  </div>
                  <p className={`mt-2 text-[11px] font-accent uppercase tracking-wider ${s.index === step ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
                    {s.title}
                  </p>
                  <p className="hidden sm:block text-[10px] text-muted-foreground font-body">{s.desc}</p>
                </li>
              ))}
            </ol>

            {errors.auth && (
              <p className="text-sm text-destructive font-body rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 mb-6">
                {errors.auth}
              </p>
            )}

            {step === 1 && (
              <div className="space-y-6">
                {/* Pilot packages */}
                <div className="p-5 sm:p-6 rounded-2xl bg-card/90 border border-emerald-500/30 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-xs sm:text-sm font-accent uppercase tracking-widest text-emerald-400 font-bold">
                        Testing Us First? Rapid $200-$500 Pilot Packages
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-muted-foreground bg-background/80 px-2.5 py-1 rounded-md border border-border/50 self-start sm:self-auto">
                      Zero Minimum Commitment · 48h DFM
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                    {PILOT_PACKAGES.map((pkg) => (
                      <button
                        key={pkg.title}
                        type="button"
                        onClick={() => {
                          setCategory(pkg.category);
                          setMaterialSpec(pkg.material);
                          setQuantity(pkg.quantity);
                          clearError('category');
                          toast({ title: 'Pilot Package Selected', description: pkg.title });
                        }}
                        className={`p-3.5 rounded-xl bg-background/90 border text-left transition-all cursor-pointer flex flex-col justify-between group ${
                          category === pkg.category
                            ? 'border-emerald-500/70 bg-emerald-950/20'
                            : 'border-emerald-500/25 hover:border-emerald-500/60 hover:bg-emerald-950/20'
                        }`}
                      >
                        <div>
                          <div className="text-xs font-accent uppercase tracking-wide text-foreground font-bold mb-1.5 group-hover:text-emerald-400 transition-colors">
                            {pkg.title}
                          </div>
                          <p className="text-[11px] text-muted-foreground font-body leading-relaxed">{pkg.desc}</p>
                        </div>
                        <div className="mt-3 text-[10px] font-mono text-emerald-400 font-semibold flex items-center justify-between border-t border-border/40 pt-2">
                          <span>48h DFM</span>
                          <span>Express Ship</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  {fieldLabel('What are you manufacturing?', true)}
                  <select
                    id="unified-category"
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      clearError('category');
                    }}
                    className={`w-full rounded-md bg-card border px-3 py-2.5 text-sm text-foreground ${errors.category ? 'border-destructive' : 'border-border'}`}
                  >
                    <option value="" disabled>
                      Select manufacturing base
                    </option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {fieldError('category')}
                </div>

                <div className="space-y-2">
                  {fieldLabel('CAD package upload (100MB vault)', true)}
                  <CadDropzone
                    inquiryId={inquiryId}
                    university={institution || 'general'}
                    onFilesChange={(files) => {
                      setCadFiles(files);
                      clearError('cadFiles');
                    }}
                    disabled={isSubmitting || isUserLoading}
                  />
                  {fieldError('cadFiles')}
                  <p className="text-xs text-muted-foreground font-body">
                    Inquiry ID: <span className="font-mono">{inquiryId}</span>
                  </p>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    {fieldLabel('Institution / team', true)}
                    <Input
                      id="unified-institution"
                      value={institution}
                      onChange={(e) => {
                        setInstitution(e.target.value);
                        clearError('institution');
                      }}
                      placeholder="e.g. IST Rocketry Team"
                      className={inputClass(errors.institution)}
                    />
                    {fieldError('institution')}
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('Email', true)}
                    <Input
                      id="unified-email"
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearError('email');
                      }}
                      placeholder="you@university.edu"
                      className={inputClass(errors.email)}
                    />
                    {fieldError('email')}
                    <p className="text-[11px] text-muted-foreground font-body">Your DFM report and quote land here.</p>
                  </div>
                </div>

                <div className="space-y-2">
                  {fieldLabel('Target deadline (optional)')}
                  <Input
                    id="unified-deadline"
                    type="date"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className={inputClass()}
                  />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    {fieldLabel('Project title', true)}
                    <Input
                      id="unified-title"
                      value={projectTitle}
                      onChange={(e) => {
                        setProjectTitle(e.target.value);
                        clearError('projectTitle');
                      }}
                      placeholder="e.g. 3U CubeSat Reaction Wheel Housing"
                      className={inputClass(errors.projectTitle)}
                    />
                    {fieldError('projectTitle')}
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('Contact person', true)}
                    <Input
                      id="unified-contact"
                      value={contactPerson}
                      onChange={(e) => {
                        setContactPerson(e.target.value);
                        clearError('contactPerson');
                      }}
                      placeholder="Full name"
                      className={inputClass(errors.contactPerson)}
                    />
                    {fieldError('contactPerson')}
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('WhatsApp number (E.164)', true)}
                    <Input
                      id="unified-whatsapp"
                      value={whatsapp}
                      onChange={(e) => {
                        setWhatsapp(e.target.value);
                        clearError('whatsapp');
                      }}
                      placeholder="+923001234567"
                      className={inputClass(errors.whatsapp)}
                    />
                    {fieldError('whatsapp')}
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('Required quantity (optional)')}
                    <Input
                      id="unified-quantity"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      placeholder="2 prototypes + 15 flight units"
                      className={inputClass()}
                    />
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('Material specification', true)}
                    <Input
                      id="unified-material"
                      value={materialSpec}
                      onChange={(e) => {
                        setMaterialSpec(e.target.value);
                        clearError('materialSpec');
                      }}
                      placeholder="e.g. Al 7075-T6, Inconel 718, FR-4"
                      className={inputClass(errors.materialSpec)}
                    />
                    {fieldError('materialSpec')}
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('Target tolerance', true)}
                    <Input
                      id="unified-tolerance"
                      value={targetTolerance}
                      onChange={(e) => {
                        setTargetTolerance(e.target.value);
                        clearError('targetTolerance');
                      }}
                      placeholder="e.g. +/- 0.005mm"
                      className={inputClass(errors.targetTolerance)}
                    />
                    {fieldError('targetTolerance')}
                  </div>
                </div>
                <div className="space-y-2">
                  {fieldLabel('Critical tolerances & engineering notes (optional)')}
                  <Textarea
                    id="unified-notes"
                    value={engineeringNotes}
                    onChange={(e) => setEngineeringNotes(e.target.value)}
                    placeholder="Hole tolerances (e.g. H7/g6), surface finish, conformal coating, special handling..."
                    className={inputClass()}
                    rows={3}
                  />
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <div className="p-4 rounded-xl bg-primary/10 border border-primary/25 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-accent uppercase tracking-wider text-primary">
                  <div className="flex items-center gap-2 font-semibold">
                    <Shield className="w-4 h-4 text-primary flex-shrink-0" />
                    <span>Strict IP Protection &amp; Confidentiality Guarantee</span>
                  </div>
                  {user && (
                    <div className="flex items-center gap-1.5 text-emerald-400 font-mono text-[11px] lowercase bg-emerald-950/40 px-2.5 py-1 rounded-md border border-emerald-500/30">
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>{user.email}</span>
                    </div>
                  )}
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    {fieldLabel('Full name', true)}
                    <Input
                      id="unified-fullname"
                      value={fullName}
                      onChange={(e) => {
                        setFullName(e.target.value);
                        clearError('fullName');
                      }}
                      placeholder="Alex Henderson"
                      className={inputClass(errors.fullName)}
                    />
                    {fieldError('fullName')}
                  </div>
                  <div className="space-y-2">
                    {fieldLabel('SEDS / chapter affiliation', true)}
                    <select
                      id="unified-affiliation"
                      value={affiliation}
                      onChange={(e) => {
                        setAffiliation(e.target.value);
                        clearError('affiliation');
                      }}
                      className={`w-full rounded-md bg-card border px-3 py-2.5 text-sm text-foreground ${errors.affiliation ? 'border-destructive' : 'border-border'}`}
                    >
                      <option value="" disabled>
                        Select SEDS Chapter / Org
                      </option>
                      {AFFILIATIONS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                    {fieldError('affiliation')}
                  </div>
                </div>

                <div>
                  <div className="flex items-start gap-3 p-4 rounded-xl bg-accent/10 border border-accent/25">
                    <Checkbox
                      id="unified-nda"
                      checked={ndaAgreed}
                      onCheckedChange={(checked) => {
                        setNdaAgreed(!!checked);
                        clearError('ndaAgreed');
                      }}
                      className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    />
                    <div className="space-y-2">
                      <Label htmlFor="unified-nda" className="text-sm text-foreground cursor-pointer font-accent uppercase tracking-wider font-semibold">
                        Mutual NDA &amp; Intellectual Property Agreement *
                      </Label>
                      <p className="text-xs text-muted-foreground font-body leading-relaxed">
                        By checking this box, you confirm that uploaded designs remain 100% the intellectual property
                        of your university team. SEDS Pakistan and verified manufacturing partners operate under
                        strict confidentiality and non-disclosure obligations.
                      </p>
                      <p className="text-[11px] text-muted-foreground font-body leading-relaxed pt-1 border-t border-accent/20">
                        <span className="text-primary font-bold">Export Control Classification:</span> All components
                        sourced through the SEDS Sourcing Bridge are strictly classified as commercial academic
                        research prototypes, ground support equipment (GSE), and structural mockups under EAR99 /
                        Civil Dual-Use classifications. We do not manufacture ITAR-restricted or munitions list hardware.
                      </p>
                    </div>
                  </div>
                  {fieldError('ndaAgreed')}
                </div>
              </div>
            )}

            {step === 4 && (
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="rounded-xl border border-border bg-background/60 divide-y divide-border/40">
                  {summaryRows.map(([label, value]) => (
                    <div key={label} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 px-4 sm:px-6 py-3">
                      <span className="text-xs font-accent uppercase tracking-wider text-muted-foreground">{label}</span>
                      <span className="text-sm font-body text-foreground text-left sm:text-right break-words max-w-xl">{value}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground font-body">
                  <FileCheck className="w-4 h-4 text-emerald-400" />
                  <span>
                    Transmitting sends your package to the Shanghai liaison team and returns your RFQ tracking token.
                  </span>
                </div>
                <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Transmitting RFQ...
                    </>
                  ) : (
                    'Submit Request to Manufacturing Bases'
                  )}
                </Button>
              </form>
            )}

            {/* Step navigation */}
            {step < 4 && (
              <div className="mt-10 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <Button type="button" variant="outline" onClick={goBack} disabled={step === 1} className="sm:w-auto w-full">
                  <ArrowLeft className="w-4 h-4 mr-2" /> Back
                </Button>
                <Button type="button" onClick={goNext} size="lg" className="sm:w-auto w-full">
                  {step === 1 ? (
                    <>Get DFM Review <ArrowRight className="w-4 h-4 ml-2" /></>
                  ) : (
                    <>Continue <ArrowRight className="w-4 h-4 ml-2" /></>
                  )}
                </Button>
              </div>
            )}
            {step === 4 && !trackingToken && (
              <div className="mt-6 flex justify-start">
                <Button type="button" variant="outline" onClick={goBack}>
                  <ArrowLeft className="w-4 h-4 mr-2" /> Back
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
