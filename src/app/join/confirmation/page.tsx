import Link from 'next/link';

// Confirmation page shown after a successful /join submission.
// Displays the applicant's unique tracking token. Kept distraction-free
// like the squeeze page itself.
export default function JoinConfirmationPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams?.token ?? '';

  return (
    <main className="min-h-screen bg-[#020617] text-slate-100 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 shadow-2xl overflow-hidden">
          <div className="px-8 pt-10 pb-6 text-center border-b border-slate-800 bg-[radial-gradient(circle_at_top,#1e1b4b_0%,transparent_70%)]">
            <p className="text-xs font-bold tracking-[0.3em] text-emerald-400 uppercase mb-3">
              SEDS Pakistan
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold leading-tight">
              Transmission Received
            </h1>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              Your starter pack is on its way to your inbox. Save your tracking
              token below: you will need it for all future correspondence.
            </p>
          </div>

          <div className="px-8 py-8 text-center">
            {token ? (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-6 py-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-emerald-300 mb-2">
                  Your Tracking Token
                </p>
                <p className="text-xl sm:text-2xl font-bold tracking-wider text-emerald-400 break-all">
                  {token}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No tracking token found. Please complete the intake form first.
              </p>
            )}

            <div className="mt-8 space-y-3 text-sm text-muted-foreground text-left">
              <p>
                <span className="font-semibold text-slate-200">Step 1:</span> Check
                your university email for the welcome message with your download links.
              </p>
              <p>
                <span className="font-semibold text-slate-200">Step 2:</span> Download
                the Webots Mars Rover Navigation Starter Codebase and the syllabus PDF.
              </p>
              <p>
                <span className="font-semibold text-slate-200">Step 3:</span> Expect
                a crucible briefing from your chapter team within 48 hours.
              </p>
            </div>

            <Link
              href="/"
              className="mt-8 inline-block rounded-lg border border-slate-700 px-6 py-3 text-xs font-bold uppercase tracking-widest text-slate-300 hover:border-emerald-500 hover:text-emerald-400 transition"
            >
              Return Home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
