/**
 * /site-paused (Workstream H, spec 4.5). The static page the
 * middleware rewrites public routes to while the site is not live.
 *
 * Server component, no client JS, and it never reads Firestore: the
 * mode and public notice arrive as query params set by the middleware
 * rewrite (mode=maintenance|disabled|revoked, notice=<url-encoded>),
 * so the kill surface cannot depend on the database that might be the
 * problem. Renders even when Firestore is down.
 *
 * Deliberately no navigation, no links, no sign-in CTA: the sign-in
 * route stays reachable directly, but this page is a dead end by
 * design.
 */

export const dynamic = 'force-static';

interface PageProps {
  searchParams: Promise<{ mode?: string; notice?: string }>;
}

export default async function SitePausedPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const mode = params.mode ?? 'maintenance';
  const notice = params.notice ?? '';

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-xl space-y-4 text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          SEDS Pakistan
        </p>
        {mode === 'revoked' ? (
          <>
            <h1 className="text-3xl font-bold">This site is unavailable</h1>
            {notice ? (
              <p className="text-base text-muted-foreground">{notice}</p>
            ) : null}
          </>
        ) : mode === 'disabled' ? (
          <>
            <h1 className="text-3xl font-bold">This site is currently unavailable</h1>
            <p className="text-base text-muted-foreground">
              Please check back later.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-bold">We will be right back</h1>
            <p className="text-base text-muted-foreground">
              The SEDS Pakistan site is briefly down for maintenance. Please
              check back shortly.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
