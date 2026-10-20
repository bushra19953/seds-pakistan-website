import type { Metadata } from 'next';
import ApplicantPortal from '@/components/applicant-status/applicant-portal';
import StarryBackground from '@/components/ui/starry-background';

export const metadata: Metadata = {
  title: 'Track your application | SEDS Pakistan',
  description:
    'Track your SEDS Pakistan induction application: screening stage, documents, domain preferences, and onboarding checklist.',
};

export default function ApplyStatusPage() {
  return (
    <div className="relative min-h-screen py-10">
      <StarryBackground />
      <div className="container relative z-10 mx-auto px-4">
        <div className="mx-auto mb-8 max-w-3xl text-center">
          <h1 className="text-3xl font-bold tracking-wide text-foreground">Application Status</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Follow your induction application from submission to onboarding. Sign in to keep your
            documents, domain preferences, and onboarding checklist up to date.
          </p>
        </div>
        <ApplicantPortal />
      </div>
    </div>
  );
}
