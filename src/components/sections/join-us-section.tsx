"use client";

import { useState } from "react";
import { buildNameSearchKeywords } from '@/lib/name-search-keywords';
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, UserPlus, PartyPopper } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as z from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { getAuth, signInWithCustomToken, updateProfile } from "firebase/auth";
import { doc, getFirestore, serverTimestamp, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
;
import { errorEmitter } from "@/firebase/error-emitter";
import { FirestorePermissionError } from "@/firebase/errors";
import { setDoc } from '@/lib/client/firestore-wrapper';
import { saveOwnContact } from '@/lib/client/user-contact';
import { IntakeCloseLine } from '@/components/sections/intake-close-line';
import { getSignupErrorMessage } from '@/lib/signup-errors';

const signupSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters." }),
  email: z.string().email({ message: "Please enter a valid email." }),
  password: z.string().min(6, { message: "Password must be at least 6 characters." }),
  university: z.string().min(3, { message: "University is required." }),
  fieldOfStudy: z.string().min(2, { message: "Field of study is required." }),
});

type SignupInput = z.infer<typeof signupSchema>;

export default function JoinUsSection() {
  const { toast } = useToast();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [hasConsented, setHasConsented] = useState(false);
  const auth = getAuth();

  const { register, handleSubmit, formState: { errors } } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
  });

  const onSubmit = async (data: SignupInput) => {
    setIsSubmitting(true);
    const auth = getAuth();

    try {
      // Account creation runs through the server endpoint so it is
      // rate-limited per IP and per email (audit item 5); a direct
      // client-side createUserWithEmailAndPassword call cannot be
      // limited by app code. The endpoint creates the account with
      // the Admin SDK and returns a custom token to sign in with.
      // There is deliberately no fallback to direct creation: a
      // fallback would be an unlimited bypass of the limiter.
      const signupRes = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name, email: data.email, password: data.password }),
      });
      const signupPayload: any = await signupRes.json().catch(() => ({}));
      if (!signupRes.ok || typeof signupPayload?.customToken !== 'string') {
        throw {
          code: typeof signupPayload?.code === 'string' ? signupPayload.code : 'signup/generic',
        };
      }
      const userCredential = await signInWithCustomToken(auth, signupPayload.customToken);
      const user = userCredential.user;

      await updateProfile(user, { displayName: data.name });

      const firestore = getFirestore();
      let termsVersion = '1.0';
      try {
        const termsRef = collection(firestore, 'legalDocuments');
        const termsQuery = query(termsRef, orderBy('version', 'desc'), limit(1));
        const snapshot = await getDocs(termsQuery);
        if (!snapshot.empty) {
          const latestTerms = snapshot.docs[0].data() as any;
          if (typeof latestTerms.version === 'string') termsVersion = latestTerms.version;
        }
      } catch (_) { }
      const userDocRef = doc(firestore, 'users', user.uid);
      const userProfileData = {
        uid: user.uid,
        displayName: data.name,
        photoURL: user.photoURL,
        university: data.university,
        fieldOfStudy: data.fieldOfStudy,
        role: 'member_basic', // default role: every new signup starts as a Basic Member until admitted and promoted, unless an invite assigns otherwise
        chapterId: 'seds-ist-chapter', // default chapter until chapter selection is added to signup
        // Add default points and other required fields to ensure leaderboard compatibility
        points: 0,
        upvotes: 0,
        downvotes: 0,
        tasksAssignedCount: 0,
        tasksCompletedOnTimeCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        agreedToTermsVersion: termsVersion,
        termsAgreementTimestamp: serverTimestamp(),
      };

      await setDoc(userDocRef, userProfileData, { merge: true }).catch((serverError: any) => {
        const permissionError = new FirestorePermissionError({
          path: userDocRef.path,
          operation: 'create',
          requestResourceData: userProfileData,
        });
        errorEmitter.emit('permission-error', permissionError);
      });

      // Contact fields live in the gated users/{uid}/private/contact
      // doc, not on the public user doc.
      if (user.email) {
        await saveOwnContact(firestore, user.uid, { email: user.email });
      }

      // Name-search keywords index (directory option (c)): separate
      // best-effort merge write - the user-create rules allow-list
      // does not carry this field, so it never rides the create
      // payload above. Owner updates have no such restriction.
      await setDoc(userDocRef, { nameSearchKeywords: buildNameSearchKeywords(data.name) }, { merge: true }).catch(() => {});

      setSuccess(true);
      toast({
        title: "Account created",
        description: "Welcome to SEDS Pakistan. Your account is ready.",
      });

      setTimeout(() => router.push('/profile'), 3000);
    } catch (error: any) {
      // Never surface the raw provider message: auth/email-already-in-use
      // would disclose whether an email is registered (audit item 20).
      // getSignupErrorMessage maps every account-state error to one
      // generic message and keeps only input/connection wording.
      toast({
        variant: "destructive",
        title: "Something went wrong",
        description: getSignupErrorMessage(error),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section
      id="join"
      className="py-20 md:py-32 bg-transparent"
      aria-labelledby="join-heading"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="max-w-2xl mx-auto bounce-in">
          {/* 3-Stage Competition Pipeline */}
          <div className="mb-8 rounded-lg border border-primary/20 bg-primary/5 p-6">
            <h3 className="text-lg font-semibold text-center mb-4">3-Stage National Competition Pipeline</h3>
            <div className="space-y-3 text-sm">
              <div className="flex gap-3">
                <span className="font-bold text-primary shrink-0">Stage 1</span>
                <span className="text-muted-foreground">Late-Nov 2026: SEDS Lunar Micro-Rover and ERC Digital-Twin Challenge</span>
              </div>
              <div className="flex gap-3">
                <span className="font-bold text-primary shrink-0">Stage 2</span>
                <span className="text-muted-foreground">Late-Dec 2026: Room 131 Inert Avionics and Ejection Olympics</span>
              </div>
              <div className="flex gap-3">
                <span className="font-bold text-primary shrink-0">Stage 3</span>
                <span className="text-muted-foreground">Jan 2027: SEDS x APRO National Rocketry and CanSat Championship</span>
              </div>
            </div>
            <p className="text-xs text-center text-muted-foreground mt-4">
              Headquartered at Room 131, Business Incubation Center (BIC), Institute of Space Technology (IST), Islamabad
            </p>
          </div>
          {success ? (
            <Card
              className="border-primary/20 shadow-xl shadow-primary/5 text-center p-8"
              aria-live="polite"
            >
              <PartyPopper className="h-16 w-16 mx-auto text-primary mb-4" aria-hidden="true" />
              <CardTitle className="text-3xl text-foreground">Welcome to SEDS!</CardTitle>
              <CardDescription className="font-body text-lg text-muted-foreground mt-2">
                Your account is ready. Taking you to your profile now.
              </CardDescription>
            </Card>
          ) : (
            <Card
              className="border-primary/20 shadow-xl shadow-primary/5 bg-card/80 backdrop-blur-sm"
              aria-labelledby="join-heading"
            >
              <CardHeader className="text-center">
                <CardTitle
                  id="join-heading"
                  className="text-4xl md:text-5xl text-foreground"
                >
                  Join The Mission
                </CardTitle>
                <CardDescription className="font-body text-lg text-muted-foreground">
                  Start your induction application to become a SEDS Pakistan member.
                </CardDescription>
                <div className="pt-4">
                  <Button
                    asChild
                    size="lg"
                    className="font-accent tracking-widest uppercase text-base"
                  >
                    <Link href="/join" aria-label="Start your SEDS Pakistan induction application">
                      Start Your Application
                    </Link>
                  </Button>
                  <p className="text-sm text-muted-foreground mt-3">
                    <IntakeCloseLine />
                  </p>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 mb-6">
                  <span className="h-px flex-1 bg-border" aria-hidden="true" />
                  <span className="text-xs uppercase tracking-widest text-muted-foreground">or create an account</span>
                  <span className="h-px flex-1 bg-border" aria-hidden="true" />
                </div>
                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="name-join">Full Name</Label>
                    <Input
                      id="name-join"
                      {...register('name')}
                      placeholder="e.g., Ada Lovelace"
                      aria-describedby={errors.name ? "name-error" : undefined}
                      aria-invalid={errors.name ? "true" : "false"}
                    />
                    {errors.name && (
                      <p
                        id="name-error"
                        className="text-sm text-destructive"
                        role="alert"
                      >
                        {errors.name.message}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="email-join">Email</Label>
                    <Input
                      id="email-join"
                      {...register('email')}
                      type="email"
                      placeholder="ada.lovelace@example.com"
                      aria-describedby={errors.email ? "email-error" : undefined}
                      aria-invalid={errors.email ? "true" : "false"}
                    />
                    {errors.email && (
                      <p
                        id="email-error"
                        className="text-sm text-destructive"
                        role="alert"
                      >
                        {errors.email.message}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="password-join">Password</Label>
                    <Input
                      id="password-join"
                      {...register('password')}
                      type="password"
                      placeholder="At least 6 characters"
                      aria-describedby={errors.password ? "password-error" : undefined}
                      aria-invalid={errors.password ? "true" : "false"}
                    />
                    {errors.password && (
                      <p
                        id="password-error"
                        className="text-sm text-destructive"
                        role="alert"
                      >
                        {errors.password.message}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label htmlFor="university-join">University</Label>
                      <Input
                        id="university-join"
                        {...register('university')}
                        placeholder="e.g., National Space University"
                        aria-describedby={errors.university ? "university-error" : undefined}
                        aria-invalid={errors.university ? "true" : "false"}
                      />
                      {errors.university && (
                        <p
                          id="university-error"
                          className="text-sm text-destructive"
                          role="alert"
                        >
                          {errors.university.message}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="fieldOfStudy-join">Field of Study</Label>
                      <Input
                        id="fieldOfStudy-join"
                        {...register('fieldOfStudy')}
                        placeholder="e.g., Aerospace Engineering"
                        aria-describedby={errors.fieldOfStudy ? "fieldOfStudy-error" : undefined}
                        aria-invalid={errors.fieldOfStudy ? "true" : "false"}
                      />
                      {errors.fieldOfStudy && (
                        <p
                          id="fieldOfStudy-error"
                          className="text-sm text-destructive"
                          role="alert"
                        >
                          {errors.fieldOfStudy.message}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={hasConsented}
                        onChange={(e) => setHasConsented(e.target.checked)}
                        className="mt-1 h-4 w-4"
                      />
                      <span>
                        I have read and agree to the <a href="/terms-and-conditions" target="_blank" className="underline">Terms and Conditions</a> and <a href="/privacy-policy" target="_blank" className="underline">Privacy Policy</a>.
                      </span>
                    </label>
                  </div>
                  <Button
                    type="submit"
                    size="lg"
                    disabled={isSubmitting || !hasConsented}
                    className="w-full font-accent tracking-widest uppercase text-base hover:text-glow transition-all pulse-glow"
                    aria-label="Create account and join SEDS mission"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
                        Creating Account...
                      </>
                    ) : (
                      <>
                        <UserPlus className="mr-2 h-5 w-5" aria-hidden="true" />
                        Join The Mission
                      </>
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
