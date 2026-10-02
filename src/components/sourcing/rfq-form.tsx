'use client';

import React, { useMemo, useState } from 'react';
import { useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, Loader2, Shield, Factory, Copy } from 'lucide-react';
import CadDropzone, { CadUploadMeta } from './cad-dropzone';

const CATEGORIES = [
  '5-Axis High-Speed CNC Machining (Sendottech / Dongguan)',
  'Multilayer SMT PCBA & Avionics (ILINKGLOBE / Shenzhen)',
  'SLM Metal Additive Manufacturing Inconel/Titanium (Yunzhu 3D / Shanghai)',
  'Precision Molds & Aerospace Composites (Taizhou Tengfei)',
];

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/**
 * RFQForm: the Sourcing Bridge aerospace RFQ intake. Captures project metadata,
 * uploads CAD packages (up to 100MB each) to the cad-vault, then records the RFQ
 * via /api/sourcing/rfq which returns the RFQ-PK-2026-XXXX tracking token.
 */
export default function RFQForm() {
  const { user, isLoading: isUserLoading } = useUser();
  const { toast } = useToast();

  const inquiryId = useMemo(
    () => `RFQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    [],
  );

  const [projectTitle, setProjectTitle] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [category, setCategory] = useState('');
  const [materialSpec, setMaterialSpec] = useState('');
  const [targetTolerance, setTargetTolerance] = useState('');
  const [notes, setNotes] = useState('');
  const [cadFiles, setCadFiles] = useState<CadUploadMeta[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [trackingToken, setTrackingToken] = useState<string | null>(null);

  const validate = () => {
    const next: Record<string, string> = {};
    if (!user) next.auth = 'You must be signed in to submit an RFQ.';
    if (!projectTitle.trim()) next.projectTitle = 'Project Title is required.';
    if (!organizationName.trim()) next.organizationName = 'Organization Name is required.';
    if (!contactPerson.trim()) next.contactPerson = 'Contact Person is required.';
    if (!E164_REGEX.test(whatsapp.trim())) {
      next.whatsapp = 'WhatsApp Number must be in E.164 format (e.g. +923001234567).';
    }
    if (!category) next.category = 'Please select a manufacturing category.';
    if (!materialSpec.trim()) next.materialSpec = 'Material Specification is required (e.g. Al 7075-T6, Inconel 718, FR-4).';
    if (!targetTolerance.trim()) next.targetTolerance = 'Target Tolerance is required (e.g. +/- 0.005mm).';
    if (cadFiles.length === 0) next.cadFiles = 'Upload at least one CAD package to the vault before submitting.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast({ title: 'Authentication Required', description: 'Please sign in before submitting your RFQ.', variant: 'destructive' });
      return;
    }
    if (!validate()) {
      toast({ title: 'Missing Required Fields', description: 'Please complete all highlighted fields.', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/sourcing/rfq', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          projectTitle: projectTitle.trim(),
          organizationName: organizationName.trim(),
          contactPerson: contactPerson.trim(),
          whatsapp: whatsapp.trim(),
          category,
          materialSpec: materialSpec.trim(),
          targetTolerance: targetTolerance.trim(),
          inquiryId,
          cadFiles,
          notes: notes.trim(),
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

  const copyToken = () => {
    if (trackingToken) {
      navigator.clipboard.writeText(trackingToken).catch(() => {});
      toast({ title: 'Copied', description: 'Tracking token copied to clipboard.' });
    }
  };

  const inputClass = (hasError?: string) =>
    `bg-card border ${hasError ? 'border-destructive' : 'border-border'} text-foreground placeholder:text-muted-foreground`;

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
              Your manufacturing RFQ has been logged. Keep this tracking token for all follow-ups with the Shanghai liaison team.
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
              <Button
                onClick={() => {
                  setTrackingToken(null);
                  setCadFiles([]);
                }}
              >
                Submit Another RFQ
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="rfq-pipeline" className="py-16 md:py-24 bg-[#0B0F19] border-t border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4">
            <Factory className="w-3.5 h-3.5 text-primary" />
            <span>Aerospace RFQ Pipeline</span>
          </div>
          <h2 className="text-4xl sm:text-5xl font-headline tracking-wide text-foreground uppercase mb-4">
            Submit Manufacturing RFQ
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg">
            Upload your CAD package (up to 100MB per file) straight into the secure vault and request factory-direct quotes from our vetted Chinese manufacturing bases.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 rounded-2xl border border-border bg-card/60 p-6 sm:p-10">
          {errors.auth && (
            <p className="text-sm text-destructive font-body rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              {errors.auth}
            </p>
          )}

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rfq-project" className="text-xs font-accent uppercase tracking-wider font-semibold">
                1. Project Title *
              </Label>
              <Input
                id="rfq-project"
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                placeholder="e.g. 3U CubeSat Reaction Wheel Housing"
                className={inputClass(errors.projectTitle)}
                disabled={isSubmitting}
              />
              {errors.projectTitle && <p className="text-xs text-destructive">{errors.projectTitle}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="rfq-org" className="text-xs font-accent uppercase tracking-wider font-semibold">
                2. Organization Name *
              </Label>
              <Input
                id="rfq-org"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                placeholder="e.g. IST Rocketry Team"
                className={inputClass(errors.organizationName)}
                disabled={isSubmitting}
              />
              {errors.organizationName && <p className="text-xs text-destructive">{errors.organizationName}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="rfq-contact" className="text-xs font-accent uppercase tracking-wider font-semibold">
                3. Contact Person *
              </Label>
              <Input
                id="rfq-contact"
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
                placeholder="Full name"
                className={inputClass(errors.contactPerson)}
                disabled={isSubmitting}
              />
              {errors.contactPerson && <p className="text-xs text-destructive">{errors.contactPerson}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="rfq-whatsapp" className="text-xs font-accent uppercase tracking-wider font-semibold">
                4. WhatsApp Number (E.164) *
              </Label>
              <Input
                id="rfq-whatsapp"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
                placeholder="+923001234567"
                className={inputClass(errors.whatsapp)}
                disabled={isSubmitting}
              />
              {errors.whatsapp && <p className="text-xs text-destructive">{errors.whatsapp}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rfq-category" className="text-xs font-accent uppercase tracking-wider font-semibold">
              5. Manufacturing Category *
            </Label>
            <select
              id="rfq-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={`w-full rounded-md bg-card border px-3 py-2.5 text-sm text-foreground ${errors.category ? 'border-destructive' : 'border-border'}`}
              disabled={isSubmitting}
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
            {errors.category && <p className="text-xs text-destructive">{errors.category}</p>}
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rfq-material" className="text-xs font-accent uppercase tracking-wider font-semibold">
                6. Material Specification *
              </Label>
              <Input
                id="rfq-material"
                value={materialSpec}
                onChange={(e) => setMaterialSpec(e.target.value)}
                placeholder="e.g. Al 7075-T6, Inconel 718, FR-4"
                className={inputClass(errors.materialSpec)}
                disabled={isSubmitting}
              />
              {errors.materialSpec && <p className="text-xs text-destructive">{errors.materialSpec}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="rfq-tolerance" className="text-xs font-accent uppercase tracking-wider font-semibold">
                7. Target Tolerance *
              </Label>
              <Input
                id="rfq-tolerance"
                value={targetTolerance}
                onChange={(e) => setTargetTolerance(e.target.value)}
                placeholder="e.g. +/- 0.005mm"
                className={inputClass(errors.targetTolerance)}
                disabled={isSubmitting}
              />
              {errors.targetTolerance && <p className="text-xs text-destructive">{errors.targetTolerance}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-accent uppercase tracking-wider font-semibold">
              8. CAD Package Upload (100MB Vault) *
            </Label>
            <CadDropzone
              inquiryId={inquiryId}
              university={organizationName || 'general'}
              onFilesChange={setCadFiles}
              disabled={isSubmitting || isUserLoading}
            />
            {errors.cadFiles && <p className="text-xs text-destructive">{errors.cadFiles}</p>}
            <p className="text-xs text-muted-foreground font-body">Inquiry ID: <span className="font-mono">{inquiryId}</span></p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rfq-notes" className="text-xs font-accent uppercase tracking-wider font-semibold">
              9. Additional Notes (Optional)
            </Label>
            <Textarea
              id="rfq-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Surface finish, quantity, deadlines, special handling..."
              className={inputClass()}
              disabled={isSubmitting}
              rows={3}
            />
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting || isUserLoading}>
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Transmitting RFQ...
              </>
            ) : (
              'Submit RFQ to Manufacturing Bases'
            )}
          </Button>
        </form>
      </div>
    </section>
  );
}
