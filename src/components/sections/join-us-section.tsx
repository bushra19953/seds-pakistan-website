"use client";

import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, UserPlus, PartyPopper } from "lucide-react";
import { useRouter } from "next/navigation";
import * as z from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { getAuth, createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { doc, getFirestore, serverTimestamp, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
;
import { errorEmitter } from "@/firebase/error-emitter";
import { FirestorePermissionError } from "@/firebase/errors";
import { setDoc } from '@/lib/client/firestore-wrapper';

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
      const userCredential = await createUserWithEmailAndPassword(auth, data.email, data.password);
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
        email: user.email,
        displayName: data.name,
        photoURL: user.photoURL,
        university: data.university,
        fieldOfStudy: data.fieldOfStudy,
        role: 'member', // default role: every new signup is a member unless an invite assigns otherwise
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

      setSuccess(true);
      toast({
        title: "Success!",
        description: "Welcome to SEDS! Your account has been created.",
      });

      setTimeout(() => router.push('/profile'), 3000);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Something went wrong",
        description: error.message || "An unexpected error occurred.",
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
          {success ? (
            <Card
              className="border-primary/20 shadow-xl shadow-primary/5 text-center p-8"
              aria-live="polite"
            >
              <PartyPopper className="h-16 w-16 mx-auto text-primary text-glow mb-4" aria-hidden="true" />
              <CardTitle className="text-3xl text-glow">Welcome, Pioneer!</CardTitle>
              <CardDescription className="font-body text-lg text-muted-foreground mt-2">
                Your account has been created. You will be redirected to your profile shortly.
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
                  className="text-4xl md:text-5xl text-glow"
                >
                  Join The Mission
                </CardTitle>
                <CardDescription className="font-body text-lg text-muted-foreground">
                  Become a part of Pakistan&apos;s future in space exploration. Create an account to get started.
                </CardDescription>
              </CardHeader>
              <CardContent>
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
