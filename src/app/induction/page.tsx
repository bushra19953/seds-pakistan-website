"use client";

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getFirebaseApp } from '@/firebase/provider';
import { useUser } from '@/firebase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import AuthForm from '@/components/auth/auth-form';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useAutosave } from '@/hooks/use-autosave';
import { getFirestore, doc, serverTimestamp, getDoc } from 'firebase/firestore';
;
import { logAuditEntry } from '@/lib/audit-logging';
import { useToast } from '@/hooks/use-toast';
import { useUniversities } from "@/hooks/use-universities";
import StarryBackground from '@/components/ui/starry-background';
import { Loader2 } from 'lucide-react';

// Static load induction steps to prevent Suspense unmount state-loss
import Step1Personal from '@/components/induction-stepper/Step1Personal';
import Step2Skills from '@/components/induction-stepper/Step2Skills';
import Step3Portfolio from '@/components/induction-stepper/Step3Portfolio';
import Step4Review from '@/components/induction-stepper/Step4Review';
import { setDoc, deleteDoc } from '@/lib/client/firestore-wrapper';

export default function InductionPage() {
  return (
    <Suspense fallback={<div className="flex justify-center items-center min-h-screen">Loading...</div>}>
      <InductionConfigLoader />
    </Suspense>
  );
}

function InductionConfigLoader() {
  const { user, isLoading: userLoading } = useUser();
  const router = useRouter();
  const [dynamicFields, setDynamicFields] = useState<any[]>([]);
  const [dynamicSchema, setDynamicSchema] = useState<any>(null);
  const [isLoadingFields, setIsLoadingFields] = useState(true);
  const [existingApplication, setExistingApplication] = useState<any>(null);

  useEffect(() => {
    if (!userLoading && !user) {
      router.push('/auth/login');
      return;
    }

    const fetchFieldsAndStatus = async () => {
      if (!user) return;
      const db = getFirestore(getFirebaseApp());
      try {
        // 1. Check if application already exists
        try {
          const appSnap = await getDoc(doc(db, "applications", user.uid));
          if (appSnap.exists()) {
            setExistingApplication(appSnap.data());
            setIsLoadingFields(false);
            return; // Stop fetching fields, we don't need them
          }
        } catch (appErr) {
          console.warn("Could not check for existing application:", appErr);
        }

        // 2. Fetch dynamic form fields
        const docSnap = await getDoc(doc(db, "settings", "induction_form"));
        let fields = [];
        if (docSnap.exists() && docSnap.data().fields) {
          fields = docSnap.data().fields;
        } else {
          // Fallback static fields if admin hasn't configured yet
          fields = [
            { id: "fullName", name: "fullName", label: "Full Name", type: "text", required: true, step: 0 },
            { id: "university", name: "university", label: "University", type: "text", required: true, step: 0 },
            { id: "department", name: "department", label: "Department", type: "text", required: true, step: 0 },
            { id: "studyYear", name: "studyYear", label: "Study Year", type: "text", required: true, step: 0 },
            { id: "skills", name: "skills", label: "Skills (comma-separated)", type: "text", required: false, step: 1 },
            { id: "interestAreas", name: "interestAreas", label: "Interest Areas (comma-separated)", type: "text", required: false, step: 1 },
            { id: "availability", name: "availability", label: "Availability", type: "text", required: false, step: 1 },
          ];
        }
        setDynamicFields(fields);

        const schemaShape: any = {
          resumeUpload: z.string().url("Must be a valid Google Drive link").includes("drive.google.com", { message: "Must be a Google Drive link" }),
          portfolioLink: z.string().url("Must be a valid URL").optional().or(z.literal('')),
          githubLink: z.string().url("Must be a valid URL").optional().or(z.literal('')),
        };

        fields.forEach((f: any) => {
          if (f.name === 'skills' || f.name === 'interestAreas') {
            schemaShape[f.name] = z.union([z.string(), z.array(z.string()), z.undefined(), z.null()])
              .transform((val: any) => {
                if (!val) return [];
                return typeof val === 'string' ? val.split(',').map((s: string) => s.trim()).filter(Boolean) : val;
              })
              .pipe(f.required ? z.array(z.string()).min(1, `${f.label} is required`) : z.array(z.string()));
          } else {
            const baseSchema = z.string();
            let fieldSchema: z.ZodTypeAny;
            if (f.required) fieldSchema = baseSchema.min(1, `${f.label} is required`);
            else fieldSchema = baseSchema.optional();
            schemaShape[f.name] = fieldSchema;
          }
        });

        setDynamicSchema(z.object(schemaShape));
      } catch (error) {
        console.error("Error fetching form configuration", error);
      } finally {
        setIsLoadingFields(false);
      }
    };

    if (user) {
      fetchFieldsAndStatus();
    }
  }, [user, userLoading, router]);

  if (userLoading || isLoadingFields) {
    return <div className="flex justify-center items-center min-h-screen">Loading Form Configuration...</div>;
  }

  if (!user) return null; // Handled by useEffect redirect

  if (existingApplication) {
    return (
      <div className="container mx-auto min-h-screen flex flex-col items-center justify-center px-4 py-8 bg-gradient-to-br from-gray-900 to-black">
        <Card className="w-full max-w-md mx-auto text-center border-primary/20">
          <CardHeader>
            <CardTitle className="text-2xl font-bold">Application Received</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              You have already submitted an application. Check your profile for updates.
            </p>
            <div className="p-4 bg-primary/10 rounded-lg inline-block w-full">
              <p className="font-semibold text-primary uppercase tracking-wider">{existingApplication.status || 'Received'}</p>
            </div>
            <Button className="w-full mt-4" onClick={() => router.push('/user/profile')}>
              Go to Profile
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!dynamicSchema) return <div className="flex justify-center items-center min-h-screen">Error loading schema</div>;

  return <InductionContentForm user={user} dynamicFields={dynamicFields} schema={dynamicSchema} />;
}

function InductionContentForm({ user, dynamicFields, schema }: { user: any, dynamicFields: any[], schema: any }) {
  const router = useRouter();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const initialStep = Math.max(0, parseInt(searchParams.get('step') || '1') - 1);
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { addUniversity } = useUniversities();

  const defaultValues: any = {
    portfolioLink: '',
    githubLink: '',
    resumeUpload: '',
  };
  dynamicFields.forEach(f => {
    defaultValues[f.name] = (f.name === 'skills' || f.name === 'interestAreas') ? [] : '';
  });

  const methods = useForm<any>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  const { watch, getValues, reset } = methods;
  const formState = watch();

  // Load draft
  useEffect(() => {
    if (user) {
      const db = getFirestore(getFirebaseApp());
      const draftRef = doc(db, 'drafts', user.uid);
      const fetchDraft = async () => {
        try {
          const draftSnap = await getDoc(draftRef);
          if (draftSnap.exists() && draftSnap.data()?.payload) {
            const draftData = draftSnap.data()!.payload;
            const sanitizedPayload: any = { ...draftData };
            reset(sanitizedPayload);
          } else {
            // Auto-fill from user profile if no draft exists
            const userDoc = await getDoc(doc(db, 'users', user.uid));
            if (userDoc.exists()) {
              const profile = userDoc.data();
              const currentVals = getValues();
              const autofill: any = {
                fullName: profile.displayName || user.displayName || currentVals.fullName || '',
                university: profile.university || currentVals.university || '',
                department: profile.fieldOfStudy || currentVals.department || '',
                githubLink: profile.githubUrl || currentVals.githubLink || '',
                portfolioLink: profile.linkedinUrl || currentVals.portfolioLink || '',
              };
              reset({ ...currentVals, ...autofill });
            }
          }
        } catch (error) {
          console.error("Error loading draft:", error);
        }
      };
      fetchDraft();
    }
  }, [user, reset]);

  // Autosave
  useAutosave(formState, user?.uid);

  const onSubmit = async (formData: any) => {
    if (!user?.uid || !user?.email) return;
    setIsSubmitting(true);
    const db = getFirestore(getFirebaseApp());

    try {
      const applicationData = {
        uid: user.uid,
        email: user.email,
        ...formData,
        resume_url: formData.resumeUpload || null,
        portfolioLink: formData.portfolioLink || null,
        githubLink: formData.githubLink || null,
        status: 'pending',
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
        last_saved_at: serverTimestamp(),
      };

      await setDoc(doc(db, 'applications', user.uid), applicationData);

      // If a new university was entered, track it in metadata
      if (formData.university) {
        await addUniversity(formData.university);
      }

      await logAuditEntry(db, 'application_submitted', user.uid, user.uid, { application_id: user.uid });
      await deleteDoc(doc(db, 'drafts', user.uid));

      toast({ title: "Application Submitted!", description: "Your induction application has been successfully submitted." });
      router.push('/user/profile');
    } catch (error: any) {
      toast({ variant: "destructive", title: "Submission Failed", description: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const onError = (errors: any) => {
    toast({ variant: "destructive", title: "Validation Error", description: "Please go back and ensure all required fields are filled correctly." });
    console.error("Form Validation Errors:", errors);
  };

  const stepNames: Record<number, string> = {
    0: "Personal Information",
    1: "Skills & Interests",
    2: "Assessments & Links",
    3: "Technical Questions",
    4: "Additional Info"
  };

  const steps: any[] = [];

  // Sort fields by order globally once
  const sortedFields = [...dynamicFields].sort((a, b) => (a.order || 0) - (b.order || 0));

  // Dynamically determine the max step configured by the admin
  const maxStep = sortedFields.length > 0 ? Math.max(...sortedFields.map(f => f.step || 0)) : 0;

  for (let stepNum = 0; stepNum <= maxStep; stepNum++) {
    const fieldsForStep = sortedFields.filter(f => (f.step || 0) === stepNum);
    if (fieldsForStep.length > 0) {
      steps.push({
        id: `step_${stepNum}`,
        title: stepNames[stepNum] || `Step ${stepNum + 1}`,
        component: stepNum === 0 ?
          <Step1Personal fields={fieldsForStep} /> :
          <Step2Skills fields={fieldsForStep} />,
        fieldsToValidate: fieldsForStep.map(f => f.name)
      });
    }
  }

  steps.push({ id: 'portfolio', title: "Portfolio & Resume", component: <Step3Portfolio />, fieldsToValidate: ['resumeUpload', 'portfolioLink', 'githubLink'] });
  steps.push({ id: 'review', title: "Review & Submit", component: <Step4Review fields={dynamicFields} />, fieldsToValidate: [] });

  const updateStepInUrl = (stepIndex: number) => {
    window.history.replaceState(null, '', `/induction?step=${stepIndex + 1}`);
  };

  const handleNextStep = async () => {
    // Rely on the step object itself instead of hardcoded numbers, because step index might shift
    const fieldsToValidate = steps[currentStep]?.fieldsToValidate || [];

    const isValid = await methods.trigger(fieldsToValidate);

    if (isValid) {
      const nextStep = Math.min(currentStep + 1, steps.length - 1);
      setCurrentStep(nextStep);
      updateStepInUrl(nextStep);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      toast({ variant: "destructive", title: "Validation Error", description: "Please fill out all required fields correctly." });
    }
  };

  const progress = ((currentStep + 1) / steps.length) * 100;

  return (
    <FormProvider {...methods}>
      <div className="relative min-h-screen flex flex-col items-center justify-center py-8">
        <StarryBackground />
        
        <div className="container relative z-10 px-4 w-full flex justify-center">
          <Card className="w-full max-w-3xl border border-white/10 bg-black/60 backdrop-blur-xl shadow-2xl">
            <CardHeader className="border-b border-white/5 pb-6">
              <CardTitle className="text-3xl font-heading font-bold text-center text-white tracking-wide">
                Induction Application
              </CardTitle>
              <Progress value={progress} className="w-full mt-6 h-2" />
            </CardHeader>
            <CardContent className="pt-8">
            <div className="mb-6 text-center text-lg font-semibold">
              Step {currentStep + 1}: {steps[currentStep].title}
            </div>
            <form onSubmit={methods.handleSubmit(onSubmit, onError)}>
              {steps.map((step, index) => (
                <div key={step.id} className={currentStep === index ? 'block' : 'hidden'}>
                  {step.component}
                </div>
              ))}
              <div className="flex justify-between mt-8">
                <Button
                  type="button"
                  onClick={() => {
                    const prevStep = Math.max(currentStep - 1, 0);
                    setCurrentStep(prevStep);
                    updateStepInUrl(prevStep);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  disabled={currentStep === 0 || isSubmitting}
                  variant="outline"
                >
                  Previous
                </Button>
                {currentStep === steps.length - 1 ? (
                  <Button type="submit" disabled={!user || isSubmitting} className="min-w-[150px]">
                    {isSubmitting ? (
                      <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin"/> Executing...</span>
                    ) : 'Submit Application'}
                  </Button>
                ) : (
                  <Button type="button" onClick={handleNextStep}>Next Step</Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
        </div>
      </div>
    </FormProvider>
  );
}
