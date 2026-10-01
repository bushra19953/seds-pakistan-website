'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { Loader2, Plus, Trash2, Users, GraduationCap, Building2, FileText } from 'lucide-react';
import type { TeamMember, FacultyAdvisor, CreateChapterApplicationInput } from '@/types/chapter-application';

interface ChapterApplicationFormProps {
  user: { uid: string; displayName?: string | null; email?: string | null };
  userPhone?: string;
  onSubmit: (data: CreateChapterApplicationInput) => Promise<void>;
  isSubmitting: boolean;
}

const TEAM_ROLES = [
  { value: 'president', label: 'Chapter President' },
  { value: 'vice_president', label: 'Vice President' },
  { value: 'secretary', label: 'Secretary' },
  { value: 'treasurer', label: 'Treasurer' },
  { value: 'member', label: 'Core Member' },
];

const ADVISOR_DESIGNATIONS = [
  'Professor',
  'Associate Professor',
  'Assistant Professor',
  'Lecturer',
  'Senior Lecturer',
  'Department Head',
  'Dean',
];

const emptyMember = (): TeamMember => ({ name: '', email: '', role: 'member', department: '' });
const emptyAdvisor = (): FacultyAdvisor => ({ name: '', email: '', department: '', designation: '' });

export function ChapterApplicationForm({ user, userPhone, onSubmit, isSubmitting }: ChapterApplicationFormProps) {
  const { showErrorToast } = useEnhancedToast();

  // Chapter details
  const [universityName, setUniversityName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('Pakistan');
  const [proposedChapterName, setProposedChapterName] = useState('');

  // Team members (start with 5 empty slots)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([
    { name: user.displayName || '', email: user.email || '', role: 'president', department: '' },
    emptyMember(),
    emptyMember(),
    emptyMember(),
    emptyMember(),
  ]);

  // Faculty advisor
  const [advisor, setAdvisor] = useState<FacultyAdvisor>(emptyAdvisor());

  // Additional
  const [motivation, setMotivation] = useState('');
  const [existingClubs, setExistingClubs] = useState('');
  const [estimatedMemberCount, setEstimatedMemberCount] = useState('20');
  const [socialMediaLinks, setSocialMediaLinks] = useState('');
  const [applicantPhone, setApplicantPhone] = useState(userPhone || '');

  // Current step
  const [step, setStep] = useState(0);

  const updateMember = (index: number, field: keyof TeamMember, value: string) => {
    setTeamMembers(prev => prev.map((m, i) => i === index ? { ...m, [field]: value } : m));
  };

  const addMember = () => setTeamMembers(prev => [...prev, emptyMember()]);

  const removeMember = (index: number) => {
    if (teamMembers.length <= 5) {
      showErrorToast('Minimum 5 team members required');
      return;
    }
    setTeamMembers(prev => prev.filter((_, i) => i !== index));
  };

  const validateStep = (s: number): string | null => {
    if (s === 0) {
      if (!universityName.trim()) return 'University name is required';
      if (!city.trim()) return 'City is required';
      if (!country.trim()) return 'Country is required';
      if (!proposedChapterName.trim()) return 'Proposed chapter name is required';
      if (!applicantPhone.trim()) return 'Phone number is required';
    }
    if (s === 1) {
      const filled = teamMembers.filter(m => m.name.trim() && m.email.trim());
      if (filled.length < 5) return 'At least 5 team members with name and email are required';
      for (const m of filled) {
        if (!m.email.includes('@')) return `Invalid email for ${m.name}`;
        if (!m.department.trim()) return `Department is required for ${m.name}`;
      }
    }
    if (s === 2) {
      if (!advisor.name.trim()) return 'Faculty advisor name is required';
      if (!advisor.email.trim() || !advisor.email.includes('@')) return 'Valid faculty advisor email is required';
      if (!advisor.department.trim()) return 'Faculty advisor department is required';
      if (!advisor.designation) return 'Faculty advisor designation is required';
    }
    if (s === 3) {
      if (!motivation.trim() || motivation.trim().length < 50) return 'Please write at least 50 characters about your motivation';
    }
    return null;
  };

  const handleNext = () => {
    const error = validateStep(step);
    if (error) { showErrorToast(error); return; }
    setStep(s => s + 1);
  };

  const handleSubmit = async () => {
    // Final validation
    for (let s = 0; s <= 3; s++) {
      const error = validateStep(s);
      if (error) { showErrorToast(error); setStep(s); return; }
    }

    const filledMembers = teamMembers.filter(m => m.name.trim() && m.email.trim());

    await onSubmit({
      applicantId: user.uid,
      applicantName: user.displayName || filledMembers[0]?.name || '',
      applicantEmail: user.email || '',
      applicantPhone,
      universityName: universityName.trim(),
      city: city.trim(),
      country: country.trim(),
      proposedChapterName: proposedChapterName.trim(),
      teamMembers: filledMembers,
      facultyAdvisor: advisor,
      motivation: motivation.trim(),
      existingClubs: existingClubs.trim(),
      estimatedMemberCount: parseInt(estimatedMemberCount) || 20,
      socialMediaLinks: socialMediaLinks.trim() || undefined,
    });
  };

  const steps = [
    { label: 'Chapter Details', icon: Building2 },
    { label: 'Team Members', icon: Users },
    { label: 'Faculty Advisor', icon: GraduationCap },
    { label: 'Additional Info', icon: FileText },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={i}
              onClick={() => { if (i < step) setStep(i); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                i === step ? 'bg-primary text-primary-foreground' :
                i < step ? 'bg-primary/20 text-primary cursor-pointer hover:bg-primary/30' :
                'bg-muted text-muted-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{s.label}</span>
              <span className="sm:hidden">{i + 1}</span>
            </button>
          );
        })}
      </div>

      {/* Step 0: Chapter Details */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Building2 className="w-5 h-5" /> Chapter Details</CardTitle>
            <CardDescription>Tell us about the university and the chapter you want to establish.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="universityName">University / Institution Name *</Label>
              <Input id="universityName" placeholder="e.g. NUST, FAST, LUMS" value={universityName} onChange={e => setUniversityName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proposedName">Proposed Chapter Name *</Label>
              <Input id="proposedName" placeholder="e.g. SEDS NUST" value={proposedChapterName} onChange={e => setProposedChapterName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">City *</Label>
                <Input id="city" placeholder="e.g. Islamabad" value={city} onChange={e => setCity(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country *</Label>
                <Input id="country" placeholder="e.g. Pakistan" value={country} onChange={e => setCountry(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Your Phone / WhatsApp Number *</Label>
              <Input id="phone" type="tel" placeholder="+92 300 1234567" value={applicantPhone} onChange={e => setApplicantPhone(e.target.value)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 1: Team Members */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Users className="w-5 h-5" /> Founding Team Members</CardTitle>
            <CardDescription>List at least 5 founding members. The first member is typically the chapter president.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {teamMembers.map((member, i) => (
              <div key={i} className="p-4 rounded-lg border border-border/50 bg-muted/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">Member {i + 1}</span>
                  {teamMembers.length > 5 && (
                    <Button variant="ghost" size="sm" onClick={() => removeMember(i)} className="h-7 w-7 p-0 text-destructive hover:text-destructive">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input placeholder="Full Name *" value={member.name} onChange={e => updateMember(i, 'name', e.target.value)} />
                  <Input placeholder="Email *" type="email" value={member.email} onChange={e => updateMember(i, 'email', e.target.value)} />
                  <Input placeholder="Department *" value={member.department} onChange={e => updateMember(i, 'department', e.target.value)} />
                  <Select value={member.role} onValueChange={val => updateMember(i, 'role', val)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TEAM_ROLES.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addMember} className="w-full">
              <Plus className="w-4 h-4 mr-2" /> Add Another Member
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Faculty Advisor */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><GraduationCap className="w-5 h-5" /> Faculty Advisor</CardTitle>
            <CardDescription>A faculty member who will serve as the chapter&apos;s official advisor.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Full Name *</Label>
                <Input placeholder="Dr. / Prof. Name" value={advisor.name} onChange={e => setAdvisor(a => ({ ...a, name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Email *</Label>
                <Input type="email" placeholder="advisor@university.edu" value={advisor.email} onChange={e => setAdvisor(a => ({ ...a, email: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Department *</Label>
                <Input placeholder="e.g. Aerospace Engineering" value={advisor.department} onChange={e => setAdvisor(a => ({ ...a, department: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Designation *</Label>
                <Select value={advisor.designation} onValueChange={val => setAdvisor(a => ({ ...a, designation: val }))}>
                  <SelectTrigger><SelectValue placeholder="Select designation" /></SelectTrigger>
                  <SelectContent>
                    {ADVISOR_DESIGNATIONS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Additional Info */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="w-5 h-5" /> Additional Information</CardTitle>
            <CardDescription>Help us understand your vision and campus context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Why do you want to start a SEDS chapter? *</Label>
              <Textarea
                placeholder="Describe your motivation, goals, and how you plan to grow the chapter... (minimum 50 characters)"
                rows={4}
                value={motivation}
                onChange={e => setMotivation(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{motivation.length}/50 minimum characters</p>
            </div>
            <div className="space-y-2">
              <Label>Existing space/science clubs at your university</Label>
              <Input placeholder="List any related clubs, or 'None'" value={existingClubs} onChange={e => setExistingClubs(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Estimated initial member count</Label>
              <Input type="number" min={5} max={500} value={estimatedMemberCount} onChange={e => setEstimatedMemberCount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Social media links (optional)</Label>
              <Input placeholder="Instagram, LinkedIn, etc." value={socialMediaLinks} onChange={e => setSocialMediaLinks(e.target.value)} />
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
          <Button onClick={handleNext}>
            Continue
          </Button>
        ) : (
          <Button onClick={handleSubmit} disabled={isSubmitting} className="min-w-[200px]">
            {isSubmitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting...</> : 'Submit & Proceed to Payment'}
          </Button>
        )}
      </div>
    </div>
  );
}
