"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@/firebase";
import { doc, getFirestore, serverTimestamp } from 'firebase/firestore';
;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Rocket, CheckCircle, AlertCircle } from "lucide-react";
import { useEnhancedToast } from "@/hooks/use-enhanced-toast";
import Image from "next/image";
import { updateDoc } from '@/lib/client/firestore-wrapper';


function WelcomePageContent() {
  const { user, isLoading: userLoading } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useEnhancedToast();
  // Preserve the post-auth intent redirect (e.g. /events/slug?action=checkout)
  const redirectAfter = searchParams.get('callbackUrl') || '/profile';
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    university: '',
    department: '',
  });

  // Redirect if not authenticated
  useEffect(() => {
    if (!userLoading && !user) {
      router.replace('/auth');
      return;
    }
  }, [user, userLoading, router]);

  // Redirect if user already has complete profile
  useEffect(() => {
    if (user) {
      const checkProfileCompleteness = async () => {
        try {
          const firestore = getFirestore();
          const userDocRef = doc(firestore, 'users', user.uid);
          const { getDoc } = await import('firebase/firestore');
          const docSnap = await getDoc(userDocRef);

          if (docSnap.exists()) {
            const userData = docSnap.data();
            if (userData.university && userData.department) {
              // Profile is complete, redirect to main app
              router.replace('/profile');
            }
          }
        } catch (error) {
          console.error('Error checking profile completeness:', error);
        }
      };

      checkProfileCompleteness();
    }
  }, [user, router]);

  const updateFormData = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.university.trim() || !formData.department.trim()) {
      showToast({
        title: "Validation Error",
        description: "Please fill in both university and department fields.",
        variant: "destructive",
      });
      return;
    }

    if (!user) {
      showToast({
        title: "Error",
        description: "You must be logged in to complete your profile.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const firestore = getFirestore();
      const userDocRef = doc(firestore, 'users', user.uid);

      await updateDoc(userDocRef, {
        university: formData.university.trim(),
        department: formData.department.trim(),
        updatedAt: serverTimestamp(),
        profileCompletedAt: serverTimestamp(),
      });

      showToast({
        title: "Profile Completed!",
        description: "Welcome to SEDS Pakistan! Your profile has been updated.",
      });

      // Redirect to intended destination (or /profile as fallback)
      router.push(redirectAfter);
    } catch (error: any) {
      console.error('Error updating profile:', error);
      showToast({
        title: "Error",
        description: "Failed to update your profile. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (userLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null; // Will redirect
  }

  return (
    <div className="relative min-h-screen w-full">
      {/* Global space-themed background */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-900 via-slate-900 to-black" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-700/30 via-transparent to-transparent" />

      <main className="relative z-10 flex items-center justify-center min-h-screen p-6">
        <Card className="w-full max-w-md mx-auto bg-card/80 backdrop-blur-sm border-primary/20">
          <div className="flex justify-center mb-4">
            <Image
              src="/assets/logo.png"
              alt="SEDS Pakistan Logo"
              width={64}
              height={64}
              className="h-16 w-16"
            />
          </div>

          <CardHeader className="text-center">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Rocket className="h-6 w-6 text-primary" />
              <CardTitle className="text-3xl font-bold">Welcome, {user.displayName?.split(' ')[0] || 'Explorer'}!</CardTitle>
            </div>
            <CardDescription className="text-md text-muted-foreground">
              Let&apos;s complete your profile to get you started with SEDS Pakistan
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* User Info Display */}
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-green-800">
                    <p className="font-medium mb-1">Account Created Successfully</p>
                    <p>Email: {user.email}</p>
                    <p>Google profile linked</p>
                  </div>
                </div>
              </div>

              {/* Profile Completion Form */}
              <div className="space-y-4">
                <div>
                  <Label htmlFor="university" className="text-sm font-medium">
                    University *
                  </Label>
                  <Input
                    id="university"
                    placeholder="e.g., National University of Sciences and Technology"
                    value={formData.university}
                    onChange={(e) => updateFormData('university', e.target.value)}
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="department" className="text-sm font-medium">
                    Field of Study / Department *
                  </Label>
                  <Input
                    id="department"
                    placeholder="e.g., Aerospace Engineering, Computer Science"
                    value={formData.department}
                    onChange={(e) => updateFormData('department', e.target.value)}
                    className="mt-1"
                    required
                  />
                </div>
              </div>

              {/* Information Notice */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-blue-800">
                    <p className="font-medium mb-1">Why do we need this?</p>
                    <p>This information helps us connect you with other students in your field and university for networking and collaboration opportunities.</p>
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <Button
                type="submit"
                className="w-full h-12 text-lg font-semibold"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Completing Profile...
                  </>
                ) : (
                  <>
                    <CheckCircle className="mr-2 h-5 w-5" />
                    Complete Profile & Continue
                  </>
                )}
              </Button>

              {/* Skip Option */}
              <div className="text-center">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.push(redirectAfter)}
                  className="text-sm text-muted-foreground hover:text-foreground"
                  disabled={isSubmitting}
                >
                  Skip for now (you can update this later)
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" /></div>}>
      <WelcomePageContent />
    </Suspense>
  );
}