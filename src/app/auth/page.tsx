"use client";

import { Suspense } from "react";
import GoogleOnlyAuthForm from "@/components/auth/google-only-auth-form";
import StarryBackground from "@/components/ui/starry-background";
import Image from "next/image";
import { Rocket } from "lucide-react";

// Simplified Google-only authentication page
// - Single, prominent "Continue with Google" button
// - No forms, no email/password, no complexity
// - Clean, focused user experience
export default function AuthPage() {
  return (
    <div className="relative min-h-screen w-full">
      {/* Global space-themed background */}
      <StarryBackground starCount={80} />
      <main className="relative z-10 grid grid-cols-1 lg:grid-cols-2 min-h-screen">
        {/* Left visual column */}
        <div
          className="relative hidden lg:flex items-center justify-center bg-gradient-to-br from-indigo-900 via-slate-900 to-black bg-cover bg-center"
          style={{
            backgroundImage:
              "url(https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1600&q=80)",
          }}
        >
          <div className="absolute inset-0 bg-background/80" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-700/30 via-transparent to-transparent" />
          <div className="relative px-10 py-12 text-center">
            <div className="mx-auto mb-6 flex items-center justify-center">
              <Image src="/assets/logo.webp" alt="SEDS Pakistan" width={96} height={96} className="h-24 w-24" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground">SEDS Pakistan</h1>
            <p className="mt-2 text-foreground/70">Students for the Exploration and Development of Space</p>
            <div className="mt-8 inline-flex items-center gap-3 rounded-xl border border-border bg-muted px-5 py-3">
              <Rocket className="h-5 w-5 text-indigo-300" />
              <span className="text-indigo-200">Join the mission. Explore the cosmos.</span>
            </div>
          </div>
        </div>

        {/* Right auth form column */}
        <div className="flex items-center justify-center p-6 md:p-10 bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-md">
            <Suspense fallback={<div className="text-center text-muted-foreground">Loading…</div>}>
              <GoogleOnlyAuthForm />
            </Suspense>
          </div>
        </div>
      </main>
    </div>
  );
}