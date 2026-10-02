'use client';

import React, { useState, useEffect } from 'react';
import { useUser } from '@/firebase';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { 
  CheckCircle2, 
  Shield, 
  Loader2, 
  Sparkles,
  Lock,
  ArrowRight,
  Link as LinkIcon,
  FolderArchive,
  UserCheck,
  LogIn
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface FormData {
  fullName: string;
  university: string;
  email: string;
  phone: string;
  affiliation: string;
  category: string;
  material: string;
  quantity: string;
  deadline: string;
  tolerances: string;
  cadDriveLink: string;
  ndaAgreed: boolean;
}

export default function EngineeringIntakeForm() {
  const { user, isLoading: isUserLoading } = useUser();
  const { toast } = useToast();

  const [formData, setFormData] = useState<FormData>({
    fullName: '',
    university: '',
    email: '',
    phone: '',
    affiliation: '',
    category: '',
    material: '',
    quantity: '',
    deadline: '',
    tolerances: '',
    cadDriveLink: '',
    ndaAgreed: false,
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Automatically prefill user data when authenticated
  useEffect(() => {
    if (user) {
      setFormData((prev) => ({
        ...prev,
        fullName: prev.fullName || user.displayName || '',
        email: prev.email || user.email || '',
      }));
    }
  }, [user]);

  // Handlers
  const handleInputChange = (field: keyof FormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!user) {
      newErrors.auth = 'You must be signed in to submit an engineering package.';
    }
    if (!formData.fullName.trim()) newErrors.fullName = 'Full Name is required.';
    if (!formData.university.trim()) newErrors.university = 'University / Lab / Team name is required.';
    if (!formData.email.trim() || !/^\S+@\S+\.\S+$/.test(formData.email)) {
      newErrors.email = 'Valid institutional email is required.';
    }
    if (!formData.phone.trim()) newErrors.phone = 'WhatsApp / Phone number is required for urgent liaison.';
    if (!formData.affiliation) newErrors.affiliation = 'Please select your SEDS / Chapter affiliation.';
    if (!formData.category) newErrors.category = 'Please select a hardware category.';
    if (!formData.quantity.trim()) newErrors.quantity = 'Required quantity is mandatory.';
    if (!formData.cadDriveLink.trim()) {
      newErrors.cadDriveLink = 'Please provide your Google Drive, OneDrive, GrabCAD, or GitHub CAD repository link.';
    } else if (!formData.cadDriveLink.startsWith('http://') && !formData.cadDriveLink.startsWith('https://')) {
      newErrors.cadDriveLink = 'Please enter a valid link starting with https://';
    }
    if (!formData.ndaAgreed) newErrors.ndaAgreed = 'You must confirm the mutual NDA agreement.';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      toast({
        title: 'Authentication Required',
        description: 'Please sign in to your SEDS account before submitting your CAD package.',
        variant: 'destructive',
      });
      return;
    }

    if (!validateForm()) {
      toast({
        title: 'Missing Required Fields',
        description: 'Please complete all highlighted mandatory fields before transmitting CAD package.',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const cleanLink = formData.cadDriveLink.trim();

      // Transmit intake metadata & trigger automated notifications
      const submitRes = await fetch('/api/sourcing/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          userId: user.uid,
          fileDownloadUrl: cleanLink,
          fileName: 'Cloud CAD Package (Google Drive / Repository)',
          fileSizeBytes: 0,
        }),
      });

      if (!submitRes.ok) {
        const errJson = await submitRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to register sourcing inquiry.');
      }

      setIsSuccess(true);
      toast({
        title: '✓ Engineering Package Transmitted',
        description: 'Your CAD package has been assigned for 48-Hour DFM review by the SJTU liaison team. Confirmation email dispatched.',
      });
    } catch (err: any) {
      console.error(err);
      toast({
        title: 'Transmission Failed',
        description: err.message || 'An error occurred while submitting your package.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section id="intake-form" className="py-16 md:py-24 bg-background border-b border-border/30">
      <div className="container mx-auto px-4 md:px-6 max-w-4xl">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-accent tracking-widest uppercase mb-4 shadow-sm">
            <Lock className="w-3.5 h-3.5 text-primary" />
            <span>Secure Engineering Intake</span>
          </div>
          <h2 className="text-4xl sm:text-6xl font-headline tracking-wide text-foreground uppercase text-glow mb-4">
            Request 48-Hour DFM &amp; Benchmark Quote
          </h2>
          <p className="text-muted-foreground font-body text-base sm:text-lg text-justify max-w-2xl mx-auto">
            Submit your CAD package repository or folder. Our on-ground fellows in Shanghai will review tolerances, toolpaths, and deliver factory-direct pricing within 48 hours.
          </p>
        </div>

        {isSuccess ? (
          <div className="p-8 sm:p-12 rounded-2xl border border-primary/40 bg-card/90 backdrop-blur-md text-center shadow-2xl shadow-primary/10">
            <div className="w-16 h-16 rounded-full bg-primary/15 border border-primary/40 text-primary flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h3 className="text-3xl sm:text-4xl font-headline text-foreground uppercase tracking-wide text-glow mb-3">
              Engineering CAD Package Transmitted!
            </h3>
            <p className="text-muted-foreground max-w-xl mx-auto mb-8 font-body text-sm leading-relaxed text-justify">
              Your inquiry has been assigned to our Shanghai Jiao Tong University engineering liaison team. We will review the 3D model geometry and deliver a comprehensive DFM feedback report + direct factory quote within 48 hours.
            </p>
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent/10 border border-accent/25 text-xs font-accent uppercase tracking-wider text-accent">
              <Shield className="w-4 h-4 text-primary" />
              <span>Mutual NDA IP Protection Active · Instant Email Dispatched</span>
            </div>
            <div className="mt-8">
              <Button
                onClick={() => {
                  setIsSuccess(false);
                  setFormData({
                    fullName: user?.displayName || '',
                    university: '',
                    email: user?.email || '',
                    phone: '',
                    affiliation: '',
                    category: '',
                    material: '',
                    quantity: '',
                    deadline: '',
                    tolerances: '',
                    cadDriveLink: '',
                    ndaAgreed: false,
                  });
                }}
                variant="outline"
                className="border-accent/30 font-accent uppercase tracking-wider text-foreground hover:bg-accent/10 cursor-pointer"
              >
                Submit Another Hardware Package
              </Button>
            </div>
          </div>
        ) : !isUserLoading && !user ? (
          /* Mandatory Sign-In Required Gate */
          <div className="rounded-2xl border border-primary/30 bg-card/90 backdrop-blur-md p-8 sm:p-12 text-center shadow-2xl shadow-primary/10 space-y-6">
            <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 text-primary flex items-center justify-center mx-auto mb-2">
              <Lock className="w-8 h-8" />
            </div>
            <div className="space-y-2 max-w-lg mx-auto">
              <h3 className="text-2xl sm:text-3xl font-headline text-foreground uppercase tracking-wider text-glow">
                Sign In Required for Engineering Intake
              </h3>
              <p className="text-xs sm:text-sm text-muted-foreground font-body leading-relaxed text-justify">
                To guarantee mutual NDA confidentiality, track DFM review statuses, and bind aerospace quality records to your collegiate team, please sign in or register before submitting your CAD package.
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
          <form
            onSubmit={handleSubmit}
            className="rounded-2xl border border-accent/20 bg-card/80 backdrop-blur-md p-6 sm:p-10 shadow-2xl shadow-accent/5 space-y-8"
          >
            {/* Top Security & Authentication Banner */}
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

            {/* Rapid Pilot Packages ($200–$500 Test Orders) */}
            <div className="p-5 sm:p-6 rounded-2xl bg-card/90 border border-emerald-500/30 shadow-xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs sm:text-sm font-accent uppercase tracking-widest text-emerald-400 font-bold">
                    Testing Us First? Rapid $200–$500 Pilot Packages
                  </span>
                </div>
                <span className="text-[11px] font-mono text-muted-foreground bg-background/80 px-2.5 py-1 rounded-md border border-border/50 self-start sm:self-auto">
                  Zero Minimum Commitment · 48h DFM
                </span>
              </div>

              <p className="text-xs text-muted-foreground font-body leading-relaxed">
                Collegiate teams testing our Yangtze precision corridor often start with a small, high-velocity bench prototype to benchmark tolerances before authorizing larger rocket runs:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                <div 
                  onClick={() => {
                    handleInputChange('category', '5-Axis Precision CNC Machining');
                    handleInputChange('material', 'Al 7075-T651 (Hard Anodized Type III)');
                  }}
                  className="p-3.5 rounded-xl bg-background/90 border border-emerald-500/25 hover:border-emerald-500/60 hover:bg-emerald-950/20 transition-all cursor-pointer flex flex-col justify-between group"
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-accent uppercase tracking-wide text-foreground font-bold mb-1.5 group-hover:text-emerald-400 transition-colors">
                      <span className="text-emerald-400">🟢</span>
                      <span>Wedge 1: 5-Axis CNC Motor Mounts &amp; Brackets</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
                      Al 7075-T651 billet machining, lightweight pocketing, hard anodized.
                    </p>
                  </div>
                  <div className="mt-3 text-[10px] font-mono text-emerald-400 font-semibold flex items-center justify-between border-t border-border/40 pt-2">
                    <span>48h DFM</span>
                    <span>7-Day Express Ship</span>
                  </div>
                </div>

                <div 
                  onClick={() => {
                    handleInputChange('category', 'Turnkey Aerospace PCBA (SMT & X-Ray)');
                    handleInputChange('material', 'FR4 High-Tg / ENIG Gold Finish');
                  }}
                  className="p-3.5 rounded-xl bg-background/90 border border-cyan-500/25 hover:border-cyan-500/60 hover:bg-cyan-950/20 transition-all cursor-pointer flex flex-col justify-between group"
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-accent uppercase tracking-wide text-foreground font-bold mb-1.5 group-hover:text-cyan-400 transition-colors">
                      <span className="text-emerald-400">🟢</span>
                      <span>Wedge 2: Avionics Flight Computer Prototypes</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
                      Turnkey 4-to-8 layer SMT PCBA with full BGA X-Ray inspection.
                    </p>
                  </div>
                  <div className="mt-3 text-[10px] font-mono text-cyan-400 font-semibold flex items-center justify-between border-t border-border/40 pt-2">
                    <span>Turnkey PCBA</span>
                    <span>100% X-Ray Verified</span>
                  </div>
                </div>

                <div 
                  onClick={() => {
                    handleInputChange('category', 'Ground Support Equipment (GSE)');
                    handleInputChange('material', 'Structural Steel / 6061-T6 + High-Density Polyethylene');
                  }}
                  className="p-3.5 rounded-xl bg-background/90 border border-purple-500/25 hover:border-purple-500/60 hover:bg-purple-950/20 transition-all cursor-pointer flex flex-col justify-between group"
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-accent uppercase tracking-wide text-foreground font-bold mb-1.5 group-hover:text-purple-400 transition-colors">
                      <span className="text-emerald-400">🟢</span>
                      <span>Wedge 3: Static Test Stand Plates &amp; Foam</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-body leading-relaxed">
                      Static test stand thrust plates &amp; custom CNC Pelican case foam.
                    </p>
                  </div>
                  <div className="mt-3 text-[10px] font-mono text-purple-400 font-semibold flex items-center justify-between border-t border-border/40 pt-2">
                    <span>Heavy GSE</span>
                    <span>Field Transport</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Grid Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {/* 1. Full Name */}
              <div className="space-y-2">
                <Label htmlFor="fullName" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>1. Full Name</span>
                  <span className="text-primary">*</span>
                </Label>
                <Input
                  id="fullName"
                  placeholder="Alex Henderson"
                  value={formData.fullName}
                  onChange={(e) => handleInputChange('fullName', e.target.value)}
                  className={`bg-background/80 border-border text-foreground placeholder:text-muted-foreground font-body text-sm ${
                    errors.fullName ? 'border-destructive focus-visible:ring-destructive' : 'focus-visible:ring-primary'
                  }`}
                />
                {errors.fullName && <p className="text-xs text-destructive font-body">{errors.fullName}</p>}
              </div>

              {/* 2. University / Lab */}
              <div className="space-y-2">
                <Label htmlFor="university" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>2. University / Lab</span>
                  <span className="text-primary">*</span>
                </Label>
                <Input
                  id="university"
                  placeholder="SEDS MIT / Imperial College Rocketry"
                  value={formData.university}
                  onChange={(e) => handleInputChange('university', e.target.value)}
                  className={`bg-background/80 border-border text-foreground placeholder:text-muted-foreground font-body text-sm ${
                    errors.university ? 'border-destructive focus-visible:ring-destructive' : 'focus-visible:ring-primary'
                  }`}
                />
                {errors.university && <p className="text-xs text-destructive font-body">{errors.university}</p>}
              </div>

              {/* 3. Institutional Email */}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>3. Institutional Email</span>
                  <span className="text-primary">*</span>
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="alex@mit.edu"
                  value={formData.email}
                  onChange={(e) => handleInputChange('email', e.target.value)}
                  className={`bg-background/80 border-border text-foreground placeholder:text-muted-foreground font-body text-sm ${
                    errors.email ? 'border-destructive focus-visible:ring-destructive' : 'focus-visible:ring-primary'
                  }`}
                />
                {errors.email && <p className="text-xs text-destructive font-body">{errors.email}</p>}
              </div>

              {/* 4. WhatsApp / Phone */}
              <div className="space-y-2">
                <Label htmlFor="phone" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>4. WhatsApp / Phone</span>
                  <span className="text-primary">*</span>
                </Label>
                <Input
                  id="phone"
                  placeholder="+44 7700 900077"
                  value={formData.phone}
                  onChange={(e) => handleInputChange('phone', e.target.value)}
                  className={`bg-background/80 border-border text-foreground placeholder:text-muted-foreground font-body text-sm ${
                    errors.phone ? 'border-destructive focus-visible:ring-destructive' : 'focus-visible:ring-primary'
                  }`}
                />
                {errors.phone && <p className="text-xs text-destructive font-body">{errors.phone}</p>}
              </div>

              {/* 5. SEDS Affiliation */}
              <div className="space-y-2">
                <Label htmlFor="affiliation" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>5. SEDS / Chapter Affiliation</span>
                  <span className="text-primary">*</span>
                </Label>
                <div className="relative">
                  <select
                    id="affiliation"
                    value={formData.affiliation}
                    onChange={(e) => handleInputChange('affiliation', e.target.value)}
                    className={`w-full h-10 px-3 py-2 rounded-md bg-background/80 border appearance-none text-foreground font-body text-sm focus:outline-none focus:ring-2 focus:ring-primary cursor-pointer ${
                      errors.affiliation ? 'border-destructive' : 'border-border'
                    }`}
                  >
                    <option value="" disabled className="bg-card text-muted-foreground">Select SEDS Chapter / Org</option>
                    <option value="SEDS Pakistan" className="bg-card text-foreground">SEDS Pakistan</option>
                    <option value="SEDS USA" className="bg-card text-foreground">SEDS USA</option>
                    <option value="UKSEDS" className="bg-card text-foreground">UKSEDS (United Kingdom)</option>
                    <option value="SEDS Canada" className="bg-card text-foreground">SEDS Canada</option>
                    <option value="International SEDS (Other)" className="bg-card text-foreground">International SEDS (Other Chapter)</option>
                    <option value="University Research Lab" className="bg-card text-foreground">University Research Lab</option>
                    <option value="Aerospace Startup" className="bg-card text-foreground">Aerospace Startup / Team</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground">
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 20 20">
                      <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                    </svg>
                  </div>
                </div>
                {errors.affiliation && <p className="text-xs text-destructive font-body">{errors.affiliation}</p>}
              </div>

              {/* 6. Hardware Category */}
              <div className="space-y-2">
                <Label htmlFor="category" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>6. Hardware Category</span>
                  <span className="text-primary">*</span>
                </Label>
                <div className="relative">
                  <select
                    id="category"
                    value={formData.category}
                    onChange={(e) => handleInputChange('category', e.target.value)}
                    className={`w-full h-10 px-3 py-2 rounded-md bg-background/80 border appearance-none text-foreground font-body text-sm focus:outline-none focus:ring-2 focus:ring-primary cursor-pointer ${
                      errors.category ? 'border-destructive' : 'border-border'
                    }`}
                  >
                    <option value="" disabled className="bg-card text-muted-foreground">Select Hardware Category</option>
                    <option value="5-Axis Precision CNC Machining" className="bg-card text-foreground">5-Axis Precision CNC Machining</option>
                    <option value="Turnkey Aerospace PCBA (SMT & X-Ray)" className="bg-card text-foreground">Turnkey Aerospace PCBA (SMT &amp; X-Ray)</option>
                    <option value="Composite Tooling & Airframe Molds" className="bg-card text-foreground">Composite Tooling &amp; Airframe Molds</option>
                    <option value="Ground Support Equipment (GSE)" className="bg-card text-foreground">Ground Support Equipment (GSE)</option>
                    <option value="Combined Multi-Disciplinary Package" className="bg-card text-foreground">Combined Multi-Disciplinary Package</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground">
                    <svg className="h-4 w-4 fill-current" viewBox="0 0 20 20">
                      <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                    </svg>
                  </div>
                </div>
                {errors.category && <p className="text-xs text-destructive font-body">{errors.category}</p>}
              </div>

              {/* 7. Material & Finish */}
              <div className="space-y-2">
                <Label htmlFor="material" className="text-foreground text-xs font-accent uppercase tracking-wider font-semibold">
                  7. Material &amp; Surface Finish (Optional)
                </Label>
                <Input
                  id="material"
                  placeholder="Al 7075-T651, Hard Anodize Type III"
                  value={formData.material}
                  onChange={(e) => handleInputChange('material', e.target.value)}
                  className="bg-background/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary font-body text-sm"
                />
              </div>

              {/* 8. Required Quantity */}
              <div className="space-y-2">
                <Label htmlFor="quantity" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1 font-semibold">
                  <span>8. Required Quantity</span>
                  <span className="text-primary">*</span>
                </Label>
                <Input
                  id="quantity"
                  placeholder="2 prototypes + 15 flight units"
                  value={formData.quantity}
                  onChange={(e) => handleInputChange('quantity', e.target.value)}
                  className={`bg-background/80 border-border text-foreground placeholder:text-muted-foreground font-body text-sm ${
                    errors.quantity ? 'border-destructive focus-visible:ring-destructive' : 'focus-visible:ring-primary'
                  }`}
                />
                {errors.quantity && <p className="text-xs text-destructive font-body">{errors.quantity}</p>}
              </div>

              {/* 9. Target Deadline */}
              <div className="space-y-2">
                <Label htmlFor="deadline" className="text-foreground text-xs font-accent uppercase tracking-wider font-semibold">
                  9. Target Launch / Test Deadline (Optional)
                </Label>
                <Input
                  id="deadline"
                  type="date"
                  value={formData.deadline}
                  onChange={(e) => handleInputChange('deadline', e.target.value)}
                  className="bg-background/80 border-border text-foreground focus-visible:ring-primary font-body text-sm"
                />
              </div>

              {/* 10. Critical Tolerances */}
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="tolerances" className="text-foreground text-xs font-accent uppercase tracking-wider font-semibold">
                  10. Critical Tolerances &amp; Engineering Notes (Optional)
                </Label>
                <Textarea
                  id="tolerances"
                  rows={3}
                  placeholder="Hole tolerances (e.g. H7/g6), controlled impedance, thermal relief, conformal coating requirements..."
                  value={formData.tolerances}
                  onChange={(e) => handleInputChange('tolerances', e.target.value)}
                  className="bg-background/80 border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-primary font-body text-xs"
                />
              </div>
            </div>

            {/* 11. Engineering CAD & Drawing Package Repository Link */}
            <div className="space-y-3 p-5 rounded-2xl bg-card/90 border border-primary/30 shadow-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <Label htmlFor="cadDriveLink" className="text-foreground text-xs font-accent uppercase tracking-wider flex items-center gap-1.5 font-semibold">
                  <FolderArchive className="w-4 h-4 text-primary" />
                  <span>11. Engineering CAD Repository (Google Drive / OneDrive / GrabCAD / GitHub)</span>
                  <span className="text-primary">*</span>
                </Label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-accent/15 text-accent border border-accent/25">.STEP</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-accent/15 text-accent border border-accent/25">.PDF</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-accent/15 text-accent border border-accent/25">.ZIP</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-accent/15 text-accent border border-accent/25">.XLSX</span>
                </div>
              </div>

              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-primary">
                  <LinkIcon className="w-4 h-4" />
                </div>
                <Input
                  id="cadDriveLink"
                  placeholder="https://drive.google.com/drive/folders/... or OneDrive / GrabCAD link"
                  value={formData.cadDriveLink}
                  onChange={(e) => handleInputChange('cadDriveLink', e.target.value)}
                  className={`pl-10 bg-background/90 border-border text-foreground placeholder:text-muted-foreground font-body text-sm ${
                    errors.cadDriveLink ? 'border-destructive focus-visible:ring-destructive' : 'focus-visible:ring-primary'
                  }`}
                />
              </div>

              <div className="text-xs text-muted-foreground font-body leading-relaxed flex items-start gap-1.5 pt-1">
                <span className="text-primary font-bold">💡 Tip:</span>
                <span>
                  Upload your 3D models (.STEP / .IGES), 2D technical drawings (.PDF), and BOM (.XLSX) to a Google Drive, OneDrive, GrabCAD, or GitHub folder and paste the share link with &quot;Anyone with link can view&quot; enabled.
                </span>
              </div>

              {errors.cadDriveLink && <p className="text-xs text-destructive font-body">{errors.cadDriveLink}</p>}
            </div>

            {/* 12. Mutual NDA Agreement */}
            <div className="pt-2">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-accent/10 border border-accent/25">
                <Checkbox
                  id="nda"
                  checked={formData.ndaAgreed}
                  onCheckedChange={(checked) => handleInputChange('ndaAgreed', !!checked)}
                  className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                />
                <div className="space-y-2">
                  <Label htmlFor="nda" className="text-sm text-foreground cursor-pointer font-accent uppercase tracking-wider font-semibold">
                    12. Mutual NDA &amp; Intellectual Property Agreement
                  </Label>
                  <p className="text-xs text-muted-foreground font-body leading-relaxed text-justify">
                    By checking this box, you confirm that uploaded designs remain 100% the intellectual property of your university team. SEDS Pakistan and verified manufacturing partners operate under strict confidentiality and non-disclosure obligations.
                  </p>
                  <p className="text-[11px] text-muted-foreground font-body leading-relaxed text-justify pt-1 border-t border-accent/20">
                    <span className="text-primary font-bold">Export Control Classification:</span> All components sourced through the SEDS Sourcing Bridge are strictly classified as commercial academic research prototypes, ground support equipment (GSE), and structural mockups under EAR99 / Civil Dual-Use classifications. We do not manufacture ITAR-restricted or munitions list hardware.
                  </p>
                </div>
              </div>
              {errors.ndaAgreed && <p className="text-xs text-destructive font-body mt-1">{errors.ndaAgreed}</p>}
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              disabled={isSubmitting}
              size="lg"
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-accent tracking-widest uppercase font-semibold py-4 sm:py-5 px-4 h-auto min-h-[52px] text-xs sm:text-sm rounded-xl shadow-xl shadow-primary/30 border border-primary/40 transition-all cursor-pointer flex items-center justify-center gap-2 text-center whitespace-normal leading-snug hover:text-glow pulse-glow"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0 animate-spin" />
                  <span>Transmitting CAD &amp; Initiating DFM Review...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
                  <span>Submit Engineering Intake Package (48-Hour DFM)</span>
                  <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
                </>
              )}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
