"use client";

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getFirebaseApp } from '@/firebase/provider';
import { useUser } from '@/firebase';
import { getAuth } from 'firebase/auth';
import { isSuperAdmin } from '@/lib/roles';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useAutosave } from '@/hooks/use-autosave';
import { getFirestore, doc, serverTimestamp, getDoc, writeBatch } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import { useUniversities } from "@/hooks/use-universities";
import StarryBackground from '@/components/ui/starry-background';
import { Loader2 } from 'lucide-react';
import { STATIC_STEP1_FIELDS } from '@/lib/induction/static-step1-fields';

// Static load induction steps to prevent Suspense unmount state-loss
import Step1Personal from '@/components/induction-stepper/Step1Personal';
import Step2Skills from '@/components/induction-stepper/Step2Skills';
import Step3Portfolio from '@/components/induction-stepper/Step3Portfolio';
import Step4Review from '@/components/induction-stepper/Step4Review';
import { deleteDoc } from '@/lib/client/firestore-wrapper';

// Fire-and-forget webhook dispatch, mirroring src/lib/client/firestore-wrapper.
// The batched submit bypasses the wrapper, so webhooks are dispatched here to
// keep the admin submissions inbox in sync. Never throws.
function fireWebhook(collection: string, docId: string, eventType: string, before: any, after: any) {
  try {
    Promise.resolve(getAuth().currentUser?.getIdToken())
      .then((token) => {
        fetch('/api/webhooks/dispatch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ collection, docId, eventType, before, after }),
        }).catch(() => {});
      })
      .catch(() => {});
  } catch {
    // Webhook dispatch must never affect the submit result.
  }
}

export default function InductionPage() {
  return (
    <Suspense fallback={<div className="flex justify-center items-center min-h-screen">Loading...</div>}>
      <InductionConfigLoader />
    </Suspense>
  );
}

function InductionConfigLoader() {
  const { user, role, isLoading: userLoading } = useUser();
  const router = useRouter();
  const [dynamicFields, setDynamicFields] = useState<any[]>([]);
  const [dynamicSchema, setDynamicSchema] = useState<any>(null);
  const [isLoadingFields, setIsLoadingFields] = useState(true);
  const [existingApplication, setExistingApplication] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!userLoading && !user) {
      router.push('/auth/login');
      return;
    }

    const fetchFieldsAndStatus = async () => {
      if (!user) return;
      const db = getFirestore(getFirebaseApp());
      setLoadError(null);
      try {
        // 1. Read the user doc and the public form config in parallel.
        // The config doc is the only read that gates rendering the form.
        let userSnap;
        let configSnap;
        try {
          [userSnap, configSnap] = await Promise.all([
            getDoc(doc(db, "users", user.uid)),
            getDoc(doc(db, "settings", "induction_form")),
          ]);
        } catch (readErr) {
          // Fail closed with recovery: never render the form when the
          // prior-submission state cannot be verified.
          console.error("Could not load induction status:", readErr);
          setLoadError("We could not load your application status. Check your connection and try again.");
          setIsLoadingFields(false);
          return;
        }

        if (userSnap.exists() && userSnap.data().hasApplied) {
          setExistingApplication({ status: userSnap.data().applicationStatus || 'Received' });
          setIsLoadingFields(false);
          return;
        }

        // Fallback for admins only. Non-admin reads on the applications
        // collection are guaranteed permission-denied, so skip that round trip.
        if (isSuperAdmin(role, user.uid)) {
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
        }

        // 2. Use the already-fetched form configuration
        const docSnap = configSnap;
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

        // Field names reserved for the hardcoded portfolio step. A configured
        // field using one of these is skipped in the loop below so it cannot
        // silently drop the Drive-link validation or required-ness.
        const RESERVED_FIELD_NAMES = ['resumeUpload', 'portfolioLink', 'githubLink'];

        const schemaShape: any = {
          resumeUpload: z.string().url("Must be a valid Google Drive link").includes("drive.google.com", { message: "Must be a Google Drive link" }),
          portfolioLink: z.string().url("Must be a valid URL").optional().or(z.literal('')),
          githubLink: z.string().url("Must be a valid URL").optional().or(z.literal('')),
          // Static Step 1 selects (spec 6.3, low-risk): optional chapter and
          // track preferences. Additive only; the rest of the batch payload
          // and the role/approval path are untouched.
          targetChapter: z.string().optional(),
          preferredTrack: z.string().optional(),
        };

        fields.forEach((f: any) => {
          // Defense in depth: ignore nameless fields and names reserved for
          // the hardcoded portfolio step, so a misconfigured field can never
          // silently overwrite required schemas or brick submission.
          if (!f || typeof f.name !== 'string' || f.name.length === 0) return;
          if (RESERVED_FIELD_NAMES.includes(f.name)) {
            console.warn(`Induction form config: ignoring reserved field name "${f.name}".`);
            return;
          }
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

        // Cross-field rule: when both tag fields exist in the config, require at
        // least one tag across the two so Step 2 cannot be submitted fully empty.
        const hasSkillsField = fields.some((f: any) => f && f.name === 'skills');
        const hasInterestsField = fields.some((f: any) => f && f.name === 'interestAreas');
        let objectSchema: any = z.object(schemaShape);
        if (hasSkillsField && hasInterestsField) {
          objectSchema = objectSchema.superRefine((val: any, ctx: any) => {
            const skills = Array.isArray(val?.skills) ? val.skills : [];
            const interests = Array.isArray(val?.interestAreas) ? val.interestAreas : [];
            if (skills.length === 0 && interests.length === 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['skills'],
                message: 'Add at least one skill or interest area',
              });
            }
          });
        }

        setDynamicSchema(objectSchema);
      } catch (error) {
        console.error("Error fetching form configuration", error);
      } finally {
        setIsLoadingFields(false);
      }
    };

    if (user) {
      fetchFieldsAndStatus();
    }
  }, [user, userLoading, router, role, loadAttempt]);

  if (userLoading || isLoadingFields) {
    return <div role="status" className="flex justify-center items-center min-h-screen">Loading Form Configuration...</div>;
  }

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center min-h-screen gap-4 px-4 text-center">
        <p className="text-muted-foreground">{loadError}</p>
        <Button onClick={() => { setLoadError(null); setIsLoadingFields(true); setLoadAttempt((a) => a + 1); }}>
          Retry
        </Button>
      </div>
    );
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
  // Invalid or out-of-range ?step values fall back to step 1; the correction
  // effect below also rewrites the URL on mount.
  const [currentStep, setCurrentStep] = useState(() => {
    const n = parseInt(searchParams.get('step') || '1', 10);
    return Number.isNaN(n) || n < 1 ? 0 : n - 1;
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { addUniversity } = useUniversities();

  const defaultValues: any = {
    portfolioLink: '',
    githubLink: '',
    resumeUpload: '',
    // Static Step 1 selects default to empty (optional, unanswered).
    targetChapter: '',
    preferredTrack: '',
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
          const draftDoc = draftSnap.exists() ? draftSnap.data() : null;
          const expiresAt = draftDoc?.expires_at;
          const isExpired = expiresAt
            ? (typeof expiresAt.toMillis === 'function' ? expiresAt.toMillis() : Number(expiresAt)) < Date.now()
            : false;
          if (!isExpired && draftDoc?.payload) {
            const draftData = draftDoc.payload;
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
                portfolioLink: currentVals.portfolioLink || '',
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
    if (!user?.uid || !user?.email) {
      toast({
        variant: "destructive",
        title: "Sign-in incomplete",
        description: "We could not verify your account email. Please sign out and sign back in, then try again.",
      });
      return;
    }
    setIsSubmitting(true);
    const db = getFirestore(getFirebaseApp());

    try {
      // Read any existing application first so a resubmission never clobbers
      // an admin-set status. Non-admins cannot read this collection; that just
      // means there is nothing to preserve.
      let preservedStatus = 'pending';
      let appBefore: any = null;
      try {
        const existingSnap = await getDoc(doc(db, 'applications', user.uid));
        if (existingSnap.exists()) {
          appBefore = existingSnap.data();
          if (appBefore.status === 'approved' || appBefore.status === 'rejected') {
            preservedStatus = appBefore.status;
          }
        }
      } catch (readErr) {
        console.warn('Could not read existing application:', readErr);
      }

      const applicationData = {
        uid: user.uid,
        email: user.email,
        ...formData,
        resume_url: formData.resumeUpload || null,
        portfolioLink: formData.portfolioLink || null,
        githubLink: formData.githubLink || null,
        status: preservedStatus,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
        last_saved_at: serverTimestamp(),
      };

      const flagUpdate = {
        hasApplied: true,
        applicationStatus: preservedStatus,
        updatedAt: serverTimestamp(),
      };

      // Single atomic batch: the application and the duplicate-submission flag
      // either both land or neither does. The flag can no longer silently fail
      // while success is shown.
      const batch = writeBatch(db);
      batch.set(doc(db, 'applications', user.uid), applicationData);
      batch.update(doc(db, 'users', user.uid), flagUpdate);
      await batch.commit();

      // Webhook parity with the firestore wrapper (bypassed by the batch):
      // keeps the admin submissions inbox in sync. Fire-and-forget.
      fireWebhook('applications', user.uid, appBefore ? 'update' : 'create', appBefore, applicationData);
      fireWebhook('users', user.uid, 'update', null, { uid: user.uid, ...flagUpdate });

      // If a new university was entered, track it in metadata
      if (formData.university) {
        await addUniversity(formData.university);
      }

      toast({ title: "Application Submitted!", description: "Your induction application has been successfully submitted." });
      router.push('/user/profile');

      // Non-critical post-submit work. Each guarded separately so a failure
      // here can never fake-fail an already successful submission.
      try {
        const { logAuditEntry } = await import('@/lib/audit-logging');
        await logAuditEntry(db, 'application_submitted', user.uid, user.uid, { application_id: user.uid });
      } catch (auditErr) {
        console.warn('Post-submit audit log failed (non-critical):', auditErr);
      }
      try {
        await deleteDoc(doc(db, 'drafts', user.uid));
      } catch (draftErr) {
        console.warn('Post-submit draft cleanup failed (non-critical):', draftErr);
      }
    } catch (error: any) {
      toast({ variant: "destructive", title: "Submission Failed", description: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const onError = (errors: any) => {
    const errorKeys = new Set(Object.keys(errors || {}));
    const failingSteps = steps
      .map((s: any, i: number) => ({ step: s, index: i }))
      .filter(({ step }) => (step.fieldsToValidate || []).some((k: string) => errorKeys.has(k)));
    if (failingSteps.length > 0) {
      const titles = failingSteps.map(({ step }) => step.title).join(', ');
      const first = failingSteps[0];
      const firstField = (first.step.fieldsToValidate || []).find((k: string) => errorKeys.has(k));
      setCurrentStep(first.index);
      updateStepInUrl(first.index);
      window.scrollTo({ top: 0 });
      if (firstField) {
        window.setTimeout(() => methods.setFocus(firstField), 60);
      }
      toast({
        variant: "destructive",
        title: "Validation Error",
        description: `Please fix the highlighted fields in: ${titles}.`,
      });
    } else {
      toast({ variant: "destructive", title: "Validation Error", description: "Please go back and ensure all required fields are filled correctly." });
    }
    console.error("Form Validation Errors:", errors);
  };

  const stepNames: Record<number, string> = {
    0: "Personal Information",
    1: "Skills & Interests",
    2: "Assessments & Links",
  };

  const steps: any[] = [];

  // Sort fields by order globally once
  const sortedFields = [...dynamicFields].sort((a, b) => (a.order || 0) - (b.order || 0));

  // Dynamically determine the max step configured by the admin
  const maxStep = sortedFields.length > 0 ? Math.max(...sortedFields.map(f => f.step || 0)) : 0;

  for (let stepNum = 0; stepNum <= maxStep; stepNum++) {
    const fieldsForStep = sortedFields.filter(f => (f.step || 0) === stepNum);
    if (fieldsForStep.length > 0) {
      // Step 1 (step 0) also carries the two static optional selects
      // (Target Chapter, Preferred Track) appended after the dynamic fields.
      const stepFields = stepNum === 0 ? [...fieldsForStep, ...STATIC_STEP1_FIELDS] : fieldsForStep;
      steps.push({
        id: `step_${stepNum}`,
        title: stepNames[stepNum] || `Step ${stepNum + 1}`,
        component: stepNum === 0 ?
          <Step1Personal fields={stepFields} /> :
          <Step2Skills fields={fieldsForStep} />,
        fieldsToValidate: stepFields.map(f => f.name)
      });
    }
  }

  steps.push({ id: 'portfolio', title: "Portfolio & Resume", component: <Step3Portfolio />, fieldsToValidate: ['resumeUpload', 'portfolioLink', 'githubLink'] });
  steps.push({ id: 'review', title: "Review & Submit", component: <Step4Review fields={[...dynamicFields, ...STATIC_STEP1_FIELDS]} />, fieldsToValidate: [] });

  const updateStepInUrl = (stepIndex: number) => {
    window.history.pushState(null, '', `/induction?step=${stepIndex + 1}`);
  };

  // Guard the render path: an out-of-range index (e.g. ?step=99) can never
  // crash the title lookup below.
  const clampedStep = steps.length > 0 ? Math.min(Math.max(currentStep, 0), steps.length - 1) : 0;

  // Correct an out-of-range or invalid ?step on mount by sending the user to
  // step 1 instead of crashing.
  useEffect(() => {
    if (steps.length === 0) return;
    if (currentStep < 0 || currentStep >= steps.length) {
      setCurrentStep(0);
      window.history.replaceState(null, '', '/induction?step=1');
    }
  }, [steps.length, currentStep]);

  // Keep step state in sync with browser Back/Forward now that in-app
  // navigation pushes history entries.
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const n = parseInt(params.get('step') || '1', 10);
      const idx = Number.isNaN(n) || n < 1 ? 0 : n - 1;
      setCurrentStep(steps.length > 0 ? Math.min(idx, steps.length - 1) : idx);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [steps.length]);

  // Move focus to the step heading on step change so keyboard and screen
  // reader users land on the new step. Skipped on initial mount.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const isFirstStepRender = useRef(true);
  useEffect(() => {
    if (isFirstStepRender.current) {
      isFirstStepRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus({ preventScroll: true });
  }, [currentStep]);

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

  const progress = steps.length > 0 ? ((clampedStep + 1) / steps.length) * 100 : 0;

  return (
    <FormProvider {...methods}>
      <div className="relative min-h-screen flex flex-col items-center justify-center py-8">
        <StarryBackground />
        
        <div className="container relative z-10 px-4 w-full flex justify-center">
          <Card className="w-full max-w-3xl border border-border bg-background/80 backdrop-blur-xl shadow-2xl">
            <CardHeader className="border-b border-white/5 pb-6">
              <CardTitle className="text-3xl font-heading font-bold text-center text-foreground tracking-wide">
                Induction Application
              </CardTitle>
              <Progress value={progress} className="w-full mt-6 h-2" />
            </CardHeader>
            <CardContent className="pt-8">
            <h2
              ref={stepHeadingRef}
              tabIndex={-1}
              aria-live="polite"
              className="mb-6 text-center text-lg font-semibold outline-none"
            >
              Step {clampedStep + 1}: {steps[clampedStep]?.title}
            </h2>
            <form onSubmit={methods.handleSubmit(onSubmit, onError)}>
              {steps.map((step, index) => (
                <div key={step.id} className={clampedStep === index ? 'block' : 'hidden'}>
                  {step.component}
                </div>
              ))}
              <div className="flex justify-between mt-8">
                <Button
                  type="button"
                  onClick={() => {
                    const prevStep = Math.max(clampedStep - 1, 0);
                    setCurrentStep(prevStep);
                    updateStepInUrl(prevStep);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  disabled={clampedStep === 0 || isSubmitting}
                  variant="outline"
                >
                  Previous
                </Button>
                {clampedStep === steps.length - 1 ? (
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
