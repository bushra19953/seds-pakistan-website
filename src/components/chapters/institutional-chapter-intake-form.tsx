'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useStorage } from '@/firebase/provider';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import {
  Loader2,
  Building2,
  Users,
  FlaskConical,
  ReceiptText,
  Upload,
  CheckCircle2,
  FileText,
  Download,
} from 'lucide-react';
import {
  CHAPTER_OFFICER_ROLES,
  type ChapterOfficer,
  type ChapterOfficerRole,
  type InstitutionalDetails,
  type LabBeachhead,
} from '@/types/chapter';

interface InstitutionalChapterIntakeFormProps {
  user: { uid: string; displayName?: string | null; email?: string | null };
}

interface InvoiceResult {
  applicationId: string;
  invoiceNumber: string;
  invoiceUrl: string;
  total: number;
  currency: string;
}

const emptyOfficers = (): ChapterOfficer[] =>
  CHAPTER_OFFICER_ROLES.map(r => ({ role: r.value, name: '', email: '' }));

const roleLabel = (role: ChapterOfficerRole): string =>
  CHAPTER_OFFICER_ROLES.find(r => r.value === role)?.label || role;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InstitutionalChapterIntakeForm({ user }: InstitutionalChapterIntakeFormProps) {
  const { showErrorToast, showSuccessToast } = useEnhancedToast();
  const storage = useStorage();

  const [step, setStep] = useState(0);

  // Step 1: institutional details
  const [institutional, setInstitutional] = useState<InstitutionalDetails>({
    universityName: '',
    campusCity: '',
    deanOrFocalName: '',
    deanOrFocalEmail: '',
    postalAddress: '',
  });

  // Step 2: 5-officer matrix
  const [officers, setOfficers] = useState<ChapterOfficer[]>(emptyOfficers());

  // Step 3: lab beachhead
  const [hasSociety, setHasSociety] = useState<'yes' | 'no' | ''>('');
  const [societyDetails, setSocietyDetails] = useState('');
  const [labFacilities, setLabFacilities] = useState('');
  const [endorsementUrl, setEndorsementUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Step 4: invoice
  const [isGenerating, setIsGenerating] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceResult | null>(null);

  const setInst = (field: keyof InstitutionalDetails, value: string) =>
    setInstitutional(prev => ({ ...prev, [field]: value }));

  const setOfficer = (index: number, field: 'name' | 'email', value: string) =>
    setOfficers(prev => prev.map((o, i) => (i === index ? { ...o, [field]: value } : o)));

  const validateStep = (s: number): string | null => {
    if (s === 0) {
      if (!institutional.universityName.trim()) return 'University name is required';
      if (!institutional.campusCity.trim()) return 'Campus city is required';
      if (!institutional.deanOrFocalName.trim()) return 'Engineering Dean / ORIC Focal Person name is required';
      if (!institutional.deanOrFocalEmail.trim() || !EMAIL_RE.test(institutional.deanOrFocalEmail.trim()))
        return 'A valid Engineering Dean / ORIC Focal Person email is required';
      if (!institutional.postalAddress.trim()) return 'Official postal address is required';
    }
    if (s === 1) {
      for (const o of officers) {
        if (!o.name.trim()) return `Name is required for ${roleLabel(o.role)}`;
        if (!o.email.trim() || !EMAIL_RE.test(o.email.trim()))
          return `A valid institutional email is required for ${roleLabel(o.role)}`;
      }
    }
    if (s === 2) {
      if (!hasSociety) return 'Please indicate whether a space society already exists on campus';
      if (hasSociety === 'yes' && !societyDetails.trim())
        return 'Please describe the existing space society';
    }
    return null;
  };

  const handleNext = () => {
    const error = validateStep(step);
    if (error) {
      showErrorToast(error);
      return;
    }
    setStep(s => s + 1);
  };

  const handleEndorsementUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(file.type)) {
      showErrorToast('Please upload a PDF, image, or Word document');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showErrorToast('File size must be less than 10MB');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    try {
      const fileName = `${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
      const storageRef = ref(storage, `chapter-applications/${user.uid}/oric-endorsement/${fileName}`);
      const uploadTask = uploadBytesResumable(storageRef, file);
      uploadTask.on(
        'state_changed',
        snapshot => setUploadProgress((snapshot.bytesTransferred / snapshot.totalBytes) * 100),
        () => {
          showErrorToast('Upload failed. Please try again.');
          setUploading(false);
        },
        async () => {
          const url = await getDownloadURL(uploadTask.snapshot.ref);
          setEndorsementUrl(url);
          setUploading(false);
          showSuccessToast('Endorsement letter uploaded');
        }
      );
    } catch {
      showErrorToast('Something went wrong during upload.');
      setUploading(false);
    }
  };

  const handleGenerateInvoice = async () => {
    for (let s = 0; s <= 2; s++) {
      const error = validateStep(s);
      if (error) {
        showErrorToast(error);
        setStep(s);
        return;
      }
    }

    setIsGenerating(true);
    try {
      const beachhead: LabBeachhead = {
        hasExistingSpaceSociety: hasSociety === 'yes',
        existingSocietyDetails: societyDetails.trim() || undefined,
        labFacilities: labFacilities.trim() || undefined,
        oricEndorsementLetterUrl: endorsementUrl || undefined,
      };

      const res = await fetch('/api/v1/chapters/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicantId: user.uid,
          applicantName: user.displayName || '',
          applicantEmail: user.email || '',
          institutional: {
            universityName: institutional.universityName.trim(),
            campusCity: institutional.campusCity.trim(),
            deanOrFocalName: institutional.deanOrFocalName.trim(),
            deanOrFocalEmail: institutional.deanOrFocalEmail.trim(),
            postalAddress: institutional.postalAddress.trim(),
          },
          officers: officers.map(o => ({
            role: o.role,
            name: o.name.trim(),
            email: o.email.trim(),
          })),
          beachhead,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        showErrorToast(data.error || 'Failed to generate invoice');
        return;
      }

      setInvoice({
        applicationId: data.applicationId,
        invoiceNumber: data.invoiceNumber,
        invoiceUrl: data.invoiceUrl,
        total: data.total,
        currency: data.currency,
      });
      showSuccessToast('Official institutional invoice generated');
    } catch (err: any) {
      showErrorToast(err?.message || 'Failed to generate invoice');
    } finally {
      setIsGenerating(false);
    }
  };

  const steps = [
    { label: 'Institutional Details', icon: Building2 },
    { label: '5-Officer Matrix', icon: Users },
    { label: 'Lab & Society', icon: FlaskConical },
    { label: 'AGP Invoice', icon: ReceiptText },
  ];

  // Success state
  if (invoice) {
    return (
      <div className="max-w-3xl mx-auto">
        <Card className="border-green-500/30">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="p-4 bg-green-500/10 rounded-full">
                <CheckCircle2 className="w-12 h-12 text-green-500" />
              </div>
            </div>
            <CardTitle className="text-2xl">Invoice Issued</CardTitle>
            <CardDescription>
              Your institutional chapter application has been recorded. Complete the bank transfer
              or crossed cheque to activate the charter review.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <div className="bg-muted/50 rounded-xl p-6 space-y-2">
              <p className="text-sm text-muted-foreground">Invoice Number</p>
              <p className="text-2xl font-mono font-bold">{invoice.invoiceNumber}</p>
              <p className="text-sm text-muted-foreground pt-2">Total Payable</p>
              <p className="text-xl font-bold">
                {invoice.currency} {invoice.total.toLocaleString('en-PK')}
              </p>
            </div>
            {invoice.invoiceUrl && (
              <Button asChild size="lg" className="w-full sm:w-auto">
                <a href={invoice.invoiceUrl} target="_blank" rel="noopener noreferrer">
                  <Download className="w-4 h-4 mr-2" /> Download Official Invoice (PDF)
                </a>
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Application ID: <span className="font-mono">{invoice.applicationId}</span>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={i}
              onClick={() => {
                if (i < step) setStep(i);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                i === step
                  ? 'bg-primary text-primary-foreground'
                  : i < step
                    ? 'bg-primary/20 text-primary cursor-pointer hover:bg-primary/30'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{s.label}</span>
              <span className="sm:hidden">{i + 1}</span>
            </button>
          );
        })}
      </div>

      {/* Step 0: Institutional Details */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" /> Institutional Details
            </CardTitle>
            <CardDescription>
              Official information about the university chartering the SEDS chapter.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inst-university">University / Institution Name *</Label>
              <Input
                id="inst-university"
                placeholder="e.g. National University of Sciences and Technology"
                value={institutional.universityName}
                onChange={e => setInst('universityName', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inst-city">Campus City *</Label>
              <Input
                id="inst-city"
                placeholder="e.g. Islamabad"
                value={institutional.campusCity}
                onChange={e => setInst('campusCity', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="inst-dean">Engineering Dean / ORIC Focal Person *</Label>
                <Input
                  id="inst-dean"
                  placeholder="Full name"
                  value={institutional.deanOrFocalName}
                  onChange={e => setInst('deanOrFocalName', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inst-dean-email">Official Email *</Label>
                <Input
                  id="inst-dean-email"
                  type="email"
                  placeholder="dean@university.edu.pk"
                  value={institutional.deanOrFocalEmail}
                  onChange={e => setInst('deanOrFocalEmail', e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inst-address">Official Postal Address *</Label>
              <Textarea
                id="inst-address"
                placeholder="Complete postal address for official correspondence and invoicing"
                rows={3}
                value={institutional.postalAddress}
                onChange={e => setInst('postalAddress', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 1: 5-Officer Matrix */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" /> Founding 5-Officer Matrix
            </CardTitle>
            <CardDescription>
              The five founding officers. Use institutional email addresses for each officer.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {officers.map((officer, i) => (
              <div key={officer.role} className="p-4 rounded-lg border border-border/50 bg-muted/30 space-y-3">
                <span className="text-sm font-semibold text-primary">{roleLabel(officer.role)}</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    placeholder="Full Name *"
                    value={officer.name}
                    onChange={e => setOfficer(i, 'name', e.target.value)}
                  />
                  <Input
                    placeholder="Institutional Email *"
                    type="email"
                    value={officer.email}
                    onChange={e => setOfficer(i, 'email', e.target.value)}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Lab & Society Beachhead */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="w-5 h-5" /> Lab & Society Beachhead
            </CardTitle>
            <CardDescription>
              Existing campus space ecosystem and lab facilities the chapter can build on.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Does a space / astronomy / rocketry society already exist on campus? *</Label>
              <Select value={hasSociety} onValueChange={val => setHasSociety(val as 'yes' | 'no')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an option" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes, one exists</SelectItem>
                  <SelectItem value="no">No, this would be the first</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {hasSociety === 'yes' && (
              <div className="space-y-2">
                <Label>Existing Society Details *</Label>
                <Textarea
                  placeholder="Society name, size, activities, faculty patron..."
                  rows={3}
                  value={societyDetails}
                  onChange={e => setSocietyDetails(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Lab & Workshop Facilities Available</Label>
              <Textarea
                placeholder="e.g. Mechanical workshop, electronics lab, 3D printers, wind tunnel access..."
                rows={3}
                value={labFacilities}
                onChange={e => setLabFacilities(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>ORIC Endorsement Letter (optional)</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                  onChange={handleEndorsementUpload}
                  disabled={uploading}
                  className="cursor-pointer"
                />
                {uploading && <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />}
              </div>
              {uploading && (
                <p className="text-xs text-muted-foreground">Uploading... {Math.round(uploadProgress)}%</p>
              )}
              {endorsementUrl && !uploading && (
                <p className="text-xs text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Endorsement letter uploaded
                </p>
              )}
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Upload className="w-3.5 h-3.5" /> PDF, image, or Word document, max 10MB
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: AGP Invoicing */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ReceiptText className="w-5 h-5" /> AGP Invoicing
            </CardTitle>
            <CardDescription>
              Review the institutional intake, then generate the official AGP invoice for
              university bank wire or crossed cheque payment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted/50 rounded-xl p-5 space-y-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide">University</p>
                <p className="font-semibold">{institutional.universityName || '-'}</p>
                <p className="text-muted-foreground">{institutional.campusCity || '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Focal Person</p>
                <p className="font-semibold">{institutional.deanOrFocalName || '-'}</p>
                <p className="text-muted-foreground">{institutional.deanOrFocalEmail || '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Founding Officers</p>
                <ul className="space-y-1 mt-1">
                  {officers.map(o => (
                    <li key={o.role} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{roleLabel(o.role)}</span>
                      <span className="font-medium text-right">{o.name || '-'}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide">Campus Society</p>
                <p className="font-medium">
                  {hasSociety === 'yes' ? 'Existing society on campus' : 'First space society on campus'}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-primary/5 border border-primary/20 rounded-lg p-3">
              <FileText className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
              <p>
                Generating the invoice records your application with status &quot;invoice_issued&quot;.
                No card payment is taken here; the university finance office pays via bank wire
                or crossed cheque against the issued invoice.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={step === 0}>
          Back
        </Button>
        {step < 3 ? (
          <Button onClick={handleNext}>Continue</Button>
        ) : (
          <Button onClick={handleGenerateInvoice} disabled={isGenerating} className="min-w-[260px]">
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating Invoice...
              </>
            ) : (
              'Generate Official Institutional Invoice'
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
